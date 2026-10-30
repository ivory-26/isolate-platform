import { strict as assert } from "node:assert";
import {
	createDb,
	PostgresApprovalRepository,
	PostgresArtifactRepository,
	PostgresRepositoryRepository,
	PostgresTaskAttemptRepository,
	PostgresTaskRepository,
	PostgresWorkflowRunRepository,
	type JobRow,
} from "../packages/db/src/index";
import {
	asApprovalId,
	asJobId,
	asOrganizationId,
	asTaskId,
	createConsoleLogger,
} from "../packages/shared/src/index";
import { loadWorkerConfig } from "../apps/worker/src/config";
import {
	createOfflineWorkerDeps,
	type WorkerComposition,
} from "../apps/worker/src/composition";
import {
	createConfiguredWorkerComposition,
	selectGitHubTokenProvider,
} from "../apps/worker/src/runtime-composition";

/**
 * Wave 8 live acceptance (ONE bounded run, no retries).
 *
 * Real Meta inference, real Modal sandbox, real Git clone/commit/push, real
 * Postgres lifecycle, real approval pause/resume, and a real pull request:
 *
 *   run_task → push approval → resume → PR approval → create_pull_request
 *
 * Requires LIVE_PR=1 plus the seeded identifiers and both provider configs.
 * Caps are mandatory and must be provided explicitly. On any failure the
 * script exits non-zero and must NOT be retried without a new decision.
 */

if (process.env.LIVE_PR !== "1") {
	console.log("Set LIVE_PR=1 to run the bounded live pull-request acceptance.");
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
const userId = required("LIVE_USER_ID");
const repositoryId = required("LIVE_REPOSITORY_ID");
const repoFullName =
	process.env.LIVE_REPO_FULL_NAME?.trim() || "ivory-26/agent-bank";
const baseBranch = process.env.LIVE_BASE_BRANCH?.trim() || "main";
const databaseUrl = required("DATABASE_URL");

// Mandatory spend caps: refuse to start without them.
const maxTokensPerTask = Number(required("WORKER_MAX_TOKENS_PER_TASK"));
const maxSandboxSeconds = Number(required("WORKER_MAX_SANDBOX_SECONDS"));
const maxCostUsdPerTask = Number(required("WORKER_MAX_COST_USD_PER_TASK"));
assert.ok(maxTokensPerTask > 0 && maxTokensPerTask <= 32_768);
assert.ok(maxSandboxSeconds > 0 && maxSandboxSeconds <= 600);
assert.ok(maxCostUsdPerTask > 0 && maxCostUsdPerTask <= 5);
assert.equal(process.env.INFERENCE_PROVIDER?.trim(), "meta");
assert.equal(process.env.SANDBOX_PROVIDER?.trim(), "modal");
assert.notEqual(process.env.GITHUB_PUSH_ENABLED?.trim(), "false");

const FILE = "LIVE_PR_ACCEPTANCE.md";
const COMMIT_MESSAGE = "chore: wave 8 live pull request acceptance";
const branch = `task/w8-live-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const content = [
	"# Wave 8 live acceptance",
	"",
	`- repository: ${repoFullName}`,
	`- branch: ${branch}`,
	`- generated: ${new Date().toISOString()}`,
	"- path: Meta inference → Modal sandbox → validation (skipped) → push → PR",
	"",
].join("\n");

const logger = createConsoleLogger("live-pr");
const controller = new AbortController();

function syntheticJob(
	taskId: ReturnType<typeof asTaskId>,
	type: JobRow["type"],
	payload: Record<string, unknown>,
): JobRow {
	return {
		id: asJobId(crypto.randomUUID()),
		organizationId,
		taskId,
		type,
		payload,
		status: "claimed",
		attempts: 1,
		maxAttempts: 1,
		lease: {
			ownerId: "live-pr-acceptance",
			leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		notBefore: new Date().toISOString(),
		enqueueUuidKey: `${type}:${taskId}:${crypto.randomUUID()}`,
		lastError: null,
		createdAt: new Date().toISOString(),
	};
}

function handlerFor(
	composition: WorkerComposition,
	type: JobRow["type"],
): WorkerComposition["handlers"][number] {
	const handler = composition.handlers.find((entry) => entry.jobType === type);
	assert.ok(handler, `handler for ${type} is not registered`);
	return handler;
}

async function sandboxCount(): Promise<number | null> {
	try {
		const { ModalClient } = await import("modal");
		const client = new ModalClient();
		let count = 0;
		for await (const _sandbox of client.sandboxes.list()) count += 1;
		return count;
	} catch {
		return null;
	}
}

const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const approvals = new PostgresApprovalRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);
const attempts = new PostgresTaskAttemptRepository(sql);
const runs = new PostgresWorkflowRunRepository(sql);
const repositories = new PostgresRepositoryRepository(sql);

let taskId: ReturnType<typeof asTaskId> | null = null;

try {
	const config = loadWorkerConfig(
		process.env as Record<string, string | undefined>,
	);
	const composed = await createConfiguredWorkerComposition(config, logger);
	assert.equal(composed.providerName, "modal", "sandbox provider is not Modal");
	assert.equal(composed.inferenceProvider, "meta", "inference is not Meta");
	assert.ok(composed.overrides.pullRequest, "PR stage is not bound");
	assert.equal(composed.overrides.pushEnabled, true, "push is not enabled");

	const repository = await repositories.get({
		organizationId,
		repositoryId,
	});
	assert.ok(repository, "seeded repository not found in this organization");
	const validationCommand = repository.validation_command;
	console.log(
		`repository: ${repository.external_full_name} validation=${validationCommand ?? "none (skipped)"}`,
	);

	const lifetimeMs = Math.min(maxSandboxSeconds * 1000, 240_000);
	const composition = createOfflineWorkerDeps(config, logger, {
		...composed.overrides,
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
		maxCostUsdPerTask,
	});

	const task = await tasks.create({
		organizationId,
		repositoryId,
		branch,
		idempotencyKey: `live-pr:${crypto.randomUUID()}`,
		budgetLimits: {
			maxAgentTurns: 2,
			maxRepairAttempts: 0,
			maxDurationMs: lifetimeMs,
		},
		goal: `Create the file ${FILE} at the repository root with exactly the content given in the acceptance criteria, then commit it with the message "${COMMIT_MESSAGE}". Use repo.write_file and git.commit_local. Do not modify any other file.`,
		acceptanceCriteria: [
			`${FILE} exists on ${branch} with the provided content`,
			`the only changed path is ${FILE}`,
			`content to write follows between the markers: <<<`,
			content,
			`>>>`,
		],
		fileOwnership: [FILE],
		createdBy: userId,
	});
	taskId = asTaskId(task.id);
	console.log(`task: ${taskId}`);
	console.log(`branch: ${branch}`);

	const ctx = {
		logger,
		signal: controller.signal,
		heartbeat: async () => true,
	};

	const first = await handlerFor(composition, "run_task").handle(
		syntheticJob(taskId, "run_task", { taskId }),
		ctx,
	);
	console.log(
		`run_task: ${first.outcome}${first.note ? ` (${first.note})` : ""}`,
	);
	assert.equal(first.outcome, "complete", "run_task did not complete");
	assert.match(first.note ?? "", /awaiting approval/);

	const pushApproval = (await approvals.listPending(organizationId)).find(
		(row) => row.task_id === taskId && row.action === "git.push_branch",
	);
	assert.ok(pushApproval, "pending push approval was not persisted");
	const pushDecision = await approvals.decide({
		approvalId: asApprovalId(pushApproval.id),
		decide: "approve",
		payloadSha256: pushApproval.payload_sha256,
		decidedBy: userId,
	});
	assert.ok(pushDecision.ok, `push approval failed: ${pushDecision.code}`);
	console.log(`push approval: ${pushApproval.id} approved`);

	const resumed = await handlerFor(composition, "resume_task").handle(
		syntheticJob(taskId, "resume_task", {
			taskId,
			approvalId: pushApproval.id,
		}),
		ctx,
	);
	console.log(
		`resume_task: ${resumed.outcome}${resumed.note ? ` (${resumed.note})` : ""}`,
	);
	assert.equal(resumed.outcome, "complete", "resume_task did not complete");

	const afterPush = await tasks.get(taskId);
	console.log(`task after push: ${afterPush?.status}`);
	assert.equal(
		afterPush?.status,
		"awaiting_approval",
		"task did not request the PR approval",
	);

	const prApproval = (await approvals.listPending(organizationId)).find(
		(row) =>
			row.task_id === taskId && row.action === "github.create_pull_request",
	);
	assert.ok(prApproval, "pending PR approval was not persisted");
	const prDecision = await approvals.decide({
		approvalId: asApprovalId(prApproval.id),
		decide: "approve",
		payloadSha256: prApproval.payload_sha256,
		decidedBy: userId,
	});
	assert.ok(prDecision.ok, `PR approval failed: ${prDecision.code}`);
	console.log(`pr approval: ${prApproval.id} approved`);

	const created = await handlerFor(
		composition,
		"create_pull_request",
	).handle(
		syntheticJob(taskId, "create_pull_request", {
			taskId,
			approvalId: prApproval.id,
		}),
		ctx,
	);
	console.log(
		`create_pull_request: ${created.outcome}${created.note ? ` (${created.note})` : ""}`,
	);
	assert.equal(created.outcome, "complete", "create_pull_request did not complete");

	const finalTask = await tasks.get(taskId);
	assert.equal(finalTask?.status, "pull_request_created");
	assert.ok(finalTask?.pull_request_number, "pull request number missing");
	assert.ok(finalTask?.pull_request_url, "pull request url missing");
	console.log(`pull request: #${finalTask.pull_request_number} ${finalTask.pull_request_url}`);

	// Independent verification against GitHub using the repo-scoped broker.
	const broker = selectGitHubTokenProvider(process.env);
	assert.ok(broker, "GitHub broker is not configured");
	const installation = await broker.getInstallationToken({
		repositoryFullName: repoFullName,
		contents: "read",
	});
	const headers = {
		Authorization: `Bearer ${installation.token}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "isolate-platform",
	};
	const prResponse = await fetch(
		`https://api.github.com/repos/${repoFullName}/pulls/${finalTask.pull_request_number}`,
		{ headers },
	);
	const prBody = (await prResponse.json()) as {
		state?: string;
		head?: { ref?: string; sha?: string };
		base?: { ref?: string };
	};
	assert.equal(prResponse.status, 200, "pull request is not readable");
	assert.equal(prBody.state, "open");
	assert.equal(prBody.head?.ref, branch);
	assert.equal(prBody.base?.ref, baseBranch);
	const filesResponse = await fetch(
		`https://api.github.com/repos/${repoFullName}/pulls/${finalTask.pull_request_number}/files`,
		{ headers },
	);
	const filesBody = (await filesResponse.json()) as Array<{ filename?: string }>;
	assert.equal(filesResponse.status, 200, "pull request files are not readable");
	const changedFiles = filesBody.map((entry) => entry.filename);
	assert.deepEqual(changedFiles, [FILE], "pull request touched an unexpected path");
	console.log(`github: PR open on ${branch} → ${baseBranch}; files=${changedFiles.join(",")}`);

	const usageRows = (await sql.unsafe(
		`SELECT provider, model_id, prompt_tokens, completion_tokens, cost_usd
		 FROM usage_records WHERE task_id = $1 ORDER BY created_at ASC`,
		[taskId],
	)) as Array<Record<string, unknown>>;
	const eventRows = await runs.listEvents(taskId, 200);
	const attemptRows = await attempts.listByTask(taskId);
	const artifactRows = await artifacts.listByTask({ organizationId, taskId });

	console.log(
		JSON.stringify(
			{
				taskId,
				branch,
				status: finalTask.status,
				pullRequestNumber: finalTask.pull_request_number,
				pullRequestUrl: finalTask.pull_request_url,
				attempts: attemptRows.length,
				events: eventRows.length,
				artifacts: artifactRows.length,
				usageRows,
				validationCommand: validationCommand ?? null,
			},
			null,
			2,
		),
	);
	console.log("LIVE PR ACCEPTANCE PASSED");
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE PR ACCEPTANCE FAILED: ${code}: ${message}`);
	if (taskId) console.error(`task for inspection: ${taskId}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
	const remaining = await sandboxCount();
	console.log(`sandboxes running after run: ${remaining ?? "unverified"}`);
}
