import { describe, expect, test } from "bun:test";
import type { JobRow } from "@isolate/db";
import type {
	AgentTurnCaps,
	AgentUsage,
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
import type {
	JobId,
	LogFields,
	Logger,
	OrganizationId,
	TaskId,
	UsageRecordInput,
	UsageSink,
} from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import type { HandlerContext, HandlerVerdict } from "./contracts";
import {
	buildTaskPrompt,
	createTaskExecutionHandler,
	type TaskExecutionDeps,
} from "./task-execution-handler";

/* ---------------------------------- fixtures -------------------------------- */

const TASK_UUID = "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f";
const TASK_ID = TASK_UUID as TaskId;
const ORG_ID = "11111111-1111-4111-8111-111111111111" as OrganizationId;

const POLICY: CommandPolicy = {
	workspaceRoot: "/workspace/task",
	allowlist: [],
	maxTimeoutMs: 60_000,
	maxOutputBytes: 1_048_576,
	egress: { mode: "deny" },
};

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
	return {
		id: "job_1" as JobId,
		organizationId: ORG_ID,
		taskId: TASK_ID,
		type: "run_task",
		payload: { taskId: TASK_UUID },
		status: "claimed",
		attempts: 1,
		maxAttempts: 3,
		lease: null,
		notBefore: "2026-10-29T00:00:00.000Z",
		enqueueUuidKey: "enqueue_1",
		lastError: null,
		createdAt: "2026-10-29T00:00:00.000Z",
		...overrides,
	};
}

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

class FakeClock {
	current = 1_000_000;
	now = (): number => this.current;
	advance(ms: number): void {
		this.current += ms;
	}
}

class FakeProvider implements SandboxProvider {
	readonly name = "fake-sandbox";
	createCalls: SandboxSpec[] = [];
	executeCalls: SandboxHandle[] = [];
	destroyCalls: SandboxHandle[] = [];
	createError: unknown = null;
	destroyError: unknown = null;
	private nextId = 0;

	async create(spec: SandboxSpec): Promise<SandboxHandle> {
		this.createCalls.push(spec);
		if (this.createError !== null) throw this.createError;
		this.nextId += 1;
		return { id: `sbx_${this.nextId}`, workspaceRoot: spec.workspaceRoot };
	}

	async execute(
		sandbox: SandboxHandle,
		_command: unknown,
		_signal?: AbortSignal,
	): Promise<CommandResult> {
		this.executeCalls.push(sandbox);
		return {
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputLimitExceeded: false,
		};
	}

	async destroy(sandbox: SandboxHandle): Promise<void> {
		this.destroyCalls.push(sandbox);
		if (this.destroyError !== null) throw this.destroyError;
	}
}

class FakeUsageSink implements UsageSink {
	rows: UsageRecordInput[] = [];
	calls = 0;
	/** 1-based call number that throws DB_UNAVAILABLE, if any. */
	failOnCall: number | null = null;

	async record(input: UsageRecordInput): Promise<void> {
		this.calls += 1;
		if (this.failOnCall === this.calls) {
			throw new PlatformError("DB_UNAVAILABLE", "usage store down");
		}
		this.rows.push(structuredClone(input));
	}
}

type ScriptTurn = {
	output: string;
	promptTokens?: number;
	completionTokens?: number;
	costUsd?: number | null;
	throwError?: unknown;
	onTurn?: () => void;
};

type RuntimeScript = {
	factory: CodingAgentRuntimeFactory;
	runTurns: number[];
	prompts: string[];
};

function makeRuntimeScript(script: ScriptTurn[]): RuntimeScript {
	const runTurns: number[] = [];
	const prompts: string[] = [];
	let cursor = 0;
	const factory: CodingAgentRuntimeFactory = (options) => ({
		id: "fake-runtime",
		name: "Fake Runtime",
		async runTurn(input) {
			cursor += 1;
			runTurns.push(cursor);
			prompts.push(input.prompt);
			const spec = script[Math.min(cursor - 1, script.length - 1)];
			if (spec === undefined) throw new Error("script exhausted");
			await options.onRecord?.({
				turn: cursor,
				status: "started",
				toolCalls: [],
				summary: null,
			});
			const promptTokens = spec.promptTokens ?? 10;
			const completionTokens = spec.completionTokens ?? 5;
			const usage: AgentUsage = {
				providerId: "baseten",
				modelId: "test-model",
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
				costUsd: spec.costUsd === undefined ? 0.001 : spec.costUsd,
			};
			await options.onUsage?.(usage);
			await options.onRecord?.({
				turn: cursor,
				status: "finished",
				toolCalls: ["read_file", "exec"],
				summary: "SECRET turn summary https://user:token@host",
			});
			spec.onTurn?.();
			if (spec.throwError !== undefined) throw spec.throwError;
			return spec.output;
		},
	});
	return { factory, runTurns, prompts };
}

const DEFAULT_CONTEXT: TaskContext = {
	taskId: TASK_UUID,
	organizationId: ORG_ID,
	goal: "Fix the widget",
	repoUrl: "https://github.com/acme/widget.git",
	baseBranch: "main",
	isolatedBranch: `task/${TASK_UUID}`,
	fileOwnership: ["src/widget.ts"],
	acceptanceCriteria: ["tests pass"],
	limits: {
		max_agent_turns: 4,
		max_repair_attempts: 1,
		max_duration_ms: 60_000,
	},
};

type HarnessOptions = {
	context?: Partial<TaskContext>;
	caps?: Partial<AgentTurnCaps>;
	sandbox?: Partial<TaskExecutionDeps["sandbox"]>;
	maxSandboxSeconds?: number;
	maxCostUsdPerTask?: number;
	priceTable?: TaskExecutionDeps["sandboxPriceTable"];
	script?: ScriptTurn[];
	runtime?: RuntimeScript;
	provider?: FakeProvider;
	sink?: FakeUsageSink;
	loadError?: unknown;
	clock?: FakeClock;
};

function makeHarness(options: HarnessOptions = {}) {
	const clock = options.clock ?? new FakeClock();
	const logs: LogRecord[] = [];
	const logger = makeFakeLogger(logs);
	const provider = options.provider ?? new FakeProvider();
	const sink = options.sink ?? new FakeUsageSink();
	const controller = new AbortController();
	const heartbeats: number[] = [];
	const loaderCalls: Array<{ organizationId: OrganizationId; taskId: TaskId }> =
		[];
	const runtime =
		options.runtime ?? makeRuntimeScript(options.script ?? [{ output: "" }]);

	const context: TaskContext = {
		...DEFAULT_CONTEXT,
		limits: { ...DEFAULT_CONTEXT.limits, ...options.context?.limits },
		...options.context,
	};

	const deps: TaskExecutionDeps = {
		provider,
		createRuntime: runtime.factory,
		usageSink: sink,
		loadTaskContext: async (input) => {
			loaderCalls.push(structuredClone(input));
			if (options.loadError !== undefined) throw options.loadError;
			return context;
		},
		caps: {
			maxOutputTokensPerTurn: 1024,
			maxTaskTokens: 200_000,
			maxSteps: 12,
			...options.caps,
		},
		sandboxPolicy: POLICY,
		sandbox: {
			cpuCount: 1,
			memoryMb: 512,
			lifetimeMs: 900_000,
			idleTimeoutMs: 300_000,
			...options.sandbox,
		},
		maxSandboxSeconds: options.maxSandboxSeconds ?? 120,
		maxCostUsdPerTask: options.maxCostUsdPerTask ?? 1,
		sandboxPriceTable:
			options.priceTable === undefined
				? { cpuSecondUsd: 0.5, gibSecondUsd: 0.25 }
				: options.priceTable,
		now: clock.now,
	};

	const ctx: HandlerContext = {
		logger,
		signal: controller.signal,
		heartbeat: async () => {
			heartbeats.push(clock.current);
			return !controller.signal.aborted;
		},
	};

	return {
		handler: createTaskExecutionHandler(deps),
		deps,
		ctx,
		controller,
		clock,
		logs,
		provider,
		sink,
		runtime,
		heartbeats,
		loaderCalls,
		job: makeJob(),
	};
}

function modelRows(rows: UsageRecordInput[]): UsageRecordInput[] {
	return rows.filter((row) => row.promptTokens !== null);
}

function sandboxRows(rows: UsageRecordInput[]): UsageRecordInput[] {
	return rows.filter((row) => row.promptTokens === null);
}

const COMPLETE: HandlerVerdict = {
	outcome: "complete",
	note: "agent reported no further work",
};

/* ---------------------------------- success --------------------------------- */

describe("task execution handler — success", () => {
	test("runs bounded turns, records usage, destroys once, completes", async () => {
		const clock = new FakeClock();
		const harness = makeHarness({
			clock,
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 5 } },
			script: [
				{ output: "working", onTurn: () => clock.advance(500) },
				{ output: "still working", onTurn: () => clock.advance(500) },
				{ output: "", onTurn: () => clock.advance(500) },
			],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(harness.runtime.runTurns).toEqual([1, 2, 3]);
		expect(harness.loaderCalls).toEqual([
			{ organizationId: ORG_ID, taskId: TASK_ID },
		]);
		expect(harness.heartbeats).toHaveLength(3);
		expect(harness.provider.createCalls).toHaveLength(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(harness.provider.destroyCalls[0]).toEqual({
			id: "sbx_1",
			workspaceRoot: POLICY.workspaceRoot,
		});
		// execute() is the runtime/tool plane's job, never the handler's.
		expect(harness.provider.executeCalls).toHaveLength(0);

		expect(harness.provider.createCalls[0]).toEqual({
			workspaceRoot: POLICY.workspaceRoot,
			lifetimeMs: 120_000, // min(900s provider lifetime, 120s cap)
			memoryMb: 512,
			cpuCount: 1,
			egress: { mode: "deny" },
		});

		expect(harness.sink.rows).toHaveLength(4);
		expect(modelRows(harness.sink.rows)).toEqual(
			[1, 2, 3].map(() => ({
				organizationId: ORG_ID,
				taskId: TASK_ID,
				provider: "baseten",
				modelId: "test-model",
				promptTokens: 10,
				completionTokens: 5,
				costUsd: 0.001,
			})),
		);
		expect(sandboxRows(harness.sink.rows)).toEqual([
			{
				organizationId: ORG_ID,
				taskId: TASK_ID,
				provider: "fake-sandbox",
				modelId: "sandbox:1x512",
				promptTokens: null,
				completionTokens: null,
				costUsd: 0.9375, // 1.5s * (1 * 0.5 + 0.5 * 0.25)
			},
		]);

		// Bounded observability: ids/codes/counts only, never summaries.
		const serialized = JSON.stringify(harness.logs);
		expect(serialized).not.toContain("SECRET");
		expect(serialized).not.toContain("token@host");
		expect(serialized).not.toContain("Fix the widget");
		const turnLogs = harness.logs.filter(
			(log) => log.message === "agent turn recorded",
		);
		expect(turnLogs).toHaveLength(6); // started + finished per turn
		for (const log of turnLogs) {
			expect(Object.keys(log.fields).sort()).toEqual([
				"hasSummary",
				"status",
				"toolCallCount",
				"turn",
			]);
		}
	});

	test("redelivery re-runs against a fresh sandbox and destroys each one", async () => {
		const harness = makeHarness({ script: [{ output: "" }] });
		const first = await harness.handler.handle(harness.job, harness.ctx);
		const second = await harness.handler.handle(harness.job, harness.ctx);
		expect(first).toEqual(COMPLETE);
		expect(second).toEqual(COMPLETE);
		expect(harness.provider.createCalls).toHaveLength(2);
		expect(harness.provider.destroyCalls).toHaveLength(2);
		// At-least-once accounting: duplicate usage rows are expected and
		// documented (no dedupe table in wave 4).
		expect(harness.sink.rows).toHaveLength(4);
	});
});

/* ------------------------------ failure mapping ----------------------------- */

describe("task execution handler — failure mapping", () => {
	test("retryable PlatformError → retry, teardown + spend still recorded", async () => {
		const harness = makeHarness({
			script: [
				{
					output: "partial",
					throwError: new PlatformError(
						"AGENT_EXECUTION_FAILED",
						"upstream failed at https://user:secret@provider.internal",
					),
				},
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "retry",
			code: "AGENT_EXECUTION_FAILED",
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(modelRows(harness.sink.rows)).toHaveLength(1);
		expect(sandboxRows(harness.sink.rows)).toHaveLength(1);
	});

	test("non-retryable PlatformError → dead_letter with sanitised note", async () => {
		const harness = makeHarness({
			script: [
				{
					output: "denied",
					throwError: new PlatformError(
						"POLICY_DENIED",
						"command denied at https://user:secret@host/path",
					),
				},
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("dead_letter");
		expect(verdict).toMatchObject({ code: "POLICY_DENIED" });
		if (verdict.outcome === "dead_letter") {
			expect(verdict.note).not.toContain("secret");
			expect(verdict.note).not.toContain("https");
		}
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("unknown throw → bounded INTERNAL retry with no raw message", async () => {
		const harness = makeHarness({
			script: [
				{
					output: "boom",
					throwError: new TypeError(
						"raw secret https://user:token@db.internal/x?api_key=zzz",
					),
				},
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "INTERNAL" });
		expect(JSON.stringify(verdict)).not.toContain("secret");
		expect(JSON.stringify(harness.logs)).not.toContain("token@db.internal");
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("task loader failure → dead_letter before any provisioning", async () => {
		const harness = makeHarness({
			loadError: new PlatformError("MISSING_CONFIG", "no loader"),
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "MISSING_CONFIG",
			note: "no loader",
		});
		expect(harness.provider.createCalls).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(0);
		expect(harness.sink.rows).toHaveLength(0);
	});

	test("provider create failure → retry, nothing to destroy", async () => {
		const provider = new FakeProvider();
		provider.createError = new PlatformError(
			"SANDBOX_PROVISION_FAILED",
			"modal unavailable",
		);
		const harness = makeHarness({ provider });
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "retry",
			code: "SANDBOX_PROVISION_FAILED",
		});
		expect(provider.createCalls).toHaveLength(1);
		expect(provider.destroyCalls).toHaveLength(0);
		expect(harness.sink.rows).toHaveLength(0);
	});

	test("destroy failure is mapped but destroy runs once and spend is kept", async () => {
		const provider = new FakeProvider();
		provider.destroyError = new Error("terminate failed");
		const harness = makeHarness({
			provider,
			script: [{ output: "" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "INTERNAL" });
		expect(provider.destroyCalls).toHaveLength(1);
		expect(harness.sink.rows).toHaveLength(2); // model row + sandbox row
	});

	test("usage sink failure → DB_UNAVAILABLE retry after teardown", async () => {
		const sink = new FakeUsageSink();
		sink.failOnCall = 1; // first model row
		const harness = makeHarness({
			sink,
			script: [{ output: "more" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "DB_UNAVAILABLE" });
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});
});

/* ----------------------------------- abort ---------------------------------- */

describe("task execution handler — abort / lease loss", () => {
	test("abort mid-run stops before the next turn and destroys once", async () => {
		const harness = makeHarness({
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 5 } },
			script: [
				{ output: "more", onTurn: () => harness.controller.abort() },
				{ output: "never" },
				{ output: "" },
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "LEASE_LOST" });
		expect(harness.runtime.runTurns).toEqual([1]);
		expect(harness.heartbeats).toHaveLength(1); // never beats before turn 2
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(modelRows(harness.sink.rows)).toHaveLength(1);
		expect(sandboxRows(harness.sink.rows)).toHaveLength(1);
	});

	test("preset abort still tears down and returns LEASE_LOST", async () => {
		const harness = makeHarness({ script: [{ output: "" }] });
		harness.controller.abort();
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "LEASE_LOST" });
		expect(harness.runtime.runTurns).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});
});

/* ---------------------------------- budgets --------------------------------- */

describe("task execution handler — budgets", () => {
	test("turn cap reached without completion → BUDGET_EXCEEDED", async () => {
		const harness = makeHarness({
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 2 } },
			script: [{ output: "more" }, { output: "still more" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "agent turn budget exhausted",
		});
		expect(harness.runtime.runTurns).toEqual([1, 2]);
		expect(harness.heartbeats).toHaveLength(2);
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(modelRows(harness.sink.rows)).toHaveLength(2);
	});

	test("zero turn allowance fails before provisioning", async () => {
		const harness = makeHarness({
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 0 } },
			script: [{ output: "never" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "task turn budget exhausted",
		});
		expect(harness.provider.createCalls).toHaveLength(0);
	});

	test("sandbox wall-time cap → BUDGET_EXCEEDED with measured sandbox cost", async () => {
		const clock = new FakeClock();
		const harness = makeHarness({
			clock,
			maxSandboxSeconds: 120,
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 5 } },
			script: [
				{ output: "more", onTurn: () => clock.advance(130_000) },
				{ output: "never" },
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "sandbox wall-time budget exhausted",
		});
		expect(harness.runtime.runTurns).toEqual([1]);
		expect(harness.provider.createCalls[0]?.lifetimeMs).toBe(120_000);
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(sandboxRows(harness.sink.rows)[0]?.costUsd).toBe(81.25); // 130s * (0.5 + 0.125)
	});

	test("cumulative token cap → BUDGET_EXCEEDED", async () => {
		const harness = makeHarness({
			caps: { maxTaskTokens: 15 },
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 5 } },
			script: [{ output: "more" }, { output: "never" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "agent token budget exhausted",
		});
		expect(harness.runtime.runTurns).toEqual([1]);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("cumulative cost cap → BUDGET_EXCEEDED", async () => {
		const harness = makeHarness({
			maxCostUsdPerTask: 0.0029,
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 10 } },
			script: [
				{ output: "one" },
				{ output: "two" },
				{ output: "three" },
				{ output: "never" },
			],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "task cost budget exhausted",
		});
		expect(harness.runtime.runTurns).toEqual([1, 2, 3]);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});
});

/* -------------------------------- spend maths ------------------------------- */

describe("task execution handler — sandbox spend", () => {
	test("null price table records null cost, never a guess", async () => {
		const harness = makeHarness({
			priceTable: null,
			script: [{ output: "" }],
		});
		await harness.handler.handle(harness.job, harness.ctx);
		const row = sandboxRows(harness.sink.rows)[0];
		expect(row?.costUsd).toBeNull();
		expect(row?.promptTokens).toBeNull();
		expect(row?.completionTokens).toBeNull();
	});

	test("cost table applies cpu-seconds and GiB-seconds at exact rates", async () => {
		const clock = new FakeClock();
		const harness = makeHarness({
			clock,
			sandbox: { cpuCount: 2, memoryMb: 2048, lifetimeMs: 600_000 },
			priceTable: { cpuSecondUsd: 0.5, gibSecondUsd: 0.25 },
			script: [{ output: "", onTurn: () => clock.advance(2000) }],
		});
		await harness.handler.handle(harness.job, harness.ctx);
		const row = sandboxRows(harness.sink.rows)[0];
		// 2s * (2 cpu * 0.5 + 2 GiB * 0.25) = 2 * 1.5 = 3
		expect(row?.costUsd).toBe(3);
		expect(row?.modelId).toBe("sandbox:2x2048");
	});
});

/* ------------------------------- prompt + support --------------------------- */

describe("task execution handler — prompt and payload", () => {
	test("prompt carries bounded task metadata and strips URL credentials", () => {
		const prompt = buildTaskPrompt({
			...DEFAULT_CONTEXT,
			goal: "GOAL with https://user:secret@host",
			repoUrl: "https://user:secret@github.com/acme/widget.git",
			acceptanceCriteria: ["tests pass", "lint clean"],
			fileOwnership: ["src/widget.ts", "src/index.ts"],
		});
		expect(prompt).toContain("GOAL with https://host");
		expect(prompt).toContain("https://github.com/acme/widget.git");
		expect(prompt).not.toContain("user:secret@");
		expect(prompt).toContain("tests pass");
		expect(prompt).toContain("src/widget.ts");
		expect(prompt).toContain("max_agent_turns=4");
	});

	test("supports() accepts only records with a UUID taskId and never throws", () => {
		const harness = makeHarness();
		expect(harness.handler.supports({ taskId: TASK_UUID })).toBe(true);
		expect(harness.handler.supports({ taskId: TASK_UUID, extra: 1 })).toBe(
			true,
		);
		const invalidPayloads: unknown[] = [
			{},
			{ taskId: "task_test" },
			{ taskId: 42 },
			{ taskId: null },
			null,
			[],
			"string",
			42,
		];
		for (const payload of invalidPayloads) {
			expect(() =>
				harness.handler.supports(payload as Record<string, unknown>),
			).not.toThrow();
			expect(harness.handler.supports(payload as Record<string, unknown>)).toBe(
				false,
			);
		}
		const hostile = {
			get taskId(): string {
				throw new Error("hostile getter");
			},
		};
		expect(harness.handler.supports(hostile)).toBe(false);
	});

	test("handle() rejects a payload whose taskId is not a UUID before any work", async () => {
		const harness = makeHarness();
		const verdict: HandlerVerdict = await harness.handler.handle(
			makeJob({ payload: { taskId: "not-a-uuid" } }),
			harness.ctx,
		);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "job payload rejected by handler",
		});
		expect(harness.provider.createCalls).toHaveLength(0);
	});

	test("binds the provisioned sandbox handle into the runtime factory", async () => {
		const harness = makeHarness({ script: [{ output: "" }] });
		const backend = {
			readFile: async () => ({ content: "", truncated: false }),
			listFiles: async () => [],
			search: async () => [],
			exec: async () => ({
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: 0,
				truncated: false,
			}),
			git: async () => ({
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: 0,
				truncated: false,
			}),
		};
		let bound: SandboxHandle | undefined;
		let observed: { sandboxBackend?: unknown; toolContext?: unknown } = {};
		const original = harness.deps.createRuntime;
		harness.deps.createSandboxBackend = ({ sandbox }) => {
			bound = sandbox;
			return backend;
		};
		harness.deps.createRuntime = (options) => {
			observed = {
				sandboxBackend: options.sandboxBackend,
				toolContext: options.toolContext,
			};
			return original(options);
		};

		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("complete");
		expect(bound).toEqual({
			id: "sbx_1",
			workspaceRoot: POLICY.workspaceRoot,
		});
		expect(observed.sandboxBackend).toBe(backend);
		expect(observed.toolContext).toEqual({
			organizationId: ORG_ID,
			taskId: TASK_ID,
			scopes: [],
		});
	});

	test("runs tool-less when no sandbox backend factory is configured", async () => {
		const harness = makeHarness({ script: [{ output: "" }] });
		let sawBackend = true;
		const original = harness.deps.createRuntime;
		harness.deps.createRuntime = (options) => {
			sawBackend = options.sandboxBackend !== undefined;
			return original(options);
		};
		await harness.handler.handle(harness.job, harness.ctx);
		expect(sawBackend).toBe(false);
	});
});
