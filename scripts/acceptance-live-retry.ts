import { strict as assert } from "node:assert";
import {
	PostgresApprovalRepository,
	PostgresArtifactRepository,
	PostgresTaskAttemptRepository,
	PostgresTaskRepository,
	PostgresQueueRepository,
	PostgresExecutionLifecycle,
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
import {
	createOfflineWorkerDeps,
	type WorkerComposition,
} from "../apps/worker/src/composition";
import { createConfiguredWorkerComposition } from "../apps/worker/src/runtime-composition";
import {
	retryTaskWithDependencies,
	type StoreActionDependencies,
} from "../apps/web/src/server/repository-store.server";
import type { CallerScope } from "../apps/web/src/server/task-service.server";

/**
 * Wave 12 live retry proof (ONE bounded sandbox, real Meta turns).
 *
 * Takes a `failed` task and calls the real `retryTask` service path: the rerun
 * is a NEW task in the same boundary (repository, goal, ownership, budget),
 * linked with `retry_of`, with exactly one `run_task` job. The worker then runs
 * it with push disabled, so it stops at `review_ready` without touching GitHub.
 */

if (process.env.LIVE_RETRY !== "1") {
	console.log("Set LIVE_RETRY=1 to run the bounded retry acceptance.");
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
const sourceTaskId = asTaskId(required("LIVE_FAILED_TASK_ID"));
const databaseUrl = required("DATABASE_URL");
const maxTokensPerTask = Number(required("WORKER_MAX_TOKENS_PER_TASK"));
const maxSandboxSeconds = Number(required("WORKER_MAX_SANDBOX_SECONDS"));
assert.ok(maxTokensPerTask > 0 && maxTokensPerTask <= 200_000_000);
assert.ok(maxSandboxSeconds > 0 && maxSandboxSeconds <= 600);
assert.equal(process.env.INFERENCE_PROVIDER?.trim(), "meta");
assert.equal(process.env.SANDBOX_PROVIDER?.trim(), "modal");

const logger = createConsoleLogger("live-retry");
const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const queue = new PostgresQueueRepository(sql);
const approvals = new PostgresApprovalRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);
const attempts = new PostgresTaskAttemptRepository(sql);

const scope: CallerScope = { organizationId, userId, role: "owner" };
const deps: StoreActionDependencies = {
	tasks,
	queue,
	approvals,
	lifecycle: new PostgresExecutionLifecycle(sql),
};

function syntheticJob(
	taskId: ReturnType<typeof asTaskId>,
	payload: Record<string, unknown>,
): JobRow {
	return {
		id: asJobId(crypto.randomUUID()),
		organizationId,
		taskId,
		type: "run_task",
		payload,
		status: "claimed",
		attempts: 1,
		maxAttempts: 1,
		lease: {
			ownerId: "live-retry-acceptance",
			leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		notBefore: new Date().toISOString(),
		enqueueUuidKey: `run_task:${taskId}`,
		lastError: null,
		createdAt: new Date().toISOString(),
	};
}

try {
	const source = await tasks.get(sourceTaskId);
	assert.ok(source, "source task not found");
	assert.equal(source.organization_id, organizationId, "foreign source task");
	assert.equal(source.status, "failed", "source task is not failed");

	const key = `live-retry:${crypto.randomUUID()}`;
	const retried = await retryTaskWithDependencies(deps, scope, {
		failedTaskId: sourceTaskId,
		idempotencyKey: key,
	});
	assert.equal(retried.created, true, "retry was not created");
	const retryTaskId = asTaskId(retried.taskId);
	assert.notEqual(retryTaskId, sourceTaskId, "rerun reused the failed task");

	const replay = await retryTaskWithDependencies(deps, scope, {
		failedTaskId: sourceTaskId,
		idempotencyKey: key,
	});
	assert.equal(replay.taskId, retried.taskId, "retry replay is not stable");
	assert.equal(replay.created, false);

	const row = await tasks.get(retryTaskId);
	assert.ok(row, "retry task row missing");
	assert.equal(row.retry_of, sourceTaskId, "retry_of not linked");
	assert.equal(row.retry_depth, 1);
	assert.equal(row.repository_id, source.repository_id, "boundary changed");
	assert.equal(row.goal, source.goal, "goal changed");
	assert.deepEqual(row.file_ownership, source.file_ownership);

	const jobs = (await sql.unsafe(
		"SELECT type, status FROM jobs WHERE task_id = $1",
		[retryTaskId],
	)) as Array<Record<string, unknown>>;
	assert.equal(jobs.length, 1, "expected exactly one job for the rerun");
	assert.equal(jobs[0]?.type, "run_task");
	console.log(`source: ${sourceTaskId} → retry: ${retryTaskId} (${retried.branch})`);

	const config = loadWorkerConfig(
		process.env as Record<string, string | undefined>,
	);
	const composed = await createConfiguredWorkerComposition(config, logger);
	assert.equal(composed.inferenceProvider, "meta");
	assert.equal(composed.providerName, "modal");

	const lifetimeMs = Math.min(maxSandboxSeconds * 1000, 240_000);
	const composition: WorkerComposition = createOfflineWorkerDeps(config, logger, {
		...composed.overrides,
		// Proof only: no push, so no approvals and no GitHub write.
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
	const handler = composition.handlers.find((h) => h.jobType === "run_task");
	assert.ok(handler, "run_task handler not registered");

	const verdict = await handler.handle(syntheticJob(retryTaskId, { taskId: retryTaskId }), {
		logger,
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});
	console.log(`run_task: ${verdict.outcome}${verdict.note ? ` (${verdict.note})` : ""}`);
	assert.equal(verdict.outcome, "complete");

	const finalTask = await tasks.get(retryTaskId);
	assert.equal(finalTask?.status, "review_ready", "rerun did not reach review_ready");

	const attemptRows = await attempts.listByTask(retryTaskId);
	const artifactRows = await artifacts.listByTask({ organizationId, taskId: retryTaskId });
	const usage = (await sql.unsafe(
		`SELECT provider, model_id, prompt_tokens, completion_tokens, cost_usd
		 FROM usage_records WHERE task_id = $1 ORDER BY created_at`,
		[retryTaskId],
	)) as Array<Record<string, unknown>>;

	assert.ok(attemptRows.length >= 1, "no attempt recorded for the rerun");
	assert.ok(
		artifactRows.some((row) => row.kind === "diff"),
		"no diff artifact from the rerun",
	);
	assert.ok(
		usage.some((row) => row.provider === "meta"),
		"no Meta usage row from the rerun",
	);
	assert.ok(
		usage.some((row) => row.provider === "modal"),
		"no sandbox usage row from the rerun",
	);

	console.log(
		JSON.stringify(
			{
				sourceTaskId,
				retryTaskId,
				branch: retried.branch,
				status: finalTask.status,
				attempts: attemptRows.length,
				artifacts: artifactRows.map((row) => row.kind),
				usage,
			},
			null,
			2,
		),
	);
	console.log("LIVE RETRY ACCEPTANCE PASSED (failed task → same-boundary rerun → review_ready)");
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE RETRY ACCEPTANCE FAILED: ${code}: ${message}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
