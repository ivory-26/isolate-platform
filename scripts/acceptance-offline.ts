import { strict as assert } from "node:assert";
import type { JobRow, QueueRepository } from "../packages/db/src/index";
import {
	InMemoryApprovalRepository,
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "../packages/db/src/testing/fakes";
import { createInMemoryWorkflowCompilationRepositories } from "../packages/db/src/testing/workflow-compilation";
import type { CodingAgentRuntimeFactory } from "../packages/mastra/src/agents/types";
import type { SandboxToolBackend } from "../packages/mastra/src/tools/sandbox-backend";
import { wireSandboxTools } from "../packages/mastra/src/tools/sandbox-tools";
import type { WiredToolOutput } from "../packages/mastra/src/tools/registry";
import type {
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "../packages/sandbox/src/providers/types";
import {
	asTaskId,
	type ExecutionLifecycle,
	type LifecycleArtifactInput,
	type Logger,
	PlatformError,
	type RunEventType,
	type TaskStatus,
	type UsageRecordInput,
	type UsageSink,
} from "../packages/shared/src/index";
import type {
	AuthorizedCommand,
	CommandResult,
	CreateTaskWorkspaceGit,
} from "../packages/sandbox/src/index";
import {
	pullRequestApprovalPayloadSha256,
	type PullRequestRecord,
} from "../packages/integrations/src/index";
import { createPullRequestHandler } from "../apps/worker/src/create-pull-request-handler";
import { loadWorkerConfig } from "../apps/worker/src/config";
import {
	createTaskExecutionHandler,
	type TaskExecutionDeps,
} from "../apps/worker/src/task-execution-handler";
import {
	createWorkerLoop,
	type WorkerEvent,
} from "../apps/worker/src/loop";
import { localDemo } from "../apps/web/src/server/caller-scope.server";
import { createDevelopmentAuthoredVersions } from "../apps/web/src/server/development-workflows.server";
import { createRepositoryStore } from "../apps/web/src/server/repository-store.server";
import { createSubmissionCompiler } from "../apps/web/src/server/submission-compilation.server";
import { createTaskService } from "../apps/web/src/server/task-service.server";

/**
 * Phase C key-less acceptance (see project/DECISIONS.md).
 *
 * Runs submission → durable queue → worker claim → policy-gated tools → usage
 * sink → sandbox teardown → ack, using production services and package fakes.
 * No provider credential, no SDK import, no network call. Exits non-zero on any
 * failed assertion.
 */

const PROVIDER_ENV = /^(BASETEN_|MODAL_)/;

function refuse(reason: string): never {
	console.error(`REFUSED: ${reason}`);
	process.exit(1);
}

const forbiddenEnv = Object.keys(process.env).filter((name) =>
	PROVIDER_ENV.test(name),
);
if (forbiddenEnv.length > 0) {
	refuse(
		`provider environment variables are set (${forbiddenEnv.join(", ")}); run this acceptance with zero credentials`,
	);
}
for (const [name, allowed] of [
	["INFERENCE_PROVIDER", "none"],
	["SANDBOX_PROVIDER", "null"],
] as const) {
	const value = process.env[name];
	if (value !== undefined && value !== allowed) {
		refuse(`${name}=${value} is not the offline value "${allowed}"`);
	}
}

const scope = {
	organizationId: localDemo.organizationId,
	userId: localDemo.userId,
	// The demo identity owns the demo organization; the task service gates on
	// the membership role, so the scope has to carry it.
	role: "owner" as const,
};

function silentLogger(): Logger {
	const logger: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return logger;
		},
	};
	return logger;
}

class RecordingQueue extends InMemoryQueueRepository {
	enqueueCalls = 0;
	readonly enqueuedIds = new Set<string>();
	readonly completed: string[] = [];
	readonly failed: Array<{ jobId: string; code: string; requeued: boolean }> =
		[];

	override async enqueue(
		input: Parameters<QueueRepository["enqueue"]>[0],
	): Promise<JobRow> {
		this.enqueueCalls += 1;
		const job = await super.enqueue(input);
		this.enqueuedIds.add(job.id);
		return job;
	}

	override async ackComplete(
		...args: Parameters<QueueRepository["ackComplete"]>
	): ReturnType<QueueRepository["ackComplete"]> {
		this.completed.push(args[0]);
		return super.ackComplete(...args);
	}

	override async ackFail(
		input: Parameters<QueueRepository["ackFail"]>[0],
	): ReturnType<QueueRepository["ackFail"]> {
		const result = await super.ackFail(input);
		this.failed.push({
			jobId: input.jobId,
			code: input.code,
			requeued: result.ok ? result.requeued : false,
		});
		return result;
	}
}

async function buildControlPlane() {
	const tasks = new InMemoryTaskRepository();
	const queue = new RecordingQueue();
	const pin = {
		organizationId: scope.organizationId,
		workflowDefinitionId: localDemo.workflowDefinitionId,
		workflowVersion: localDemo.workflowVersion,
	};
	const compilationRepos = createInMemoryWorkflowCompilationRepositories({
		versions: [pin],
	});
	const compileSubmission = createSubmissionCompiler({
		getRepositories: async () => ({
			authoredVersions: createDevelopmentAuthoredVersions(),
			compiledPlans: compilationRepos.compiledPlans,
			rejections: compilationRepos.rejections,
		}),
		// The compile gate is mandatory and fails closed: only the demo
		// identity may compile inside the demo organization.
		authorizeMembership: async (caller) =>
			caller.organizationId === scope.organizationId &&
			caller.userId === scope.userId,
	});
	const store = createRepositoryStore({
		tasks,
		queue,
		approvals: new InMemoryApprovalRepository(),
		lifecycle: recordingLifecycle().lifecycle,
		repositoryBelongsToOrganization: async (organizationId, repositoryId) =>
			organizationId === scope.organizationId &&
			repositoryId === localDemo.repositoryId,
		compileSubmission,
		listLatest: async () => [],
	});
	const service = createTaskService({
		resolveScope: async () => scope,
		getStore: async () => store,
	});
	return { service, queue, tasks };
}

function submission(idempotencyKey = crypto.randomUUID()) {
	return {
		repositoryId: localDemo.repositoryId,
		branch: "task/offline-acceptance",
		idempotencyKey,
		goal: "Exercise the offline task lifecycle",
		acceptanceCriteria: ["the offline acceptance script passes"],
		fileOwnership: ["packages/**"],
		workflowDefinitionId: localDemo.workflowDefinitionId,
		workflowVersion: localDemo.workflowVersion,
		budget: {},
	};
}

type BackendCalls = {
	readFile: string[];
	git: (readonly string[])[];
};

function fakeBackend(): { backend: SandboxToolBackend; calls: BackendCalls } {
	const calls: BackendCalls = { readFile: [], git: [] };
	const backend: SandboxToolBackend = {
		async readFile(path) {
			calls.readFile.push(path);
			return { content: `content:${path}`, truncated: false };
		},
		async listFiles(path) {
			return [`${path}/README.md`];
		},
		async search(query) {
			return [{ path: "README.md", line: 1, preview: query }];
		},
		async exec() {
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: 0,
				truncated: false,
			};
		},
		async git(args) {
			calls.git.push(args);
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: 0,
				truncated: false,
			};
		},
	};
	return { backend, calls };
}

async function callTool(
	registry: ReturnType<typeof wireSandboxTools>,
	name: "repo.read_file" | "git.push_branch",
	args: Record<string, unknown>,
): Promise<WiredToolOutput> {
	const tool = registry.forTask({
		organizationId: scope.organizationId,
		taskId: crypto.randomUUID(),
		scopes: ["repo:read"],
	})[name];
	assert.ok(tool.execute, `tool ${name} has execute`);
	return (await tool.execute(args, {} as never)) as WiredToolOutput;
}

type Scenario = "success" | "throw" | "abort";

type ScenarioState = {
	usage: UsageRecordInput[];
	destroyed: number;
	created: number;
	backend: BackendCalls;
};

function createDeps(
	scenario: Scenario,
	state: ScenarioState,
): TaskExecutionDeps {
	const { backend, calls } = fakeBackend();
	state.backend = calls;
	const registry = wireSandboxTools(backend);

	const provider: SandboxProvider = {
		name: "recording-fake",
		async create(spec: SandboxSpec): Promise<SandboxHandle> {
			state.created += 1;
			return { id: "fixture-sandbox", workspaceRoot: spec.workspaceRoot };
		},
		async execute() {
			throw new PlatformError("POLICY_DENIED", "acceptance fake has no exec");
		},
		async destroy() {
			state.destroyed += 1;
		},
	};

	const createRuntime: CodingAgentRuntimeFactory = (options) => ({
		id: "acceptance-agent",
		name: "Acceptance Agent",
		async runTurn(input) {
			if (scenario === "abort") {
				input.signal.throwIfAborted();
				throw new PlatformError("CANCELLED", "acceptance abort");
			}
			if (scenario === "throw") {
				throw new PlatformError("VALIDATION_FAILED", "acceptance failure");
			}

			const read = await callTool(registry, "repo.read_file", {
				path: "README.md",
			});
			assert.equal(read.state, "executed");
			assert.deepEqual(calls.readFile, ["README.md"]);

			const denied = await callTool(registry, "git.push_branch", {
				branch: "main",
			});
			// Wave 7: push is a sensitive band, so the gate returns APPROVAL_REQUIRED
			// and the implementation (and backend) is never reached.
			assert.deepEqual(denied, { state: "denied", reason: "APPROVAL_REQUIRED" });
			assert.equal(calls.git.length, 0, "denied tool never reached backend");

			if (options.onUsage) {
				await options.onUsage({
					providerId: "baseten",
					modelId: "meta-models/muse-spark-open-1026",
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
					costUsd: null,
				});
			}
			return "";
		},
	});

	const sink: UsageSink = {
		async record(input) {
			state.usage.push(input);
		},
	};

	return {
		provider,
		createRuntime,
		usageSink: sink,
		async loadTaskContext(input) {
			return {
				taskId: input.taskId,
				organizationId: input.organizationId,
				goal: "Offline acceptance task",
				repoUrl: "https://github.com/example/offline",
				baseBranch: "main",
				isolatedBranch: "task/offline-acceptance",
				fileOwnership: ["src/"],
				acceptanceCriteria: ["The acceptance script passes"],
				limits: {
					max_agent_turns: 2,
					max_repair_attempts: 1,
					max_duration_ms: 30_000,
				},
			};
		},
		caps: {
			maxOutputTokensPerTurn: 16,
			maxTaskTokens: 10_000,
			maxSteps: 2,
		},
		sandboxPolicy: {
			workspaceRoot: "/workspace/task",
			allowlist: [],
			maxTimeoutMs: 5_000,
			maxOutputBytes: 16_384,
			egress: { mode: "deny" },
		},
		sandbox: { cpuCount: 1, memoryMb: 512, lifetimeMs: 60_000 },
		maxSandboxSeconds: 60,
		maxCostUsdPerTask: 1,
		sandboxPriceTable: null,
	};
}

function emptyState(): ScenarioState {
	return {
		usage: [],
		destroyed: 0,
		created: 0,
		backend: { readFile: [], git: [] },
	};
}

async function waitFor(
	register: (resolve: (event: WorkerEvent) => void) => void,
): Promise<WorkerEvent> {
	return await new Promise<WorkerEvent>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("worker event timeout")),
			5_000,
		);
		register((event) => {
			clearTimeout(timer);
			resolve(event);
		});
	});
}

function configuredLoop(queue: RecordingQueue, handler: TaskExecutionDeps) {
	const config = loadWorkerConfig({
		WORKER_POLL_INTERVAL_MS: "50",
		WORKER_LEASE_SECONDS: "5",
	});
	let resolveEvent: ((event: WorkerEvent) => void) | null = null;
	const loop = createWorkerLoop({
		config,
		logger: silentLogger(),
		handlers: [createTaskExecutionHandler(handler)],
		queue,
		jobTimeoutMs: 5_000,
		onEvent: (event) => {
			if (event.kind !== "claimed") resolveEvent?.(event);
		},
	});
	return { loop, setResolve: (fn: typeof resolveEvent) => (resolveEvent = fn) };
}

async function successScenario() {
	const { service, queue } = await buildControlPlane();
	const key = crypto.randomUUID();
	const first = await service.submit(submission(key));
	assert.ok(first.ok, "first submission compiles and enqueues");
	assert.equal(first.value.compilation.outcome, "compiled");
	const replay = await service.submit(submission(key));
	assert.ok(replay.ok, "idempotent replay succeeds");
	assert.equal(replay.value.jobId, first.value.jobId, "same job on replay");
	assert.equal(queue.enqueuedIds.size, 1, "exactly one run_task job");
	assert.equal(queue.enqueueCalls, 2, "replay re-ran the idempotent enqueue");

	const state = emptyState();
	const deps = createDeps("success", state);
	const { loop, setResolve } = configuredLoop(queue, deps);

	const eventPromise = waitFor((resolve) => setResolve(resolve));
	const running = loop.start();
	try {
		const event = await eventPromise;
		assert.equal(event.kind, "completed");
	} finally {
		await loop.stop("acceptance complete");
		await running;
	}

	assert.deepEqual(queue.completed, [first.value.jobId]);
	assert.equal(queue.failed.length, 0);
	assert.equal(state.created, 1, "one sandbox provisioned");
	assert.equal(state.destroyed, 1, "destroy called exactly once");
	assert.equal(state.usage.length, 2, "one model row + one sandbox row");
	const [modelRow, sandboxRow] = state.usage;
	assert.equal(modelRow.provider, "baseten");
	assert.equal(modelRow.promptTokens, 10);
	assert.equal(modelRow.completionTokens, 5);
	assert.equal(sandboxRow.provider, "recording-fake");
	assert.equal(sandboxRow.modelId, "sandbox:1x512");
	assert.equal(sandboxRow.promptTokens, null);
	console.log("PASS success: submit → claim → gated tools → usage → destroy → ack");
}

async function throwScenario() {
	const queue = new RecordingQueue();
	const state = emptyState();
	const deps = createDeps("throw", state);
	const handler = createTaskExecutionHandler(deps);
	await queue.enqueue({
		organizationId: scope.organizationId,
		taskId: asTaskId("10000000-0000-4000-8000-0000000000aa"),
		type: "run_task",
		payload: { taskId: "10000000-0000-4000-8000-0000000000aa" },
		idempotencyKey: crypto.randomUUID(),
		maxAttempts: 1,
	});
	const claimed = await queue.claimNext({
		ownerId: "acceptance",
		leaseSeconds: 30,
	});
	assert.ok(claimed, "job claimed before handler runs");
	const verdict = await handler.handle(claimed, {
		logger: silentLogger(),
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});
	assert.equal(verdict.outcome, "dead_letter");
	assert.equal(verdict.code, "VALIDATION_FAILED");
	const ack = await queue.ackFail({
		jobId: claimed.id,
		ownerId: "acceptance",
		code: verdict.code,
		message: "acceptance failure",
	});
	assert.ok(ack.ok);
	assert.equal(ack.requeued, false, "exhausted attempt budgets dead-letter");
	assert.equal(state.created, 1);
	assert.equal(state.destroyed, 1, "destroy called exactly once on throw");
	assert.equal(state.usage.length, 1, "sandbox teardown row still recorded");
	assert.equal(state.usage[0].provider, "recording-fake");
	console.log("PASS throw: destroy once → sandbox usage row → dead_letter ack");
}

async function abortScenario() {
	const queue = new RecordingQueue();
	const state = emptyState();
	const deps = createDeps("abort", state);
	const handler = createTaskExecutionHandler(deps);
	await queue.enqueue({
		organizationId: scope.organizationId,
		taskId: asTaskId("10000000-0000-4000-8000-0000000000bb"),
		type: "run_task",
		payload: { taskId: "10000000-0000-4000-8000-0000000000bb" },
		idempotencyKey: crypto.randomUUID(),
		maxAttempts: 5,
	});
	const claimed = await queue.claimNext({
		ownerId: "acceptance",
		leaseSeconds: 30,
	});
	assert.ok(claimed, "job claimed before handler runs");

	const controller = new AbortController();
	const verdict = await handler.handle(claimed, {
		logger: silentLogger(),
		signal: controller.signal,
		heartbeat: async () => {
			controller.abort();
			return false;
		},
	});
	assert.equal(verdict.outcome, "retry");
	assert.equal(verdict.code, "LEASE_LOST");
	const ack = await queue.ackFail({
		jobId: claimed.id,
		ownerId: "acceptance",
		code: verdict.code,
		message: "lease lost",
	});
	assert.ok(ack.ok);
	assert.equal(ack.requeued, true, "lease loss requeues the job");
	assert.equal(state.created, 1);
	assert.equal(state.destroyed, 1, "destroy called exactly once on abort");
	assert.equal(state.usage.length, 1);
	console.log("PASS abort: lease lost → destroy once → retry/requeue ack");
}

/* ------------------------------ wave 8 scenarios ---------------------------- */

type LifecycleCall =
	| { readonly kind: "transition"; readonly from: TaskStatus; readonly to: TaskStatus }
	| {
			readonly kind: "event";
			readonly type: RunEventType;
			readonly data: Readonly<Record<string, unknown>> | undefined;
	  }
	| { readonly kind: "artifact"; readonly artifact: LifecycleArtifactInput };

function recordingLifecycle(options: { approvalSha?: string } = {}) {
	const calls: LifecycleCall[] = [];
	const lifecycle: ExecutionLifecycle = {
		async transition(input) {
			calls.push({ kind: "transition", from: input.from, to: input.to });
		},
		async event(input) {
			calls.push({ kind: "event", type: input.type, data: input.data });
		},
		async artifact(input) {
			calls.push({ kind: "artifact", artifact: input });
			return { artifactId: `artifact-${calls.length}` };
		},
		async attemptStarted() {
			return { attemptId: "attempt-1", attemptIndex: 1 };
		},
		async attemptFinished() {},
		async approvalRequested() {
			return { approvalId: "approval-1" };
		},
		async approvalStatus() {
			return options.approvalSha === undefined
				? null
				: { status: "approved", payloadSha256: options.approvalSha };
		},
		async isCancelled() {
			return false;
		},
	};
	return { lifecycle, calls };
}

function fakeWorkspaceGit(pushes: string[]): CreateTaskWorkspaceGit {
	return () => ({
		async assertToolchain() {},
		async cloneAndCheckout(input) {
			return { path: input.targetPath, baseBranch: input.baseBranch };
		},
		async createBranch() {},
		async commitAll() {
			return { commitSha: "b".repeat(40) };
		},
		async diffStat() {
			return {
				filesChanged: 1,
				insertions: 3,
				deletions: 0,
				files: ["src/app.ts"],
			};
		},
		async diffPatch() {
			return { patch: "diff --git a/src/app.ts b/src/app.ts", truncated: false };
		},
		async pushBranch(_workspace, branch) {
			pushes.push(branch);
		},
	});
}

async function validationScenario(status: "passed" | "failed") {
	const queue = new RecordingQueue();
	const state = emptyState();
	const base = createDeps("success", state);
	const commands: AuthorizedCommand[] = [];
	const pushes: string[] = [];
	const { lifecycle, calls } = recordingLifecycle();
	const deps: TaskExecutionDeps = {
		...base,
		lifecycle,
		createWorkspaceGit: fakeWorkspaceGit(pushes),
		loadValidationPolicy: async () => ({
			command: "bun test",
			timeoutMs: 5_000,
		}),
		provider: {
			...base.provider,
			async execute(_handle, command): Promise<CommandResult> {
				commands.push(command);
				return {
					exitCode: status === "passed" ? 0 : 1,
					stdout: "suite output",
					stderr: "",
					durationMs: 7,
					timedOut: false,
					outputLimitExceeded: false,
				};
			},
		},
	};
	const handler = createTaskExecutionHandler(deps);
	const taskId = asTaskId(crypto.randomUUID());
	await queue.enqueue({
		organizationId: scope.organizationId,
		taskId,
		type: "run_task",
		payload: { taskId },
		idempotencyKey: crypto.randomUUID(),
		maxAttempts: 1,
	});
	const claimed = await queue.claimNext({
		ownerId: "acceptance",
		leaseSeconds: 30,
	});
	assert.ok(claimed, "validation job claimed");
	const verdict = await handler.handle(claimed, {
		logger: silentLogger(),
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});

	const transitions = calls
		.filter((call) => call.kind === "transition")
		.map((call) => `${call.from}->${call.to}`);
	const finished = calls
		.filter(
			(call) =>
				call.kind === "event" &&
				call.type === "validation.finished" &&
				call.data?.stage === "command",
		)
		.map((call) => call.data);
	const artifacts = calls
		.filter((call) => call.kind === "artifact")
		.map((call) => call.artifact);

	assert.equal(commands.length, 1, "validation command runs exactly once");
	assert.deepEqual(
		[commands[0].executable, ...commands[0].args],
		["bun", "test"],
		"argv-only validation command",
	);
	assert.equal(pushes.length, 0, "no push in the validation scenario");
	assert.equal(state.destroyed, 1, "destroy called exactly once");

	if (status === "passed") {
		assert.equal(verdict.outcome, "complete");
		assert.ok(
			transitions.includes("validating->review_ready"),
			transitions.join(","),
		);
		assert.equal(finished.at(-1)?.status, "passed");
		console.log("PASS validation-passed: command 0 → review_ready → destroy once");
	} else {
		assert.equal(verdict.outcome, "dead_letter");
		assert.equal(verdict.code, "VALIDATION_FAILED");
		assert.ok(
			transitions.includes("validating->failed"),
			transitions.join(","),
		);
		assert.equal(finished.at(-1)?.status, "failed");
		assert.ok(
			artifacts.some((artifact) => artifact.kind === "log_bundle"),
			"bounded log artifact stored",
		);
		console.log("PASS validation-failed: command 1 → failed → no push → destroy once");
	}
}

async function pullRequestScenario() {
	const target = {
		repositoryFullName: "ivory-26/agent-bank",
		headBranch: "task/w8-acceptance",
		baseBranch: "main",
		headSha: "a".repeat(40),
	};
	const approvalSha = await pullRequestApprovalPayloadSha256(target);
	const { lifecycle, calls } = recordingLifecycle({ approvalSha });
	let recorded: { number: number; url: string } | null = null;
	const handler = createPullRequestHandler({
		lifecycle,
		loadTaskState: async () => ({
			status: "awaiting_approval",
			pullRequestNumber: null,
			pullRequestUrl: null,
		}),
		loadPullRequestTarget: async () => target,
		recordPullRequest: async (input) => {
			recorded = {
				number: input.pullRequestNumber,
				url: input.pullRequestUrl,
			};
			return { ok: true };
		},
		createPullRequest: async () => ({
			ok: true,
			pullRequest: {
				number: 7,
				url: "https://github.com/ivory-26/agent-bank/pull/7",
				headBranch: target.headBranch,
				baseBranch: target.baseBranch,
				headSha: target.headSha,
			} satisfies PullRequestRecord,
			created: true,
		}),
	});
	const queue = new RecordingQueue();
	const taskId = asTaskId(crypto.randomUUID());
	await queue.enqueue({
		organizationId: scope.organizationId,
		taskId,
		type: "create_pull_request",
		payload: { taskId, approvalId: "approval-1" },
		idempotencyKey: crypto.randomUUID(),
		maxAttempts: 1,
	});
	const claimed = await queue.claimNext({
		ownerId: "acceptance",
		leaseSeconds: 30,
	});
	assert.ok(claimed, "pull request job claimed");
	const verdict = await handler.handle(claimed, {
		logger: silentLogger(),
		signal: new AbortController().signal,
		heartbeat: async () => true,
	});

	const transitions = calls
		.filter((call) => call.kind === "transition")
		.map((call) => `${call.from}->${call.to}`);
	const eventTypes = calls
		.filter((call) => call.kind === "event")
		.map((call) => call.type);
	assert.equal(verdict.outcome, "complete");
	assert.deepEqual(recorded, {
		number: 7,
		url: "https://github.com/ivory-26/agent-bank/pull/7",
	});
	assert.ok(
		transitions.includes("awaiting_approval->pull_request_created"),
		transitions.join(","),
	);
	assert.ok(eventTypes.includes("pr.created"), "pr.created emitted");
	console.log("PASS pull-request: approved + sha match → PR recorded → pull_request_created");
}

async function retryScenario() {
	const { service, queue, tasks } = await buildControlPlane();
	const first = await service.submit(submission());
	assert.ok(first.ok, "submission for the retry scenario succeeds");
	const source = asTaskId(first.value.task.id);
	const failed = await tasks.transition({
		taskId: source,
		to: "failed",
		expectedStatus: "queued",
	});
	assert.ok(failed.ok, "source task moved to failed");

	const retried = await service.retry({
		failedTaskId: source,
		idempotencyKey: "acceptance-retry-1",
	});
	assert.ok(retried.ok, "retry accepted");
	assert.notEqual(retried.value.taskId, source, "rerun is a new task");
	assert.equal(retried.value.created, true);

	const replay = await service.retry({
		failedTaskId: source,
		idempotencyKey: "acceptance-retry-1",
	});
	assert.ok(replay.ok, "retry replay accepted");
	assert.equal(replay.value.taskId, retried.value.taskId, "replay is stable");
	assert.equal(
		queue.enqueuedIds.size,
		2,
		"submit + exactly one retry job; replay enqueues nothing",
	);

	const row = await tasks.get(asTaskId(retried.value.taskId));
	assert.equal(row?.retry_of, source, "rerun links back to the failed task");
	assert.equal(row?.retry_depth, 1);
	assert.equal(row?.status, "queued");
	console.log("PASS retry: failed → same-boundary rerun → one job → replay stable");
}

try {
	await successScenario();
	await throwScenario();
	await abortScenario();
	await validationScenario("passed");
	await validationScenario("failed");
	await pullRequestScenario();
	await retryScenario();
	console.log("ACCEPTANCE PASSED (offline, zero provider credentials)");
	process.exit(0);
} catch (error) {
	console.error("ACCEPTANCE FAILED");
	if (error instanceof Error) {
		console.error(error.message);
		if (error.name !== "AssertionError") console.error(error.stack);
	} else {
		console.error(String(error));
	}
	process.exit(1);
}
