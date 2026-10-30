/**
 * Bounded live acceptance (Phase D/E of the provider plan).
 *
 * Credentials policy: this script runs ONLY when the operator explicitly opts
 * in with BASETEN_LIVE=1 and/or MODAL_LIVE=1. It never runs in CI and never
 * retries. Each provider gets exactly ONE call/sandbox:
 *   Baseten: GET /v1/models (no tokens), then one completion, max_tokens <= 16,
 *            no tools, prompt "Reply with OK".
 *   Modal:   one sandbox (0.125 CPU / 512 MiB / 60 s), echo, terminate.
 *
 * Measured usage is written to `usage_records` under a temporary organization,
 * read back, printed, and cleaned up. Cost stays null unless a trusted price is
 * configured; the script never invents a price.
 */
import { createDb, PostgresUsageRepository } from "../packages/db/src/index";
import type { AgentUsage, TaskContext } from "../packages/mastra/src/index";
import {
	type CommandPolicy,
	createModalSandboxClient,
	executeCommand,
	ModalSandboxProvider,
	type SandboxHandle,
} from "../packages/sandbox/src/index";
import { createMetaRuntimeFactory } from "../apps/worker/src/runtime-factory";

const BASETEN_MODEL = "meta-models/muse-spark-open-1026";
const BASETEN_BASE = "https://inference.baseten.co/v1";
const ACCEPTANCE_MAX_OUTPUT_TOKENS = 16;
const ACCEPTANCE_SANDBOX_TIMEOUT_MS = 60_000;
const BASETEN_TIMEOUT_MS = 30_000;

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is required for this acceptance run`);
		process.exit(1);
	}
	return value;
}

function boundedOutputTokens(): number {
	const requested = Number(process.env.BASETEN_MAX_OUTPUT_TOKENS ?? 16);
	if (!Number.isInteger(requested) || requested < 1) {
		console.error("BASETEN_MAX_OUTPUT_TOKENS must be a positive integer");
		process.exit(1);
	}
	return Math.min(requested, ACCEPTANCE_MAX_OUTPUT_TOKENS);
}

function providerBaseUrl(): string {
	const raw = process.env.BASETEN_BASE_URL?.trim() || BASETEN_BASE;
	const parsed = new URL(raw);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		console.error("BASETEN_BASE_URL must be a plain https URL");
		process.exit(1);
	}
	return parsed.toString().replace(/\/$/, "");
}

type MeasuredUsage = {
	provider: string;
	modelId: string;
	promptTokens: number | null;
	completionTokens: number | null;
	costUsd: number | null;
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const body = (await response.json().catch(() => null)) as unknown;
	if (typeof body !== "object" || body === null) return {};
	return body as Record<string, unknown>;
}

async function runBaseten(): Promise<MeasuredUsage[]> {
	const apiKey = requireEnv("BASETEN_API_KEY");
	const base = providerBaseUrl();
	const modelId = process.env.BASETEN_MODEL_ID?.trim() || BASETEN_MODEL;
	const headers = { Authorization: `Bearer ${apiKey}` };

	// Phase D: confirm the model id without spending completion tokens.
	const models = await fetch(`${base}/models`, {
		headers,
		signal: AbortSignal.timeout(BASETEN_TIMEOUT_MS),
	});
	if (!models.ok) {
		console.error(`Baseten /v1/models failed: HTTP ${models.status}`);
		process.exit(1);
	}
	const modelBody = await readJson(models);
	const ids = Array.isArray(modelBody.data)
		? modelBody.data
				.map((entry) =>
					typeof entry === "object" && entry !== null
						? (entry as Record<string, unknown>).id
						: undefined,
				)
				.filter((id): id is string => typeof id === "string")
		: [];
	console.log(
		`Baseten models: ${ids.length} listed; target ${modelId} ${ids.includes(modelId) ? "present" : "NOT LISTED"}`,
	);

	// Phase E: exactly one completion, tiny output, no tools.
	const completion = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "Reply with OK" }],
			max_tokens: boundedOutputTokens(),
			stream: false,
		}),
		signal: AbortSignal.timeout(BASETEN_TIMEOUT_MS),
	});
	if (!completion.ok) {
		console.error(`Baseten completion failed: HTTP ${completion.status}`);
		process.exit(1);
	}
	const body = await readJson(completion);
	const usage =
		typeof body.usage === "object" && body.usage !== null
			? (body.usage as Record<string, unknown>)
			: {};
	const promptTokens =
		typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
	const completionTokens =
		typeof usage.completion_tokens === "number"
			? usage.completion_tokens
			: null;
	const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
	const message =
		typeof choice === "object" && choice !== null
			? (choice as Record<string, unknown>).message
			: undefined;
	const content =
		typeof message === "object" && message !== null
			? (message as Record<string, unknown>).content
			: undefined;
	console.log(
		`Baseten completion: HTTP ${completion.status}; output ${typeof content === "string" ? content.length : "?"} chars; prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"} tokens`,
	);
	return [
		{
			provider: "baseten",
			modelId,
			promptTokens,
			completionTokens,
			costUsd: null,
		},
	];
}

function modalPolicy(): CommandPolicy {
	return {
		workspaceRoot: "/tmp",
		allowlist: [
			{ executable: "echo", args: [{ kind: "literal", value: "isolate-ok" }] },
		],
		maxTimeoutMs: 15_000,
		maxOutputBytes: 1024,
		egress: { mode: "deny" },
	};
}

async function runModal(): Promise<MeasuredUsage[]> {
	const tokenId = requireEnv("MODAL_TOKEN_ID");
	const tokenSecret = requireEnv("MODAL_TOKEN_SECRET");
	const client = await createModalSandboxClient({
		tokenId,
		tokenSecret,
		appName: process.env.MODAL_APP_NAME?.trim() || "isolate-platform",
	});
	const provider = new ModalSandboxProvider({ client });
	const policy = modalPolicy();
	let handle: SandboxHandle | undefined;
	try {
		handle = await provider.create({
			workspaceRoot: "/tmp",
			lifetimeMs: ACCEPTANCE_SANDBOX_TIMEOUT_MS,
			memoryMb: 512,
			cpuCount: 0.125,
			egress: { mode: "deny" },
			idleTimeoutMs: 30_000,
		});
		const result = await executeCommand(provider, handle, policy, {
			executable: "echo",
			args: ["isolate-ok"],
			cwd: "/tmp",
			timeoutMs: 15_000,
			maxOutputBytes: 1024,
			egress: { mode: "deny" },
		});
		console.log(
			`Modal echo: exit=${result.exitCode}; stdout=${result.stdout.trim().slice(0, 32)}`,
		);
	} finally {
		if (handle) {
			await provider.destroy(handle);
			console.log("Modal sandbox destroyed");
		}
	}
	return [
		{
			provider: "modal",
			modelId: "sandbox:0.125x512",
			promptTokens: null,
			completionTokens: null,
			costUsd: null,
		},
	];
}

async function recordAndReport(rows: MeasuredUsage[]): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		console.log("DATABASE_URL absent: measured usage printed but not persisted");
		for (const row of rows) console.log(JSON.stringify(row));
		return;
	}
	const sql = createDb(databaseUrl);
	const slug = `live-acceptance-${crypto.randomUUID().slice(0, 8)}`;
	let organizationId: string | null = null;
	try {
		const orgRows = (await sql.unsafe(
			"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
			["Live acceptance", slug],
		)) as Array<Record<string, unknown>>;
		organizationId = orgRows[0]?.id as string;
		const usage = new PostgresUsageRepository(sql);
		for (const row of rows) {
			await usage.record({
				organizationId: organizationId as never,
				taskId: null,
				provider: row.provider,
				modelId: row.modelId,
				promptTokens: row.promptTokens,
				completionTokens: row.completionTokens,
				costUsd: row.costUsd,
			});
		}
		const persisted = (await sql.unsafe(
			`SELECT provider, model_id, prompt_tokens, completion_tokens, cost_usd
			 FROM usage_records WHERE organization_id = $1::uuid
			 ORDER BY created_at ASC`,
			[organizationId],
		)) as Array<Record<string, unknown>>;
		console.log(`usage_records (${persisted.length} rows):`);
		for (const row of persisted) console.log(JSON.stringify(row));
	} finally {
		if (organizationId) {
			await sql.unsafe(
				"DELETE FROM usage_records WHERE organization_id = $1::uuid",
				[organizationId],
			);
			await sql.unsafe("DELETE FROM organizations WHERE id = $1::uuid", [
				organizationId,
			]);
		}
		await sql.end({ timeout: 5 });
	}
}

const liveBaseten = process.env.BASETEN_LIVE === "1";
const liveModal = process.env.MODAL_LIVE === "1";
const liveMeta = process.env.META_LIVE === "1";
if (!liveBaseten && !liveModal && !liveMeta) {
	console.log(
		"No live provider opted in. Set META_LIVE=1, BASETEN_LIVE=1 and/or MODAL_LIVE=1 to run the bounded acceptance.",
	);
	process.exit(0);
}

/**
 * Bounded agentic plan test on Meta Model API (Muse Spark 1.3 Contributor).
 * One tool-less agent turn, 1024 output tokens max (reasoning + answer), 1 step.
 * No sandbox.
 */
async function runMeta(): Promise<MeasuredUsage[]> {
	const caps = {
		maxOutputTokensPerTurn: 1024,
		maxTaskTokens: 2048,
		maxSteps: 1,
	};
	let usage: AgentUsage | null = null;
	const factory = createMetaRuntimeFactory(process.env);
	const runtime = factory({
		caps,
		onUsage: (reported: AgentUsage) => {
			usage = reported;
		},
	});
	const context: TaskContext = {
		taskId: "00000000-0000-4000-8000-000000000001",
		organizationId: "00000000-0000-4000-8000-000000000002",
		goal: "Plan one step for adding a health endpoint.",
		repoUrl: "https://github.com/example/repo.git",
		baseBranch: "main",
		isolatedBranch: "task/plan-check",
		fileOwnership: [],
		acceptanceCriteria: [],
		limits: {
			max_agent_turns: 1,
			max_repair_attempts: 0,
			max_duration_ms: 60_000,
		},
	};
	const startedAt = Date.now();
	const text = await runtime.runTurn({
		prompt:
			"Planning only. Reply in one short sentence naming the first step to add a health-check endpoint to a web app.",
		context,
		signal: AbortSignal.timeout(60_000),
	});
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	console.log(
		`Meta agent turn: ${seconds}s; output ${text.length} chars; ${text.slice(0, 200)}`,
	);
	const reported: AgentUsage | null = usage;
	return [
		{
			provider: reported?.providerId ?? "meta",
			modelId: reported?.modelId ?? "muse-spark-1.3-contributor",
			promptTokens: reported?.promptTokens ?? null,
			completionTokens: reported?.completionTokens ?? null,
			costUsd: null,
		},
	];
}

// Sequential only: the credit policy forbids parallel live calls.
const measured: MeasuredUsage[] = [];
if (liveMeta) measured.push(...(await runMeta()));
if (liveBaseten) measured.push(...(await runBaseten()));
if (liveModal) measured.push(...(await runModal()));
await recordAndReport(measured);
console.log("LIVE ACCEPTANCE COMPLETE");
