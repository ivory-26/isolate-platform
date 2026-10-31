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
	asRepositoryId,
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
 * Wave 8/9 live acceptance (ONE bounded run per scenario, no retries).
 *
 * LIVE_SCENARIO=pass (default)
 *   real Meta turns → clone → agent writes a doc + a Bun test → validation
 *   command runs and passes → acceptance checks pass → push → PR approval →
 *   PR created and verified.
 *
 * LIVE_SCENARIO=fail
 *   same setup with a validation command that exits non-zero → task fails,
 *   nothing is pushed, the log artifact is stored.
 *
 * Both use the real Modal sandbox, the real Postgres lifecycle and the real
 * approval gates. Caps are mandatory.
 */

if (process.env.LIVE_PR !== "1") {
	console.log("Set LIVE_PR=1 to run the bounded live acceptance.");
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

const scenarioRaw = process.env.LIVE_SCENARIO?.trim() || "pass";
if (scenarioRaw !== "pass" && scenarioRaw !== "fail") {
	console.error("LIVE_SCENARIO must be 'pass' or 'fail'");
	process.exit(1);
}
const scenario: "pass" | "fail" = scenarioRaw;

const organizationId = asOrganizationId(required("LIVE_ORGANIZATION_ID"));
const userId = required("LIVE_USER_ID");
const repositoryId = required("LIVE_REPOSITORY_ID");
const repoFullName =
	process.env.LIVE_REPO_FULL_NAME?.trim() || "ivory-26/agent-bank";
const baseBranch = process.env.LIVE_BASE_BRANCH?.trim() || "main";
const databaseUrl = required("DATABASE_URL");

const maxTokensPerTask = Number(required("WORKER_MAX_TOKENS_PER_TASK"));
const maxSandboxSeconds = Number(required("WORKER_MAX_SANDBOX_SECONDS"));
const maxCostUsdPerTask = Number(required("WORKER_MAX_COST_USD_PER_TASK"));
assert.ok(maxTokensPerTask > 0 && maxTokensPerTask <= 200_000_000);
assert.ok(maxSandboxSeconds > 0 && maxSandboxSeconds <= 600);
assert.ok(maxCostUsdPerTask > 0 && maxCostUsdPerTask <= 5);
assert.equal(process.env.INFERENCE_PROVIDER?.trim(), "meta");
assert.equal(process.env.SANDBOX_PROVIDER?.trim(), "modal");
assert.notEqual(process.env.GITHUB_PUSH_ENABLED?.trim(), "false");

const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const FILE = "LIVE_ACCEPTANCE.md";
const TEST_FILE = "live_acceptance.test.ts";
const MISSING_TEST = `live_missing_${suffix}.test.ts`;
const branch = `task/w9-live-${suffix}`;
const content = [
	"# Wave 9 live acceptance",
	"",
	`- repository: ${repoFullName}`,
	`- branch: ${branch}`,
	`- generated: ${new Date().toISOString()}`,
	"- path: Meta → Modal → validation → acceptance → push → PR",
	"",
].join("\n");
const testContent = [
	'import { expect, test } from "bun:test";',
	"",
	'test("live acceptance fixture", () => {',
	"\texpect(1 + 1).toBe(2);",
	"});",
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

const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const approvals = new PostgresApprovalRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);
const attempts = new PostgresTaskAttemptRepository(sql);
const runs = new PostgresWorkflowRunRepository(sql);
const repositories = new PostgresRepositoryRepository(sql);

let taskId: ReturnType<typeof asTaskId> | null = null;
let previousValidation: string | null = null;
let policyChanged = false;

try {
	const config = loadWorkerConfig(
		process.env as Record<string, string | undefined>,
	);
	const composed = await createConfiguredWorkerComposition(config, logger);
	assert.equal(composed.providerName, "modal", "sandbox provider is not Modal");
	assert.equal(composed.inferenceProvider, "meta", "inference is not Meta");
	assert.ok(composed.overrides.pullRequest, "PR stage is not bound");
	assert.equal(composed.overrides.pushEnabled, true, "push is not enabled");
	assert.equal(
		typeof composed.overrides.loadAcceptanceChecks,
		"function",
		"acceptance checks are not bound",
	);
	assert.equal(
		typeof composed.overrides.acquireBranchLock,
		"function",
		"branch lock is not bound",
	);

	const repository = await repositories.get({
		organizationId,
		repositoryId: asRepositoryId(repositoryId),
	});
	assert.ok(repository, "seeded repository not found in this organization");
	previousValidation = repository.validation_command;

	const validationCommand =
		scenario === "pass" ? `bun test ${TEST_FILE}` : `bun test ${MISSING_TEST}`;
	await repositories.setValidationPolicy({
		organizationId,
		repositoryId: asRepositoryId(repositoryId),
		validationCommand,
		validationTimeoutMs: 120_000,
	});
	policyChanged = true;
	console.log(
		`scenario: ${scenario} · validation: ${validationCommand} · previous: ${previousValidation ?? "none"}`,
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

	const passGoal = `Create two files at the repository root. First ${FILE} with exactly this content:\n\n${content}\n\nSecond ${TEST_FILE} with exactly this content:\n\n${testContent}\n\nThen commit both with the message "chore: wave 9 live validation acceptance". Use repo.write_file and git.commit_local. Do not modify any other file.`;
	const failGoal = `Create the file ${FILE} at the repository root with exactly this content:\n\n${content}\n\nThen commit it with the message "chore: wave 9 live validation failure acceptance". Use repo.write_file and git.commit_local. Do not modify any other file.`;

	const task = await tasks.create({
		organizationId,
		repositoryId,
		branch,
		idempotencyKey: `live-${scenario}:${suffix}`,
		budgetLimits: {
			maxAgentTurns: 2,
			maxRepairAttempts: 0,
			maxDurationMs: lifetimeMs,
		},
		goal: scenario === "pass" ? passGoal : failGoal,
		acceptanceCriteria:
			scenario === "pass"
				? [
						`${FILE} exists and mentions Wave 9`,
						`${TEST_FILE} exists and passes under bun test`,
					]
				: [`${FILE} exists on the branch`],
		fileOwnership: scenario === "pass" ? [FILE, TEST_FILE] : [FILE],
		...(scenario === "pass"
			? {
					acceptanceChecks: [
						{ kind: "path_exists" as const, path: FILE },
						{ kind: "path_exists" as const, path: TEST_FILE },
						{
							kind: "content_matches" as const,
							path: FILE,
							pattern: "Wave 9",
						},
					],
				}
			: {}),
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

	const afterRun = await tasks.get(taskId);
	const eventRows = await runs.listEvents(taskId, 200);
	const eventTypes = eventRows.map((row) => row.type);
	const artifactRows = await artifacts.listByTask({ organizationId, taskId });
	const reportArtifact = artifactRows.find((row) => row.kind === "report");
	const logArtifact = artifactRows.find((row) => row.kind === "log_bundle");

	const broker = selectGitHubTokenProvider(process.env);
	assert.ok(broker, "GitHub broker is not configured");
	const installation = await broker.getInstallationToken({
		repositoryFullName: repoFullName,
		contents: "read",
		pullRequests: "read",
	});
	const headers = {
		Authorization: `Bearer ${installation.token}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "isolate-platform",
	};
	const branchResponse = await fetch(
		`https://api.github.com/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`,
		{ headers },
	);

	if (scenario === "fail") {
		assert.equal(resumed.outcome, "dead_letter", "failure must not complete");
		assert.equal(resumed.code, "VALIDATION_FAILED");
		assert.equal(afterRun?.status, "failed");
		assert.equal(branchResponse.status, 404, "a failed validation must not push");
		assert.ok(logArtifact, "validation log artifact missing");
		assert.ok(
			eventTypes.includes("validation.finished"),
			"validation event missing",
		);
		console.log(
			JSON.stringify(
				{
					taskId,
					scenario,
					status: afterRun.status,
					verdict: resumed.code,
					branchStatus: branchResponse.status,
					artifacts: artifactRows.map((row) => row.kind),
					usage: await sql.unsafe(
						"SELECT provider, model_id, prompt_tokens, completion_tokens FROM usage_records WHERE task_id=$1",
						[taskId],
					),
				},
				null,
				2,
			),
		);
		console.log("LIVE VALIDATION-FAIL ACCEPTANCE PASSED (gate blocked the push)");
	} else {
		assert.equal(resumed.outcome, "complete", "resume_task did not complete");
		assert.equal(afterRun?.status, "awaiting_approval");
		assert.ok(reportArtifact, "acceptance report artifact missing");
		assert.ok(
			eventTypes.includes("acceptance.finished"),
			"acceptance event missing",
		);
		assert.equal(branchResponse.status, 200, "the branch was not pushed");

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
		assert.equal(created.outcome, "complete");

		const finalTask = await tasks.get(taskId);
		assert.equal(finalTask?.status, "pull_request_created");
		assert.ok(finalTask?.pull_request_number && finalTask.pull_request_url);

		const prResponse = await fetch(
			`https://api.github.com/repos/${repoFullName}/pulls/${finalTask.pull_request_number}`,
			{ headers },
		);
		const prBody = (await prResponse.json()) as {
			state?: string;
			head?: { ref?: string; sha?: string };
			base?: { ref?: string };
		};
		assert.equal(prResponse.status, 200);
		assert.equal(prBody.state, "open");
		assert.equal(prBody.head?.ref, branch);
		assert.equal(prBody.base?.ref, baseBranch);
		const filesResponse = await fetch(
			`https://api.github.com/repos/${repoFullName}/pulls/${finalTask.pull_request_number}/files`,
			{ headers },
		);
		const filesBody = (await filesResponse.json()) as Array<{
			filename?: string;
		}>;
		assert.equal(filesResponse.status, 200);
		const changedFiles = filesBody.map((entry) => entry.filename ?? "").sort();
		assert.deepEqual(changedFiles, [FILE, TEST_FILE].sort());

		console.log(
			JSON.stringify(
				{
					taskId,
					scenario,
					branch,
					status: finalTask.status,
					pullRequest: finalTask.pull_request_number,
					pullRequestUrl: finalTask.pull_request_url,
					files: changedFiles,
					events: eventTypes,
					artifacts: artifactRows.map((row) => row.kind),
					attempts: (await attempts.listByTask(taskId)).length,
					usage: await sql.unsafe(
						"SELECT provider, model_id, prompt_tokens, completion_tokens FROM usage_records WHERE task_id=$1 ORDER BY created_at",
						[taskId],
					),
				},
				null,
				2,
			),
		);
		console.log("LIVE VALIDATION-PASS ACCEPTANCE PASSED (validation + PR)");
	}
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE ACCEPTANCE FAILED (${scenario}): ${code}: ${message}`);
	if (taskId) console.error(`task for inspection: ${taskId}`);
	process.exitCode = 1;
} finally {
	if (policyChanged) {
		await repositories
			.setValidationPolicy({
				organizationId,
				repositoryId: asRepositoryId(repositoryId),
				validationCommand: previousValidation,
				validationTimeoutMs: 300_000,
			})
			.catch(() => undefined);
		console.log(`validation policy restored to: ${previousValidation ?? "none"}`);
	}
	await sql.end({ timeout: 5 });
}
