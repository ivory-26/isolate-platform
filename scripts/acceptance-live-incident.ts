import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import {
	PostgresArtifactRepository,
	PostgresTaskAttemptRepository,
	PostgresTaskRepository,
	createDb,
	type JobRow,
} from "../packages/db/src/index";
import {
	asJobId,
	asOrganizationId,
	asTaskId,
	createConsoleLogger,
	type UserId,
} from "../packages/shared/src/index";
import { loadWorkerConfig } from "../apps/worker/src/config";
import { createOfflineWorkerDeps } from "../apps/worker/src/composition";
import { createConfiguredWorkerComposition } from "../apps/worker/src/runtime-composition";
import { getIncidentIntake } from "../apps/web/src/server/incident-intake-runtime.server";

/**
 * Wave 13 live incident proof (ONE bounded sandbox, real Meta turns).
 *
 * A signed GitHub `workflow_run` failure delivery goes through the real intake
 * service (signature, trigger policy, dedupe, cap, submission), creating a
 * task with incident metadata. The real worker composition then runs that task
 * with push disabled, so it stops at `review_ready` without touching GitHub.
 */

if (process.env.LIVE_INCIDENT !== "1") {
	console.log("Set LIVE_INCIDENT=1 to run the bounded incident acceptance.");
	process.exit(0);
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is required for this acceptance run`);
		process.exit(1);
	}
	return value;
}

const organizationId = asOrganizationId(required("LIVE_ORGANIZATION_ID"));
const userId = required("LIVE_USER_ID") as UserId;
const repositoryId = required("LIVE_REPOSITORY_ID");
const workflowDefinitionId = required("LIVE_WORKFLOW_DEFINITION_ID");
const workflowVersion = Number(required("LIVE_WORKFLOW_VERSION"));
const databaseUrl = required("DATABASE_URL");
const githubSecret = required("WEBHOOK_GITHUB_SECRET");
const maxTokensPerTask = Number(required("WORKER_MAX_TOKENS_PER_TASK"));
const maxSandboxSeconds = Number(required("WORKER_MAX_SANDBOX_SECONDS"));
assert.ok(maxTokensPerTask > 0 && maxTokensPerTask <= 32_768);
assert.ok(maxSandboxSeconds > 0 && maxSandboxSeconds <= 600);
assert.equal(process.env.INFERENCE_PROVIDER?.trim(), "meta");
assert.equal(process.env.SANDBOX_PROVIDER?.trim(), "modal");

const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const branch = `task/incident-${suffix}`;
const logger = createConsoleLogger("live-incident");

const payload = {
	action: "completed",
	repository: {
		name: "agent-bank",
		full_name: "ivory-26/agent-bank",
		default_branch: "main",
		html_url: "https://github.com/ivory-26/agent-bank",
		owner: { login: "ivory-26" },
	},
	workflow_run: {
		id: 9001,
		name: `ci-${suffix}`,
		head_branch: "main",
		head_sha: "a".repeat(40),
		run_number: 1,
		status: "completed",
		conclusion: "failure",
		html_url: `https://github.com/ivory-26/agent-bank/actions/runs/${suffix}`,
	},
};
const rawBody = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", githubSecret)
	.update(rawBody)
	.digest("hex")}`;

// The runtime binds the verified route mapping from server-only env.
process.env.WEBHOOK_GITHUB_SECRET = githubSecret;
process.env.WEBHOOK_ORGANIZATION_ID = organizationId;
process.env.WEBHOOK_ACTOR_ID = userId;
process.env.WEBHOOK_ACTOR_ROLE = "owner";
process.env.WEBHOOK_REPOSITORY_ID = repositoryId;
process.env.WEBHOOK_BRANCH = branch;
process.env.WEBHOOK_WORKFLOW_DEFINITION_ID = workflowDefinitionId;
process.env.WEBHOOK_WORKFLOW_VERSION = String(workflowVersion);

const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const attempts = new PostgresTaskAttemptRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);

function syntheticJob(taskId: ReturnType<typeof asTaskId>): JobRow {
	return {
		id: asJobId(crypto.randomUUID()),
		organizationId,
		taskId,
		type: "run_task",
		payload: { taskId },
		status: "claimed",
		attempts: 1,
		maxAttempts: 1,
		lease: {
			ownerId: "live-incident-acceptance",
			leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		notBefore: new Date().toISOString(),
		enqueueUuidKey: `run_task:${taskId}`,
		lastError: null,
		createdAt: new Date().toISOString(),
	};
}

try {
	const intake = getIncidentIntake(process.env);
	const accepted = await intake.acceptIncident({
		rawBody,
		headers: {
			"x-github-event": "workflow_run",
			"x-github-delivery": crypto.randomUUID(),
			"x-hub-signature-256": signature,
		},
	});
	assert.equal(accepted.ok, true, "delivery was not accepted");
	if (!accepted.ok || !("taskId" in accepted)) {
		throw new Error("delivery created no task");
	}
	console.log(`incident task: ${accepted.taskId} (deduped=${accepted.deduped})`);

	const taskId = asTaskId(accepted.taskId);
	const row = await tasks.get(taskId);
	assert.ok(row, "task row missing");
	assert.equal(row.incident_source, "github");
	assert.ok(
		typeof row.incident_fingerprint === "string" &&
			row.incident_fingerprint.includes("agent-bank"),
		"incident fingerprint missing",
	);
	assert.equal(row.organization_id, organizationId);
	assert.equal(row.repository_id, repositoryId);

	const config = loadWorkerConfig(
		process.env as Record<string, string | undefined>,
	);
	const composed = await createConfiguredWorkerComposition(config, logger);
	assert.equal(composed.inferenceProvider, "meta");
	assert.equal(composed.providerName, "modal");
	assert.equal(
		typeof composed.overrides.loadContextBundle,
		"function",
		"incident context loader is not bound",
	);

	const lifetimeMs = Math.min(maxSandboxSeconds * 1000, 240_000);
	const composition = createOfflineWorkerDeps(config, logger, {
		...composed.overrides,
		pushEnabled: false,
		caps: {
			maxOutputTokensPerTurn: Math.min(config.maxOutputTokensPerTurn, 4096),
			maxTaskTokens: maxTokensPerTask,
			maxSteps: Math.min(config.maxAgentSteps, 4),
		},
		sandbox: {
			cpuCount: 0.125,
			memoryMb: 512,
			lifetimeMs,
			idleTimeoutMs: Math.min(60_000, lifetimeMs),
		},
		maxSandboxSeconds,
		maxCostUsdPerTask: Number(
			process.env.WORKER_MAX_COST_USD_PER_TASK?.trim() || "1",
		),
	});
	const handler = composition.handlers.find((entry) => entry.jobType === "run_task");
	assert.ok(handler, "run_task handler is not registered");

	const verdict = await handler.handle(syntheticJob(taskId), {
		logger,
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});
	console.log(`run_task: ${verdict.outcome}${verdict.note ? ` (${verdict.note})` : ""}`);
	assert.equal(verdict.outcome, "complete");

	const finalTask = await tasks.get(taskId);
	assert.equal(finalTask?.status, "review_ready", "incident task did not reach review_ready");
	assert.equal(finalTask?.incident_source, "github");

	const usage = (await sql.unsafe(
		`SELECT provider, model_id, prompt_tokens, completion_tokens, cost_usd
		 FROM usage_records WHERE task_id = $1 ORDER BY created_at`,
		[taskId],
	)) as Array<Record<string, unknown>>;
	assert.ok(usage.some((entry) => entry.provider === "meta"));
	assert.ok(usage.some((entry) => entry.provider === "modal"));

	console.log(
		JSON.stringify(
			{
				taskId,
				branch: finalTask.branch,
				status: finalTask.status,
				incidentSource: finalTask.incident_source,
				incidentFingerprint: finalTask.incident_fingerprint,
				attempts: (await attempts.listByTask(taskId)).length,
				artifacts: (
					await artifacts.listByTask({ organizationId, taskId })
				).map((entry) => entry.kind),
				usage,
			},
			null,
			2,
		),
	);
	console.log("LIVE INCIDENT ACCEPTANCE PASSED (signed GitHub failure → task → review_ready)");
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE INCIDENT ACCEPTANCE FAILED: ${code}: ${message}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
