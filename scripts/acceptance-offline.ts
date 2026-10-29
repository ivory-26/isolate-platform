import { strict as assert } from "node:assert";
import type { JobRow, QueueRepository } from "../packages/db/src/index";
import {
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
	type Logger,
	PlatformError,
	type UsageRecordInput,
	type UsageSink,
} from "../packages/shared/src/index";
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
			assert.deepEqual(denied, { state: "denied", reason: "POLICY_DENIED" });
			assert.equal(calls.git.length, 0, "denied tool never reached backend");

			if (options.onUsage) {
				await options.onUsage({
					providerId: "baseten",
					modelId: "meta-models/muse-spark-open",
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

try {
	await successScenario();
	await throwScenario();
	await abortScenario();
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
