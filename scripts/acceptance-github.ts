import { strict as assert } from "node:assert";
import {
	createDb,
	PostgresApprovalRepository,
	PostgresArtifactRepository,
	PostgresExecutionLifecycle,
	PostgresTaskAttemptRepository,
	PostgresTaskContextRepository,
	PostgresTaskRepository,
	PostgresUsageRepository,
	PostgresWorkflowRunRepository,
	type JobRow,
} from "../packages/db/src/index";
import type { CodingAgentRuntimeFactory } from "../packages/mastra/src/agents/types";
import { wireSandboxTools } from "../packages/mastra/src/tools/sandbox-tools";
import { createTaskWorkspaceGit } from "../packages/sandbox/src/index";
import {
	asApprovalId,
	asJobId,
	asOrganizationId,
	asTaskId,
	createConsoleLogger,
	type UsageRecordInput,
	type UsageSink,
} from "../packages/shared/src/index";
import {
	createResumeTaskHandler,
	createTaskExecutionHandler,
	type TaskExecutionDeps,
} from "../apps/worker/src/task-execution-handler";
import {
	createSandboxToolBackend,
	createWorkspaceToolPolicy,
} from "../apps/worker/src/sandbox-tool-backend";
import { createTaskContextLoader } from "../apps/worker/src/task-context";
import {
	createSandboxEnvResolver,
	selectGitHubTokenProvider,
	selectSandboxProvider,
} from "../apps/worker/src/runtime-composition";

/**
 * Wave 7 GitHub push acceptance (one bounded run, no retries).
 *
 * Exercises the REAL worker handler with the REAL Postgres lifecycle, REAL
 * Modal sandbox, REAL Git workspace clone/commit/push and the REAL approval
 * pause/resume path. The agent runtime is deterministic (writes one file and
 * commits through the real policy-gated tools), so no inference call is made.
 *
 * Requires GITHUB_LIVE=1 and the seeded identifiers:
 *   LIVE_ORGANIZATION_ID, LIVE_USER_ID, LIVE_REPOSITORY_ID
 * Optional: LIVE_REPO_FULL_NAME (default ivory-26/agent-bank), LIVE_BASE_BRANCH (main).
 *
 * A disposable branch is pushed; no PR is created. DB rows remain as evidence.
 */

if (process.env.GITHUB_LIVE !== "1") {
	console.log("Set GITHUB_LIVE=1 to run the bounded GitHub push acceptance.");
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
const repoFullName = process.env.LIVE_REPO_FULL_NAME?.trim() || "ivory-26/agent-bank";
const baseBranch = process.env.LIVE_BASE_BRANCH?.trim() || "main";
const databaseUrl = required("DATABASE_URL");

const FILE = "LIVE_ACCEPTANCE.md";
const COMMIT_MESSAGE = "chore: wave 7 live acceptance";
const branch = `task/w7-live-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const content = `# Wave 7 live acceptance\n\n- repository: ${repoFullName}\n- branch: ${branch}\n- at: ${new Date().toISOString()}\n`;

const logger = createConsoleLogger("live-github");
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
			ownerId: "live-github-acceptance",
			leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		},
		notBefore: new Date().toISOString(),
		enqueueUuidKey: `${type}:${taskId}:${crypto.randomUUID()}`,
		lastError: null,
		createdAt: new Date().toISOString(),
	};
}

const sql = createDb(databaseUrl);
const tasks = new PostgresTaskRepository(sql);
const approvals = new PostgresApprovalRepository(sql);
const artifacts = new PostgresArtifactRepository(sql);
const attempts = new PostgresTaskAttemptRepository(sql);
const runs = new PostgresWorkflowRunRepository(sql);
const usageRepository = new PostgresUsageRepository(sql);
const lifecycle = new PostgresExecutionLifecycle(sql);

const usageRows: UsageRecordInput[] = [];
const usageSink: UsageSink = {
	async record(input) {
		await usageRepository.record(input);
		usageRows.push(input);
	},
};

try {
	const githubProvider = selectGitHubTokenProvider(process.env);
	assert.ok(githubProvider, "GitHub provider is not configured");
	const sandbox = await selectSandboxProvider({
		...process.env,
		SANDBOX_PROVIDER: "modal",
	});
	assert.ok(sandbox.real, "Modal provider is not configured");

	let turn = 0;
	const createRuntime: CodingAgentRuntimeFactory = (options) => {
		const backend = options.sandboxBackend;
		const context = options.toolContext;
		if (!backend || !context) {
			throw new Error("sandbox backend or tool context missing");
		}
		const tools = wireSandboxTools(backend).forTask({
			organizationId: context.organizationId,
			taskId: context.taskId,
			scopes: [...(context.scopes ?? [])],
			fileOwnership: [...(context.fileOwnership ?? [])],
		});
		return {
			async runTurn() {
				turn += 1;
				if (turn > 1) return "";
				const write = await tools["repo.write_file"].execute?.(
					{ path: FILE, content },
					{} as never,
				);
				if (!write || write.state !== "executed") {
					throw new Error(`write tool returned ${write?.state ?? "no result"}`);
				}
				const commit = await tools["git.commit_local"].execute?.(
					{ message: COMMIT_MESSAGE },
					{} as never,
				);
				if (!commit || commit.state !== "executed") {
					throw new Error(`commit tool returned ${commit?.state ?? "no result"}`);
				}
				return "";
			},
		};
	};

	const deps: TaskExecutionDeps = {
		provider: sandbox.provider,
		createRuntime,
		createSandboxBackend: ({ sandbox: handle, signal, baseBranch: base, repoPath }) =>
			createSandboxToolBackend({
				provider: sandbox.provider,
				sandbox: handle,
				signal,
				policy: createWorkspaceToolPolicy(handle.workspaceRoot),
				...(base === undefined ? {} : { baseBranch: base }),
				...(repoPath === undefined ? {} : { repoPath }),
			}),
		usageSink,
		loadTaskContext: createTaskContextLoader(
			new PostgresTaskContextRepository(sql),
		),
		lifecycle,
		createWorkspaceGit: createTaskWorkspaceGit,
		resolveSandboxEnv: createSandboxEnvResolver(githubProvider),
		pushEnabled: true,
		caps: { maxOutputTokensPerTurn: 16, maxTaskTokens: 1_000, maxSteps: 1 },
		sandboxPolicy: createWorkspaceToolPolicy("/tmp"),
		sandbox: {
			cpuCount: 0.125,
			memoryMb: 512,
			lifetimeMs: 240_000,
			idleTimeoutMs: 60_000,
		},
		maxSandboxSeconds: 240,
		maxCostUsdPerTask: 1,
		priceTable: null,
	};

	const task = await tasks.create({
		organizationId,
		repositoryId,
		branch,
		idempotencyKey: `live-github:${crypto.randomUUID()}`,
		budgetLimits: {
			maxAgentTurns: 2,
			maxRepairAttempts: 0,
			maxDurationMs: 240_000,
		},
		goal: "Write LIVE_ACCEPTANCE.md and commit it on the isolated branch.",
		acceptanceCriteria: [`${FILE} exists on ${branch}`],
		fileOwnership: [FILE],
		createdBy: userId,
	});
	const taskId = asTaskId(task.id);
	console.log(`task: ${taskId} branch: ${branch}`);

	const ctx = {
		logger,
		signal: controller.signal,
		heartbeat: async () => true,
	};

	const first = await createTaskExecutionHandler(deps).handle(
		syntheticJob(taskId, "run_task", { taskId }),
		ctx,
	);
	console.log(`run_task verdict: ${first.outcome}${first.note ? ` (${first.note})` : ""}`);
	assert.equal(first.outcome, "complete");
	assert.match(first.note ?? "", /awaiting approval/);

	const pending = await approvals.listPending(organizationId);
	const approval = pending.find(
		(row) => row.task_id === taskId && row.action === "git.push_branch",
	);
	assert.ok(approval, "pending push approval was not persisted");
	const decided = await approvals.decide({
		approvalId: asApprovalId(approval.id),
		decide: "approve",
		payloadSha256: approval.payload_sha256,
		decidedBy: userId,
	});
	assert.ok(decided.ok, `approval decision failed: ${decided.code}`);
	console.log(`approval: ${approval.id} approved`);

	const resumed = await createResumeTaskHandler(deps).handle(
		syntheticJob(taskId, "resume_task", {
			taskId,
			approvalId: approval.id,
		}),
		ctx,
	);
	console.log(
		`resume_task verdict: ${resumed.outcome}${resumed.note ? ` (${resumed.note})` : ""}`,
	);
	assert.equal(resumed.outcome, "complete");

	const finalTask = await tasks.get(taskId);
	assert.equal(finalTask?.status, "review_ready");

	const verify = await githubProvider.getInstallationToken({
		repositoryFullName: repoFullName,
		contents: "read",
	});
	const headers = {
		Authorization: `Bearer ${verify.token}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "isolate-platform",
	};
	const branchResponse = await fetch(
		`https://api.github.com/repos/${repoFullName}/branches/${encodeURIComponent(branch)}`,
		{ headers },
	);
	const branchBody = (await branchResponse.json()) as {
		commit?: { sha?: string };
	};
	const contentsResponse = await fetch(
		`https://api.github.com/repos/${repoFullName}/contents/${FILE}?ref=${encodeURIComponent(branch)}`,
		{ headers },
	);
	assert.equal(branchResponse.status, 200);
	assert.equal(contentsResponse.status, 200);

	const eventRows = await runs.listEvents(taskId, 200);
	const attemptRows = await attempts.listByTask(taskId);
	const artifactRows = await artifacts.listByTask({ organizationId, taskId });

	console.log(
		JSON.stringify(
			{
				taskId,
				branch,
				taskStatus: finalTask?.status,
				approvalStatus: decided.approval.status,
				attempts: attemptRows.length,
				events: eventRows.length,
				artifacts: artifactRows.length,
				artifactBytes: artifactRows[0]?.byte_size ?? 0,
				branchStatus: branchResponse.status,
				branchSha: branchBody.commit?.sha ?? null,
				contentsStatus: contentsResponse.status,
				usageRows: usageRows.length,
			},
			null,
			2,
		),
	);
	console.log("LIVE GITHUB ACCEPTANCE PASSED");
} catch (error) {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: "INTERNAL";
	const message =
		error instanceof Error ? error.message.slice(0, 300) : "unknown failure";
	console.error(`LIVE GITHUB ACCEPTANCE FAILED: ${code}: ${message}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
