import { describe, expect, test } from "bun:test";
import type { JobRow } from "@isolate/db";
import type {
	AgentUsage,
	CodingAgentRuntime,
	CodingAgentRuntimeFactory,
	TaskContext,
} from "@isolate/mastra";
import type {
	CommandPolicy,
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "@isolate/sandbox";
import { NullProvider } from "@isolate/sandbox";
import type {
	ExecutionLifecycle,
	LogFields,
	Logger,
	OrganizationId,
	TaskId,
	UsageRecordInput,
	UsageSink,
} from "@isolate/shared";
import { isPlatformError, type PlatformError } from "@isolate/shared";
import {
	createLoggingNoopUsageSink,
	createOfflineWorkerDeps,
} from "./composition";
import { workerConfigSchema } from "./config";
import type { HandlerContext } from "./contracts";

type LogRecord = { severity: string; message: string; fields: LogFields };

function makeFakeLogger(sink: LogRecord[]): Logger {
	const make = (base: LogFields): Logger => ({
		debug: (m, f) =>
			sink.push({ severity: "debug", message: m, fields: { ...base, ...f } }),
		info: (m, f) =>
			sink.push({ severity: "info", message: m, fields: { ...base, ...f } }),
		warn: (m, f) =>
			sink.push({ severity: "warn", message: m, fields: { ...base, ...f } }),
		error: (m, f) =>
			sink.push({ severity: "error", message: m, fields: { ...base, ...f } }),
		child: (f) => make({ ...base, ...f }),
	});
	return make({});
}

const CONFIG = workerConfigSchema.parse({
	workerId: "test-worker",
});
const CONTEXT: TaskContext = {
	taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f",
	organizationId: "11111111-1111-4111-8111-111111111111",
	goal: "goal",
	repoUrl: "https://example.com/repo.git",
	baseBranch: "main",
	isolatedBranch: "task/x",
	fileOwnership: [],
	acceptanceCriteria: [],
	limits: { max_agent_turns: 3, max_repair_attempts: 0, max_duration_ms: 1000 },
};
const ORG_ID = CONTEXT.organizationId as OrganizationId;
const TASK_ID = CONTEXT.taskId as TaskId;

describe("worker composition — offline defaults", () => {
	test("boots with zero provider env and maps config into enforced caps", () => {
		const composition = createOfflineWorkerDeps(CONFIG, makeFakeLogger([]));
		const deps = composition.taskExecution;

		expect(deps.provider).toBeInstanceOf(NullProvider);
		expect(deps.provider.name).toBe("null");
		expect(deps.caps).toEqual({
			maxOutputTokensPerTurn: CONFIG.maxOutputTokensPerTurn,
			maxTaskTokens: CONFIG.maxTokensPerTask,
			maxSteps: CONFIG.maxAgentSteps,
		});
		expect(deps.maxSandboxSeconds).toBe(CONFIG.maxSandboxSeconds);
		expect(deps.maxCostUsdPerTask).toBe(CONFIG.maxCostUsdPerTask);
		expect(deps.sandboxPriceTable).toBeNull();
		expect(deps.sandboxPolicy.egress).toEqual({ mode: "deny" });
		expect(deps.sandboxPolicy.workspaceRoot).toBe("/workspace/task");
		expect(deps.sandbox.cpuCount).toBe(1);
		expect(deps.sandbox.memoryMb).toBe(1024);
		expect(deps.sandbox.lifetimeMs).toBe(CONFIG.maxSandboxSeconds * 1000);
		expect(composition.handlers).toHaveLength(1);
		expect(composition.handlers[0]?.jobType).toBe("run_task");
		expect(
			composition.handlers[0]?.supports({
				taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f",
			}),
		).toBe(true);
	});

	test("unconfigured runtime factory fails closed with MISSING_CONFIG", () => {
		const { taskExecution } = createOfflineWorkerDeps(
			CONFIG,
			makeFakeLogger([]),
		);
		let thrown: unknown;
		try {
			taskExecution.createRuntime({});
		} catch (error) {
			thrown = error;
		}
		expect(isPlatformError(thrown)).toBe(true);
		expect((thrown as PlatformError).code).toBe("MISSING_CONFIG");
		expect((thrown as PlatformError).message).toBe(
			"no agent runtime configured",
		);
	});

	test("unconfigured task loader rejects with MISSING_CONFIG", async () => {
		const { taskExecution } = createOfflineWorkerDeps(
			CONFIG,
			makeFakeLogger([]),
		);
		await expect(
			taskExecution.loadTaskContext({
				organizationId: CONTEXT.organizationId as OrganizationId,
				taskId: CONTEXT.taskId as TaskId,
			}),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("no-op usage sink logs one bounded warning and never throws", async () => {
		const logs: LogRecord[] = [];
		const sink = createLoggingNoopUsageSink(makeFakeLogger(logs));
		await expect(
			sink.record({
				organizationId: CONTEXT.organizationId as OrganizationId,
				taskId: null,
				provider: "null",
				modelId: "sandbox:1x1024",
				promptTokens: null,
				completionTokens: null,
				costUsd: null,
			}),
		).resolves.toBeUndefined();
		await sink.record({
			organizationId: CONTEXT.organizationId as OrganizationId,
			taskId: null,
			provider: "null",
			modelId: "sandbox:1x1024",
			promptTokens: null,
			completionTokens: null,
			costUsd: null,
		});
		const warnings = logs.filter((log) => log.severity === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("usage sink not configured");
		expect(JSON.stringify(warnings[0]?.fields)).not.toContain("sandbox:");
	});
});

describe("worker composition — adapter overrides", () => {
	test("injected adapters replace every default without touching config", () => {
		const runtime: CodingAgentRuntime = {
			id: "fake",
			name: "Fake",
			async runTurn() {
				return "";
			},
		};
		const createRuntime: CodingAgentRuntimeFactory = () => runtime;
		const provider: SandboxProvider = {
			name: "override-provider",
			async create(_spec: SandboxSpec): Promise<SandboxHandle> {
				throw new Error("not used");
			},
			async execute(): Promise<never> {
				throw new Error("not used");
			},
			async destroy(): Promise<void> {},
		};
		const sink: UsageSink = {
			async record(_input: UsageRecordInput): Promise<void> {},
		};
		const loadTaskContext = async (): Promise<TaskContext> => CONTEXT;
		const sandboxPolicy: CommandPolicy = {
			workspaceRoot: "/sandbox/root",
			allowlist: [],
			maxTimeoutMs: 1000,
			maxOutputBytes: 1024,
			egress: { mode: "deny" },
		};

		const composition = createOfflineWorkerDeps(CONFIG, makeFakeLogger([]), {
			provider,
			createRuntime,
			usageSink: sink,
			loadTaskContext,
			sandboxPolicy,
			caps: { maxSteps: 3 },
			sandbox: { cpuCount: 2, memoryMb: 2048, lifetimeMs: 30_000 },
			maxSandboxSeconds: 30,
			maxCostUsdPerTask: 0,
			sandboxPriceTable: { cpuSecondUsd: 1, gibSecondUsd: 1 },
		});
		const deps = composition.taskExecution;

		expect(deps.provider).toBe(provider);
		expect(deps.createRuntime).toBe(createRuntime);
		expect(deps.usageSink).toBe(sink);
		expect(deps.loadTaskContext).toBe(loadTaskContext);
		expect(deps.sandboxPolicy).toBe(sandboxPolicy);
		expect(deps.caps).toEqual({
			maxOutputTokensPerTurn: CONFIG.maxOutputTokensPerTurn,
			maxTaskTokens: CONFIG.maxTokensPerTask,
			maxSteps: 3,
		});
		expect(deps.sandbox).toEqual({
			cpuCount: 2,
			memoryMb: 2048,
			lifetimeMs: 30_000,
		});
		expect(deps.maxSandboxSeconds).toBe(30);
		expect(deps.maxCostUsdPerTask).toBe(0);
		expect(deps.sandboxPriceTable).toEqual({
			cpuSecondUsd: 1,
			gibSecondUsd: 1,
		});
	});

	test("a lifecycle seam registers the resume handler without changing run_task", () => {
		const lifecycle: ExecutionLifecycle = {
			async transition() {},
			async event() {},
			async artifact() {
				return { artifactId: "artifact_1" };
			},
			async attemptStarted() {
				return { attemptId: "attempt_1", attemptIndex: 1 };
			},
			async attemptFinished() {},
			async approvalRequested() {
				return { approvalId: "approval_1" };
			},
			async approvalStatus() {
				return null;
			},
			async isCancelled() {
				return false;
			},
		};
		const composition = createOfflineWorkerDeps(CONFIG, makeFakeLogger([]), {
			lifecycle,
			pushEnabled: true,
		});
		expect(composition.handlers.map((handler) => handler.jobType)).toEqual([
			"run_task",
			"resume_task",
		]);
		expect(composition.taskExecution.lifecycle).toBe(lifecycle);
		expect(composition.taskExecution.pushEnabled).toBe(true);
		expect(
			composition.handlers[1]?.supports({
				taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f",
				approvalId: "approval_1",
			}),
		).toBe(true);
	});

	test("override runtime receives caps and listeners from the composed handler", async () => {
		const seenCaps: unknown[] = [];
		const sinkRows: UsageRecordInput[] = [];
		const provider: SandboxProvider = {
			name: "fake-provider",
			async create(spec: SandboxSpec): Promise<SandboxHandle> {
				return { id: "sbx_1", workspaceRoot: spec.workspaceRoot };
			},
			async execute(): Promise<CommandResult> {
				return {
					exitCode: 0,
					stdout: "",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputLimitExceeded: false,
				};
			},
			async destroy(): Promise<void> {},
		};
		const createRuntime: CodingAgentRuntimeFactory = (options) => {
			seenCaps.push(options.caps);
			const runtime: CodingAgentRuntime = {
				id: "fake",
				name: "Fake",
				async runTurn() {
					const usage: AgentUsage = {
						providerId: "baseten",
						modelId: "fake-model",
						promptTokens: 1,
						completionTokens: 1,
						totalTokens: 2,
						costUsd: 0,
					};
					await options.onUsage?.(usage);
					await options.onRecord?.({
						turn: 1,
						status: "finished",
						toolCalls: [],
						summary: null,
					});
					return "";
				},
			};
			return runtime;
		};
		const composition = createOfflineWorkerDeps(CONFIG, makeFakeLogger([]), {
			createRuntime,
			loadTaskContext: async () => CONTEXT,
			provider,
			usageSink: {
				async record(input) {
					sinkRows.push(input);
				},
			},
		});
		const job: JobRow = {
			id: "job_1" as JobRow["id"],
			organizationId: ORG_ID,
			taskId: TASK_ID,
			type: "run_task",
			payload: { taskId: TASK_ID },
			status: "claimed",
			attempts: 1,
			maxAttempts: 3,
			lease: null,
			notBefore: "2026-10-29T00:00:00.000Z",
			enqueueUuidKey: "enqueue_1",
			lastError: null,
			createdAt: "2026-10-29T00:00:00.000Z",
		};
		const ctx: HandlerContext = {
			logger: makeFakeLogger([]),
			signal: new AbortController().signal,
			heartbeat: async () => true,
		};
		const verdict = await composition.handlers[0]?.handle(job, ctx);
		expect(verdict?.outcome).toBe("complete");
		expect(seenCaps).toEqual([
			{
				maxOutputTokensPerTurn: CONFIG.maxOutputTokensPerTurn,
				maxTaskTokens: CONFIG.maxTokensPerTask,
				maxSteps: CONFIG.maxAgentSteps,
			},
		]);
		expect(sinkRows).toHaveLength(2); // one model row + one sandbox row
		expect(sinkRows[1]?.modelId).toBe("sandbox:1x1024");
	});
});
