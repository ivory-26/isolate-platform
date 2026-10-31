import { strict as assert } from "node:assert";
import {
	createDb,
	PostgresAuditRepository,
	type AuditRepository,
} from "../packages/db/src/index";
import {
	commentOnPullRequest,
	rerunWorkflowRun,
	type GitHubScopedWriteAuditSink,
} from "../packages/integrations/src/index";
import { asOrganizationId } from "../packages/shared/src/index";
import { selectGitHubTokenProvider } from "../apps/worker/src/runtime-composition";

/**
 * Wave 14 — bounded live proof for the scoped GitHub writes (docs §3.1.5).
 *
 * Exactly ONE write per invocation, chosen by `LIVE_WRITE_MODE`:
 *   - `comment` → one pull-request comment (`issues:write`)
 *   - `rerun`   → one workflow run rerun (`actions:write`)
 *
 * The token broker, input bounds, redaction and audit vocabulary are the real
 * product paths (`commentOnPullRequest` / `rerunWorkflowRun`). There is no retry
 * loop: a failure is reported and the process exits non-zero.
 *
 * Required env (names only):
 *   LIVE_GITHUB_WRITE=1, LIVE_WRITE_MODE, LIVE_REPOSITORY_FULL_NAME,
 *   LIVE_ORGANIZATION_ID, DATABASE_URL, GITHUB_APP_ID,
 *   GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH (or inline key)
 *   plus LIVE_PR_NUMBER (comment) or LIVE_RUN_ID (rerun).
 */

if (process.env.LIVE_GITHUB_WRITE !== "1") {
	console.log(
		"Set LIVE_GITHUB_WRITE=1 to run the bounded GitHub scoped-write acceptance.",
	);
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

function positiveInteger(name: string): number {
	const raw = required(name);
	if (!/^\d+$/.test(raw)) {
		console.error(`${name} must be a positive integer`);
		process.exit(1);
	}
	const value = Number(raw);
	assert.ok(Number.isSafeInteger(value) && value > 0);
	return value;
}

const mode = required("LIVE_WRITE_MODE");
if (mode !== "comment" && mode !== "rerun") {
	console.error("LIVE_WRITE_MODE must be comment or rerun");
	process.exit(1);
}

const repositoryFullName = required("LIVE_REPOSITORY_FULL_NAME");
const organizationId = asOrganizationId(required("LIVE_ORGANIZATION_ID"));
const actorId = process.env.LIVE_ACTOR_ID?.trim() || null;
const databaseUrl = required("DATABASE_URL");
const apiBaseUrl =
	process.env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com";

const DEFAULT_COMMENT_BODY = [
	"Wave 14 acceptance: `github.comment` scoped write is live.",
	"",
	"isolate-platform minted a repository-scoped GitHub App installation token,",
	"posted exactly one bounded comment through the audited `scoped_write` path,",
	"and recorded the `tool.execute` audit entry. No other GitHub write was made.",
].join("\n");

type DrainedAudit = GitHubScopedWriteAuditSink & {
	drained: () => Promise<void>;
	lastRow: () => { id: string; target: string; details: unknown } | null;
};

/**
 * Wraps the real sink so the script can wait for the fire-and-forget audit
 * append (the writer's `quietAudit` intentionally never blocks the call).
 */
function createDrainedAuditSink(inner: AuditRepository): DrainedAudit {
	let pending = 0;
	const waiters: Array<() => void> = [];
	let lastRow: { id: string; target: string; details: unknown } | null = null;
	const rejections: unknown[] = [];

	const append: GitHubScopedWriteAuditSink["append"] = (input) => {
		pending += 1;
		return Promise.resolve(inner.append(input))
			.then((row) => {
				lastRow = { id: row.id, target: row.target, details: row.details };
				return row;
			})
			.catch((error: unknown) => {
				rejections.push(error);
			})
			.finally(() => {
				pending -= 1;
				if (pending === 0) {
					for (const notify of waiters.splice(0)) notify();
				}
			});
	};

	return {
		append,
		drained: async () => {
			if (pending > 0) {
				await new Promise<void>((resolve) => {
					waiters.push(resolve);
				});
			}
			if (rejections.length > 0) {
				throw new Error("audit append failed");
			}
		},
		lastRow: () => lastRow,
	};
}

async function readRun(
	runId: number,
): Promise<{ status: string; conclusion: string | null; attempt: number }> {
	const tokenProvider = selectGitHubTokenProvider(process.env);
	if (tokenProvider === null) {
		console.error("GitHub App credentials are not configured");
		process.exit(1);
	}
	const installation = await tokenProvider.getInstallationToken({
		repositoryFullName,
		contents: "read",
		actions: "read",
	});
	const [owner, repo] = repositoryFullName.split("/");
	const response = await fetch(
		`${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${installation.token}`,
				"User-Agent": "isolate-platform",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok) {
		console.error(`workflow run read failed with status ${response.status}`);
		process.exit(1);
	}
	const body = (await response.json()) as Record<string, unknown>;
	const status = typeof body.status === "string" ? body.status : "unknown";
	const conclusion =
		typeof body.conclusion === "string" ? body.conclusion : null;
	const attempt =
		typeof body.run_attempt === "number" ? body.run_attempt : 0;
	console.log(
		`target run ${runId}: status=${status} conclusion=${conclusion ?? "null"} attempt=${attempt}`,
	);
	return { status, conclusion, attempt };
}

async function main(): Promise<void> {
	const sql = createDb(databaseUrl);
	const audit = createDrainedAuditSink(new PostgresAuditRepository(sql));
	const tokenProvider = selectGitHubTokenProvider(process.env);
	if (tokenProvider === null) {
		throw new Error("GitHub App credentials are not configured");
	}
	const actor = { organizationId, actorId, actorKind: "system" as const };

	if (mode === "rerun") {
		const runId = positiveInteger("LIVE_RUN_ID");
		const preflight = await readRun(runId);
		if (preflight.status !== "completed") {
			throw new Error(
				"target run is not completed; refusing to call rerun (no write made)",
			);
		}
		const result = await rerunWorkflowRun(
			{
				tokenProvider,
				audit,
				actor,
				deliveryId: `live-rerun-${runId}`,
			},
			{ repositoryFullName, runId },
		);
		await audit.drained();
		if (!result.ok) {
			console.error(`rerun failed: ${result.code} ${result.message ?? ""}`);
			process.exit(1);
		}
		console.log(`rerun accepted: run=${result.runId}`);
	} else {
		const number = positiveInteger("LIVE_PR_NUMBER");
		const body = process.env.LIVE_COMMENT_BODY?.trim() || DEFAULT_COMMENT_BODY;
		const result = await commentOnPullRequest(
			{
				tokenProvider,
				audit,
				actor,
				deliveryId: `live-comment-${number}`,
			},
			{ repositoryFullName, number, body },
		);
		await audit.drained();
		if (!result.ok) {
			console.error(`comment failed: ${result.code} ${result.message ?? ""}`);
			process.exit(1);
		}
		console.log(`comment created: id=${result.comment.id} url=${result.comment.url}`);
	}

	const row = audit.lastRow();
	console.log(
		row === null
			? "audit row: not captured"
			: `audit row: id=${row.id} target=${row.target} details=${JSON.stringify(row.details)}`,
	);
	await sql.end({ timeout: 5 });
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : "unknown error";
	console.error(`live GitHub write acceptance failed: ${message}`);
	process.exit(1);
}
