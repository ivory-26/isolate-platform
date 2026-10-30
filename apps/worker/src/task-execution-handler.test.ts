import { describe, expect, test } from "bun:test";
import type { JobRow } from "@isolate/db";
import { pullRequestApprovalPayloadSha256 } from "@isolate/integrations";
import type {
	AgentTurnCaps,
	AgentUsage,
	CodingAgentRuntimeFactory,
	SandboxToolBackend,
	TaskContext,
	ToolDecisionRecord,
} from "@isolate/mastra";
import type {
	CommandPolicy,
	CommandResult,
	CreateTaskWorkspaceGit,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
	TaskDiffStat,
	TaskWorkspace,
	TaskWorkspaceCloneInput,
	TaskWorkspaceCommitInput,
	TaskWorkspaceGit,
} from "@isolate/sandbox";
import { SandboxError } from "@isolate/sandbox";
import type {
	AcceptanceCheck,
	ExecutionLifecycle,
	JobId,
	LifecycleApprovalState,
	LifecycleArtifactInput,
	LifecycleEventInput,
	LifecycleTransitionInput,
	LogFields,
	Logger,
	OrganizationId,
	RunEventType,
	TaskId,
	TaskStatus,
	UsageRecordInput,
	UsageSink,
} from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import type { HandlerContext, HandlerVerdict } from "./contracts";
import {
	buildTaskPrompt,
	createResumeTaskHandler,
	createTaskExecutionHandler,
	pushApprovalPayloadSha256,
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
	executeCommands: unknown[] = [];
	destroyCalls: SandboxHandle[] = [];
	createError: unknown = null;
	destroyError: unknown = null;
	/** Overrides the default successful command result when set. */
	executeHandler: ((command: unknown) => CommandResult) | null = null;
	private nextId = 0;

	async create(spec: SandboxSpec): Promise<SandboxHandle> {
		this.createCalls.push(spec);
		if (this.createError !== null) throw this.createError;
		this.nextId += 1;
		return { id: `sbx_${this.nextId}`, workspaceRoot: spec.workspaceRoot };
	}

	async execute(
		sandbox: SandboxHandle,
		command: unknown,
		_signal?: AbortSignal,
	): Promise<CommandResult> {
		this.executeCalls.push(sandbox);
		this.executeCommands.push(command);
		if (this.executeHandler !== null) return this.executeHandler(command);
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

type LifecycleCall =
	| { kind: "attemptStarted" }
	| {
			kind: "attemptFinished";
			outcome: Readonly<Record<string, unknown>> | null;
	  }
	| { kind: "transition"; from: TaskStatus; to: TaskStatus; reason?: string }
	| {
			kind: "event";
			type: RunEventType;
			data: Readonly<Record<string, unknown>> | undefined;
	  }
	| { kind: "artifact"; kind_: string; content: string; sha256: string }
	| {
			kind: "approvalRequested";
			action: string;
			payloadSha256: string;
			requestedBy: string;
			expiresAt: Date;
	  }
	| { kind: "approvalStatus"; approvalId: string };

class FakeLifecycle implements ExecutionLifecycle {
	calls: LifecycleCall[] = [];
	approval: LifecycleApprovalState | null = null;
	cancelled = false;
	/** Target statuses whose transition throws a stale-from conflict. */
	conflictOn: Set<TaskStatus> = new Set();
	approvalRequestedError: unknown = null;

	async transition(input: LifecycleTransitionInput): Promise<void> {
		this.calls.push({
			kind: "transition",
			from: input.from,
			to: input.to,
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
		if (this.conflictOn.has(input.to)) {
			// The wave-7 lifecycle contract calls this CONFLICT; the shared
			// ErrorCode vocabulary spells it DEPENDENCY_CONFLICT.
			throw new PlatformError("DEPENDENCY_CONFLICT", "stale transition");
		}
	}

	async event(input: LifecycleEventInput): Promise<void> {
		this.calls.push({ kind: "event", type: input.type, data: input.data });
	}

	async artifact(
		input: LifecycleArtifactInput,
	): Promise<{ artifactId: string }> {
		this.calls.push({
			kind: "artifact",
			kind_: input.kind,
			content: input.content,
			sha256: input.sha256,
		});
		return { artifactId: "artifact_1" };
	}

	async attemptStarted(): Promise<{
		attemptId: string;
		attemptIndex: number;
	}> {
		this.calls.push({ kind: "attemptStarted" });
		return { attemptId: "attempt_1", attemptIndex: 1 };
	}

	async attemptFinished(input: {
		attemptId: string;
		outcome: Readonly<Record<string, unknown>> | null;
	}): Promise<void> {
		this.calls.push({ kind: "attemptFinished", outcome: input.outcome });
	}

	async approvalRequested(input: {
		action: string;
		payloadSha256: string;
		requestedBy: string;
		expiresAt: Date;
	}): Promise<{ approvalId: string }> {
		if (this.approvalRequestedError !== null) {
			throw this.approvalRequestedError;
		}
		this.calls.push({
			kind: "approvalRequested",
			action: input.action,
			payloadSha256: input.payloadSha256,
			requestedBy: input.requestedBy,
			expiresAt: input.expiresAt,
		});
		return { approvalId: "approval_1" };
	}

	async approvalStatus(): Promise<LifecycleApprovalState | null> {
		this.calls.push({ kind: "approvalStatus", approvalId: "approval_1" });
		return this.approval;
	}

	async isCancelled(): Promise<boolean> {
		return this.cancelled;
	}
}

class FakeWorkspaceGit implements TaskWorkspaceGit {
	assertCalls = 0;
	cloneCalls: TaskWorkspaceCloneInput[] = [];
	branches: string[] = [];
	pushes: string[] = [];
	commits: TaskWorkspaceCommitInput[] = [];
	diffStatCalls: string[] = [];
	diffPatchCalls: string[] = [];
	diffStatResult: TaskDiffStat = {
		filesChanged: 1,
		insertions: 3,
		deletions: 2,
		files: ["src/widget.ts"],
	};
	patch = "diff --git a/src/widget.ts b/src/widget.ts\n+const x = 1;\n";
	truncated = false;
	cloneError: unknown = null;
	pushError: unknown = null;

	async assertToolchain(): Promise<void> {
		this.assertCalls += 1;
	}

	async cloneAndCheckout(
		input: TaskWorkspaceCloneInput,
	): Promise<TaskWorkspace> {
		this.cloneCalls.push(structuredClone(input));
		if (this.cloneError !== null) throw this.cloneError;
		return { path: input.targetPath, baseBranch: input.baseBranch };
	}

	async createBranch(_workspace: TaskWorkspace, branch: string): Promise<void> {
		this.branches.push(branch);
	}

	async commitAll(
		_workspace: TaskWorkspace,
		input: TaskWorkspaceCommitInput,
	): Promise<{ commitSha: string }> {
		this.commits.push(input);
		return { commitSha: "a".repeat(40) };
	}

	async diffStat(
		_workspace: TaskWorkspace,
		baseBranch: string,
	): Promise<TaskDiffStat> {
		this.diffStatCalls.push(baseBranch);
		return this.diffStatResult;
	}

	async diffPatch(
		_workspace: TaskWorkspace,
		baseBranch: string,
	): Promise<{ patch: string; truncated: boolean }> {
		this.diffPatchCalls.push(baseBranch);
		return { patch: this.patch, truncated: this.truncated };
	}

	async pushBranch(_workspace: TaskWorkspace, branch: string): Promise<void> {
		this.pushes.push(branch);
		if (this.pushError !== null) throw this.pushError;
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
	priceTable?: TaskExecutionDeps["priceTable"];
	script?: ScriptTurn[];
	runtime?: RuntimeScript;
	provider?: FakeProvider;
	sink?: FakeUsageSink;
	loadError?: unknown;
	clock?: FakeClock;
	lifecycle?: FakeLifecycle;
	workspaceGit?: FakeWorkspaceGit;
	workspaceGitFactory?: (input: {
		provider: SandboxProvider;
		sandbox: SandboxHandle;
		signal?: AbortSignal;
	}) => FakeWorkspaceGit;
	pushEnabled?: boolean;
	job?: JobRow;
	handlerType?: "run_task" | "resume_task";
	/** Wave 8: `undefined` leaves the seam unbound (skipped), `null` explicit. */
	validationPolicy?: { command: string; timeoutMs: number } | null;
	/** Wave 9: `undefined` leaves the seam unbound (no checks declared). */
	acceptanceChecks?: readonly AcceptanceCheck[] | null;
	/** Wave 9: read surface the acceptance verifier uses. */
	sandboxBackend?: SandboxToolBackend;
	/** Wave 9: tool-invocation sink. */
	recordToolInvocation?: TaskExecutionDeps["recordToolInvocation"];
	/** Wave 9: per-repository+branch lock seam. */
	acquireBranchLock?: TaskExecutionDeps["acquireBranchLock"];
	/** Trusted policy used for the PR head-SHA read (`git rev-parse HEAD`). */
	sandboxPolicy?: CommandPolicy;
	executeHandler?: (command: unknown) => CommandResult;
};

function makeHarness(options: HarnessOptions = {}) {
	const clock = options.clock ?? new FakeClock();
	const logs: LogRecord[] = [];
	const logger = makeFakeLogger(logs);
	const provider = options.provider ?? new FakeProvider();
	if (options.executeHandler !== undefined) {
		provider.executeHandler = options.executeHandler;
	}
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

	const workspaceGit = options.workspaceGit;
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
		sandboxPolicy: options.sandboxPolicy ?? POLICY,
		sandbox: {
			cpuCount: 1,
			memoryMb: 512,
			lifetimeMs: 900_000,
			idleTimeoutMs: 300_000,
			...options.sandbox,
		},
		maxSandboxSeconds: options.maxSandboxSeconds ?? 120,
		maxCostUsdPerTask: options.maxCostUsdPerTask ?? 1,
		priceTable:
			options.priceTable === undefined
				? { models: [], sandbox: { cpuSecondUsd: 0.5, gibSecondUsd: 0.25 } }
				: options.priceTable,
		now: clock.now,
		...(options.lifecycle === undefined
			? {}
			: { lifecycle: options.lifecycle }),
		...(options.validationPolicy === undefined
			? {}
			: {
					loadValidationPolicy: async () => options.validationPolicy ?? null,
				}),
		...(options.acceptanceChecks === undefined
			? {}
			: {
					loadAcceptanceChecks: async () => options.acceptanceChecks ?? null,
				}),
		...(options.recordToolInvocation === undefined
			? {}
			: { recordToolInvocation: options.recordToolInvocation }),
		...(options.acquireBranchLock === undefined
			? {}
			: { acquireBranchLock: options.acquireBranchLock }),
		...(options.sandboxBackend === undefined
			? {}
			: {
					createSandboxBackend: () =>
						options.sandboxBackend as SandboxToolBackend,
				}),
		...(options.workspaceGitFactory === undefined
			? workspaceGit === undefined
				? {}
				: { createWorkspaceGit: (() => workspaceGit) as CreateTaskWorkspaceGit }
			: { createWorkspaceGit: options.workspaceGitFactory }),
		pushEnabled: options.pushEnabled ?? false,
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
		handler:
			options.handlerType === "resume_task"
				? createResumeTaskHandler(deps)
				: createTaskExecutionHandler(deps),
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
		job: options.job ?? makeJob(),
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
			// The configured 300s idle window is clamped to the lifetime so the
			// adapter default (300s) can never exceed it.
			idleTimeoutMs: 120_000,
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

	test("a SandboxError from provisioning maps to a bounded adapter code", async () => {
		const provider = new FakeProvider();
		provider.createError = new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"modal unavailable",
		);
		const harness = makeHarness({ provider });
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "retry",
			code: "INTEGRATION_UNAVAILABLE",
		});
		expect(provider.createCalls).toHaveLength(1);
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

	test("turn cap exhausted after a produced diff → review_ready, not BUDGET_EXCEEDED", async () => {
		// Muse Spark ends a productive turn with a summary instead of the empty
		// sentinel; the work must not be discarded when only the TURN budget ran out.
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 2 } },
			script: [{ output: "summary one" }, { output: "summary two" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("complete");
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
		expect(eventTypes(lifecycle)).toContain("validation.finished");
		expect(harness.runtime.runTurns).toEqual([1, 2]);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("turn cap exhausted with an empty diff still fails closed", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		workspace.diffStatResult = {
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			files: [],
		};
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			context: { limits: { ...DEFAULT_CONTEXT.limits, max_agent_turns: 1 } },
			script: [{ output: "summary only" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "BUDGET_EXCEEDED",
			note: "agent turn budget exhausted",
		});
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
			priceTable: {
				models: [],
				sandbox: { cpuSecondUsd: 0.5, gibSecondUsd: 0.25 },
			},
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

/* ------------------------------ wave 7: lifecycle --------------------------- */

const APPROVAL_SHA = pushApprovalPayloadSha256(
	DEFAULT_CONTEXT.repoUrl,
	DEFAULT_CONTEXT.isolatedBranch,
);

function makeResumeJob(overrides: Partial<JobRow> = {}): JobRow {
	return makeJob({
		// `resume_task` is a wave-7 worker job type; the db `JobType` union is
		// owned by the DB lane and is widened there.
		type: "resume_task" as JobRow["type"],
		payload: { taskId: TASK_UUID, approvalId: "approval_1" },
		...overrides,
	});
}

function transitionPairs(
	lifecycle: FakeLifecycle,
): Array<[TaskStatus, TaskStatus]> {
	const pairs: Array<[TaskStatus, TaskStatus]> = [];
	for (const call of lifecycle.calls) {
		if (call.kind === "transition") pairs.push([call.from, call.to]);
	}
	return pairs;
}

function eventTypes(lifecycle: FakeLifecycle): RunEventType[] {
	const types: RunEventType[] = [];
	for (const call of lifecycle.calls) {
		if (call.kind === "event") types.push(call.type);
	}
	return types;
}

function kindIndex(lifecycle: FakeLifecycle, kind: LifecycleCall["kind"]) {
	return lifecycle.calls.findIndex((call) => call.kind === kind);
}

function lastAttemptOutcome(lifecycle: FakeLifecycle) {
	for (let index = lifecycle.calls.length - 1; index >= 0; index--) {
		const call = lifecycle.calls[index];
		if (call?.kind === "attemptFinished") return call.outcome;
	}
	return undefined;
}

describe("task execution handler — wave 7 approval gate", () => {
	test("push-enabled run_task pauses before any sandbox or clone exists", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({ outcome: "complete", note: "awaiting approval" });
		// No sandbox, no clone, no spend.
		expect(harness.provider.createCalls).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(0);
		expect(workspace.assertCalls).toBe(0);
		expect(workspace.cloneCalls).toHaveLength(0);
		expect(harness.sink.rows).toHaveLength(0);

		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["planning", "awaiting_approval"],
		]);

		const requested = lifecycle.calls.find(
			(call) => call.kind === "approvalRequested",
		);
		expect(requested).toMatchObject({
			action: "git.push_branch",
			payloadSha256: APPROVAL_SHA,
			requestedBy: "worker",
		});
		if (requested?.kind === "approvalRequested") {
			expect(requested.expiresAt.getTime()).toBe(
				harness.clock.current + 24 * 60 * 60 * 1000,
			);
		}
		// Ordering: attempt starts, the task enters planning, then the approval
		// is requested and announced.
		const kinds = lifecycle.calls.map((call) => call.kind);
		expect(kinds.indexOf("attemptStarted")).toBeLessThan(
			kinds.indexOf("approvalRequested"),
		);
		expect(kinds.lastIndexOf("transition")).toBeLessThan(
			lifecycle.calls.findIndex(
				(call) => call.kind === "event" && call.type === "approval.requested",
			),
		);
		const approvalEvent = lifecycle.calls.find(
			(call) => call.kind === "event" && call.type === "approval.requested",
		);
		expect(approvalEvent).toMatchObject({
			data: { action: "git.push_branch", payloadSha256: APPROVAL_SHA },
		});
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "awaiting_approval",
			approvalId: "approval_1",
		});
	});

	test("an existing pending approval is idempotent success", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approvalRequestedError = new PlatformError(
			"DEPENDENCY_CONFLICT",
			"pending approval already exists",
		);
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			pushEnabled: true,
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({ outcome: "complete", note: "awaiting approval" });
		expect(harness.provider.createCalls).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toContainEqual([
			"planning",
			"awaiting_approval",
		]);
		expect(eventTypes(lifecycle)).toEqual(["approval.requested"]);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "awaiting_approval",
		});
	});

	test("run_task without push enabled never requests an approval", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "" }],
		});
		await harness.handler.handle(harness.job, harness.ctx);
		expect(kindIndex(lifecycle, "approvalRequested")).toBe(-1);
		expect(eventTypes(lifecycle)).not.toContain("approval.requested");
		expect(harness.provider.createCalls).toHaveLength(1);
	});
});

describe("task execution handler — wave 7 execution flow", () => {
	test("clones, runs bounded turns, stores a diff artifact and reaches review_ready", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		let factoryInput:
			| {
					sandbox: SandboxHandle;
					baseBranch?: string;
					repoPath?: string;
			  }
			| undefined;
		const harness = makeHarness({
			lifecycle,
			script: [{ output: "working" }, { output: "" }],
			workspaceGitFactory: (input) => {
				factoryInput = input;
				return workspace;
			},
		});
		let toolContext: { fileOwnership?: readonly string[] } | undefined;
		let backendInput: { baseBranch?: string; repoPath?: string } | undefined;
		harness.deps.createSandboxBackend = (input) => {
			backendInput = input;
			return {
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
		};
		const original = harness.deps.createRuntime;
		harness.deps.createRuntime = (options) => {
			toolContext = options.toolContext;
			return original(options);
		};

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "complete",
			note: "agent reported no further work",
		});
		expect(factoryInput?.sandbox).toEqual({
			id: "sbx_1",
			workspaceRoot: POLICY.workspaceRoot,
		});
		expect(workspace.assertCalls).toBe(1);
		expect(workspace.cloneCalls).toEqual([
			{
				repoUrl: DEFAULT_CONTEXT.repoUrl,
				baseBranch: DEFAULT_CONTEXT.baseBranch,
				targetPath: `${POLICY.workspaceRoot}/repo`,
			},
		]);
		expect(workspace.branches).toEqual([DEFAULT_CONTEXT.isolatedBranch]);
		expect(workspace.diffStatCalls).toEqual([DEFAULT_CONTEXT.baseBranch]);
		expect(workspace.diffPatchCalls).toEqual([DEFAULT_CONTEXT.baseBranch]);

		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["planning", "executing"],
			["executing", "validating"],
			["validating", "review_ready"],
		]);
		expect(eventTypes(lifecycle)).toEqual([
			"workspace.cloned",
			"agent.turn_started",
			"agent.turn_finished",
			"agent.turn_started",
			"agent.turn_finished",
			// No validation command configured: the command gate is recorded as
			// skipped, then the wave-7 diff gate finishes as before.
			"validation.finished",
			"validation.finished",
			"artifact.created",
		]);
		const validationEvents = lifecycle.calls.filter(
			(call) => call.kind === "event" && call.type === "validation.finished",
		);
		expect(validationEvents).toMatchObject([
			{ data: { stage: "command", status: "skipped" } },
			{ data: { stage: "diff", filesChanged: 1 } },
		]);

		const artifact = lifecycle.calls.find((call) => call.kind === "artifact");
		expect(artifact).toMatchObject({
			kind_: "diff",
			content: workspace.patch,
			sha256: new Bun.CryptoHasher("sha256")
				.update(workspace.patch)
				.digest("hex"),
		});
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "review_ready",
			filesChanged: 1,
			insertions: 3,
			deletions: 2,
			// Wave 9: no checks and no command — explicitly the diff-only fallback.
			completion: "diff-only",
			// Wave 11: measured sandbox time (frozen clock -> 0s).
			sandboxSeconds: 0,
		});

		// Clone/push need GitHub egress; tool calls still authorize deny.
		expect(harness.provider.createCalls[0]?.egress).toEqual({
			mode: "allowlist",
			hosts: ["github.com", "codeload.github.com"],
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(toolContext?.fileOwnership).toEqual(DEFAULT_CONTEXT.fileOwnership);
		expect(backendInput).toMatchObject({
			baseBranch: DEFAULT_CONTEXT.baseBranch,
			repoPath: `${POLICY.workspaceRoot}/repo`,
		});
	});

	test("a stale queued→planning conflict is treated as already started", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.conflictOn = new Set<TaskStatus>(["planning"]);
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("complete");
		expect(harness.provider.createCalls).toHaveLength(1);
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
	});

	test("an empty diff fails the task with a bounded verdict before validation", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		workspace.diffStatResult = {
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			files: [],
		};
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "empty diff",
		});
		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["planning", "executing"],
			["executing", "failed"],
		]);
		expect(workspace.diffPatchCalls).toHaveLength(0);
		expect(kindIndex(lifecycle, "artifact")).toBe(-1);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "failed",
			reason: "empty diff",
			sandboxSeconds: 0,
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("cancellation before the next turn stops, records cancelled and tears down once", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			script: [
				{ output: "working", onTurn: () => (lifecycle.cancelled = true) },
				{ output: "never" },
			],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({ outcome: "complete", note: "task cancelled" });
		expect(harness.runtime.runTurns).toEqual([1]);
		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["planning", "executing"],
			["executing", "cancelled"],
		]);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "cancelled",
			sandboxSeconds: 0,
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("a cancelled task is not provisioned at all", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.cancelled = true;
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "complete", note: "task cancelled" });
		expect(harness.provider.createCalls).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["planning", "cancelled"],
		]);
	});

	test("a clone failure maps to a bounded verdict with exactly-once teardown", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		workspace.cloneError = new PlatformError(
			"GIT_OPERATION_FAILED",
			"clone failed at https://user:token@github.com/acme/widget.git",
		);
		const harness = makeHarness({ lifecycle, workspaceGit: workspace });
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "GIT_OPERATION_FAILED",
			note: "clone failed at [url]",
		});
		expect(JSON.stringify(verdict)).not.toContain("token");
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(harness.runtime.runTurns).toHaveLength(0);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "failed",
			sandboxSeconds: 0,
		});
	});

	test("emits no turn summaries or credentials through lifecycle records", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "" }],
		});
		await harness.handler.handle(harness.job, harness.ctx);
		const serialized = JSON.stringify(lifecycle.calls);
		expect(serialized).not.toContain("SECRET");
		expect(serialized).not.toContain("token@host");
		// The patch is stored as artifact content only, never in an event.
		for (const call of lifecycle.calls) {
			if (call.kind === "event") {
				expect(JSON.stringify(call.data)).not.toContain("diff --git");
			}
		}
		expect(JSON.stringify(harness.logs)).not.toContain("SECRET");
	});
});

describe("task execution handler — wave 7 resume", () => {
	test("supports() requires a bounded approvalId for resume jobs", () => {
		const harness = makeHarness({ handlerType: "resume_task" });
		expect(harness.handler.jobType).toBe("resume_task");
		expect(
			harness.handler.supports({ taskId: TASK_UUID, approvalId: "approval_1" }),
		).toBe(true);
		expect(harness.handler.supports({ taskId: TASK_UUID })).toBe(false);
		expect(
			harness.handler.supports({ taskId: TASK_UUID, approvalId: "bad id!" }),
		).toBe(false);
		expect(
			harness.handler.supports({
				taskId: TASK_UUID,
				approvalId: "x".repeat(200),
			}),
		).toBe(false);
		expect(
			harness.handler.supports({
				taskId: "not-a-uuid",
				approvalId: "approval_1",
			}),
		).toBe(false);
	});

	test("an approved resume with the matching SHA executes and pushes once", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "complete",
			note: "agent reported no further work",
		});
		expect(kindIndex(lifecycle, "approvalStatus")).toBeGreaterThanOrEqual(0);
		expect(transitionPairs(lifecycle)).toEqual([
			["queued", "planning"],
			["awaiting_approval", "executing"],
			["executing", "validating"],
			["validating", "review_ready"],
		]);
		expect(workspace.pushes).toEqual([DEFAULT_CONTEXT.isolatedBranch]);
		expect(harness.provider.createCalls).toHaveLength(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
		});
	});

	test("an approved resume without push enabled stores the artifact but does not push", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			handlerType: "resume_task",
			job: makeResumeJob(),
			script: [{ output: "" }],
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("complete");
		expect(workspace.pushes).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
	});

	for (const [status, code] of [
		["rejected", "APPROVAL_REJECTED"],
		["expired", "APPROVAL_EXPIRED"],
		["pending", "APPROVAL_REQUIRED"],
	] as const) {
		test(`a ${status} approval fails the task without provisioning`, async () => {
			const lifecycle = new FakeLifecycle();
			lifecycle.approval = { status, payloadSha256: APPROVAL_SHA };
			const harness = makeHarness({
				lifecycle,
				workspaceGit: new FakeWorkspaceGit(),
				handlerType: "resume_task",
				job: makeResumeJob(),
			});

			const verdict = await harness.handler.handle(harness.job, harness.ctx);

			expect(verdict).toEqual({
				outcome: "dead_letter",
				code,
				note: `approval ${status}`,
			});
			expect(transitionPairs(lifecycle)).toContainEqual([
				"awaiting_approval",
				"failed",
			]);
			expect(harness.provider.createCalls).toHaveLength(0);
			expect(lastAttemptOutcome(lifecycle)).toMatchObject({ status: "failed" });
		});
	}

	test("a mismatched approval SHA is a bounded conflict and provisions nothing", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = {
			status: "approved",
			payloadSha256: "deadbeef".repeat(8),
		};
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "DEPENDENCY_CONFLICT",
			note: "approval payload mismatch",
		});
		expect(transitionPairs(lifecycle)).toContainEqual([
			"awaiting_approval",
			"failed",
		]);
		expect(harness.provider.createCalls).toHaveLength(0);
	});

	test("a missing approval record fails closed", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			handlerType: "resume_task",
			job: makeResumeJob(),
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "NOT_FOUND",
			note: "approval not found",
		});
		expect(harness.provider.createCalls).toHaveLength(0);
	});

	test("a resume payload without an approvalId is rejected before any work", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			handlerType: "resume_task",
			job: makeResumeJob({ payload: { taskId: TASK_UUID } }),
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "job payload rejected by handler",
		});
		expect(lifecycle.calls).toHaveLength(0);
		expect(harness.provider.createCalls).toHaveLength(0);
	});
});

describe("task execution handler — wave 7 push failure", () => {
	test("a push failure lands at failed with a bounded verdict", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		workspace.pushError = new PlatformError(
			"GIT_OPERATION_FAILED",
			"push rejected",
		);
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "GIT_OPERATION_FAILED",
			note: "push failed",
		});
		expect(transitionPairs(lifecycle)).toContainEqual([
			"review_ready",
			"failed",
		]);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "failed",
			reason: "push failed",
			sandboxSeconds: 0,
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});
});

/* ------------------------------ wave 8: validation -------------------------- */

const VALIDATION_POLICY = { command: "bun test", timeoutMs: 30_000 };
const PUSHED_SHA = "b".repeat(40);

/** Trusted policy that authorizes only the PR head-SHA probe. */
const WORKSPACE_POLICY: CommandPolicy = {
	workspaceRoot: POLICY.workspaceRoot,
	allowlist: [
		{
			executable: "git",
			args: [
				{ kind: "literal", value: "rev-parse" },
				{ kind: "literal", value: "HEAD" },
			],
		},
	],
	maxTimeoutMs: 60_000,
	maxOutputBytes: 1_048_576,
	egress: { mode: "deny" },
};

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
	return {
		exitCode: 0,
		stdout: "tests ok\n",
		stderr: "",
		durationMs: 5,
		timedOut: false,
		outputLimitExceeded: false,
		...overrides,
	};
}

function commandArgv(command: unknown): {
	executable?: string;
	args?: readonly string[];
} {
	return command as { executable?: string; args?: readonly string[] };
}

function artifactsOf(lifecycle: FakeLifecycle) {
	return lifecycle.calls.filter(
		(call): call is Extract<LifecycleCall, { kind: "artifact" }> =>
			call.kind === "artifact",
	);
}

describe("task execution handler — wave 8 validation gate", () => {
	test("a passing command runs in the same sandbox and stores a log artifact", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			script: [{ output: "" }],
			validationPolicy: VALIDATION_POLICY,
			executeHandler: () => commandResult(),
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(workspace.pushes).toHaveLength(0);
		expect(harness.provider.executeCalls).toHaveLength(1);
		expect(harness.provider.executeCalls[0]).toEqual({
			id: "sbx_1",
			workspaceRoot: POLICY.workspaceRoot,
		});
		const command = commandArgv(harness.provider.executeCommands[0]);
		expect(command.executable).toBe("bun");
		expect(command.args).toEqual(["test"]);

		const artifacts = artifactsOf(lifecycle);
		expect(artifacts.map((artifact) => artifact.kind_)).toEqual([
			"log_bundle",
			"diff",
		]);
		expect(artifacts[0]?.content).toBe("tests ok\n");

		const commandFinished = lifecycle.calls.find(
			(call) =>
				call.kind === "event" &&
				call.type === "validation.finished" &&
				call.data?.stage === "command",
		);
		expect(commandFinished).toMatchObject({
			data: {
				stage: "command",
				status: "passed",
				exitCode: 0,
				outputBytes: 9,
				argvLength: 2,
				truncated: false,
			},
		});
		// The event never carries the command text or its arguments.
		expect(JSON.stringify(commandFinished)).not.toContain("bun test");
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
			completion: "validation",
			validation: { status: "passed", argv: ["bun", "test"] },
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("no configured command records a skipped gate and keeps wave-7 behaviour", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			validationPolicy: null,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(harness.provider.executeCalls).toHaveLength(0);
		expect(eventTypes(lifecycle)).toContain("validation.finished");
		const skipped = lifecycle.calls.find(
			(call) =>
				call.kind === "event" &&
				call.type === "validation.finished" &&
				call.data?.stage === "command",
		);
		expect(skipped).toMatchObject({
			data: { stage: "command", status: "skipped" },
		});
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("a failing command fails the task with no push and no diff artifact", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			validationPolicy: VALIDATION_POLICY,
			executeHandler: () =>
				commandResult({ exitCode: 1, stdout: "2 tests failed\n" }),
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "validation failed",
		});
		expect(workspace.pushes).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toContainEqual(["validating", "failed"]);
		expect(transitionPairs(lifecycle)).not.toContainEqual([
			"validating",
			"review_ready",
		]);
		expect(artifactsOf(lifecycle).map((artifact) => artifact.kind_)).toEqual([
			"log_bundle",
		]);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "failed",
			reason: "validation failed",
			validation: { status: "failed", exitCode: 1 },
		});
		// Only the validation command ran; the head-SHA probe was never reached.
		expect(harness.provider.executeCalls).toHaveLength(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("an invalid configured command is a terminal POLICY_DENIED before execution", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			validationPolicy: {
				command: "bun test; rm -rf /",
				timeoutMs: 30_000,
			},
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "POLICY_DENIED",
			note: "validation command denied",
		});
		// The runner refuses before the provider is called.
		expect(harness.provider.executeCalls).toHaveLength(0);
		expect(workspace.pushes).toHaveLength(0);
		expect(artifactsOf(lifecycle)).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toContainEqual(["validating", "failed"]);
		expect(lastAttemptOutcome(lifecycle)).toEqual({
			status: "failed",
			reason: "validation command denied",
			error: "POLICY_DENIED",
			sandboxSeconds: 0,
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("validation output is clipped to the inline log cap", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			validationPolicy: VALIDATION_POLICY,
			executeHandler: () => commandResult({ stdout: "x".repeat(100_000) }),
			script: [{ output: "" }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		const log = artifactsOf(lifecycle)[0];
		expect(log?.kind_).toBe("log_bundle");
		expect(Buffer.byteLength(log?.content ?? "", "utf8")).toBe(65_536);
		const commandFinished = lifecycle.calls.find(
			(call) =>
				call.kind === "event" &&
				call.type === "validation.finished" &&
				call.data?.stage === "command",
		);
		expect(commandFinished).toMatchObject({
			data: { truncated: true, outputBytes: 65_536 },
		});
	});
});

/* --------------------------- wave 8: pull request gate ---------------------- */

describe("task execution handler — wave 8 pull request approval", () => {
	test("a successful push requests the second approval bound to the pushed commit", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			sandboxPolicy: WORKSPACE_POLICY,
			executeHandler: (command) => {
				const argv = commandArgv(command);
				if (
					argv.executable === "git" &&
					argv.args?.join(" ") === "rev-parse HEAD"
				) {
					return commandResult({ stdout: `${PUSHED_SHA}\n` });
				}
				throw new Error("unexpected command");
			},
			script: [{ output: "" }],
		});
		const expectedSha = await pullRequestApprovalPayloadSha256({
			repositoryFullName: "acme/widget",
			headBranch: DEFAULT_CONTEXT.isolatedBranch,
			baseBranch: DEFAULT_CONTEXT.baseBranch,
			headSha: PUSHED_SHA,
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "complete",
			note: "awaiting pull request approval",
		});
		expect(workspace.pushes).toEqual([DEFAULT_CONTEXT.isolatedBranch]);
		const requested = lifecycle.calls.filter(
			(call) => call.kind === "approvalRequested",
		);
		expect(requested).toHaveLength(1);
		expect(requested[0]).toMatchObject({
			action: "github.create_pull_request",
			payloadSha256: expectedSha,
			requestedBy: "worker",
		});
		const approvalEvent = lifecycle.calls.find(
			(call) => call.kind === "event" && call.type === "approval.requested",
		);
		expect(approvalEvent).toMatchObject({
			data: {
				action: "github.create_pull_request",
				payload: {
					repositoryFullName: "acme/widget",
					headBranch: DEFAULT_CONTEXT.isolatedBranch,
					baseBranch: DEFAULT_CONTEXT.baseBranch,
					headSha: PUSHED_SHA,
				},
				payloadSha256: expectedSha,
			},
		});
		expect(transitionPairs(lifecycle)).toContainEqual([
			"review_ready",
			"awaiting_approval",
		]);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "awaiting_approval",
			action: "github.create_pull_request",
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
		// The approval payload is bounded identifiers only; no credential text.
		expect(JSON.stringify(lifecycle.calls)).not.toContain("token");
		expect(JSON.stringify(harness.logs)).not.toContain("token");
	});

	test("when the pushed head SHA cannot be read the task stays review_ready", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			sandboxPolicy: WORKSPACE_POLICY,
			// Default fake output is not a git SHA.
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "complete",
			note: "agent reported no further work",
		});
		expect(workspace.pushes).toEqual([DEFAULT_CONTEXT.isolatedBranch]);
		expect(
			lifecycle.calls.some((call) => call.kind === "approvalRequested"),
		).toBe(false);
		expect(eventTypes(lifecycle)).not.toContain("approval.requested");
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
		});
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});
});

/* ------------------------ wave 9: acceptance completion -------------------- */

function acceptanceBackend(files: Record<string, string>): SandboxToolBackend {
	return {
		async readFile(path) {
			const content = files[path];
			if (content === undefined) {
				throw new PlatformError("NOT_FOUND", "file could not be read");
			}
			return { content, truncated: false };
		},
		async listFiles() {
			return [];
		},
		async search() {
			return [];
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
		async git() {
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				durationMs: 0,
				truncated: false,
			};
		},
	};
}

const PASSING_CHECKS: readonly AcceptanceCheck[] = [
	{ kind: "path_exists", path: "LIVE_ACCEPTANCE.md" },
	{
		kind: "content_matches",
		path: "LIVE_ACCEPTANCE.md",
		pattern: "done",
	},
];

function acceptanceFinished(lifecycle: FakeLifecycle) {
	for (let index = lifecycle.calls.length - 1; index >= 0; index--) {
		const call = lifecycle.calls[index];
		if (call?.kind === "event" && call.type === "acceptance.finished") {
			return call.data;
		}
	}
	return undefined;
}

describe("task execution handler — wave 9 acceptance completion", () => {
	test("passing checks plus a passing command complete with an acceptance report", async () => {
		const lifecycle = new FakeLifecycle();
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			sandboxBackend: acceptanceBackend({
				"LIVE_ACCEPTANCE.md": "all done\n",
			}),
			acceptanceChecks: PASSING_CHECKS,
			validationPolicy: { command: "bun test live.test.ts", timeoutMs: 30_000 },
			executeHandler: () => commandResult(),
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(transitionPairs(lifecycle)).toContainEqual([
			"validating",
			"review_ready",
		]);
		// Acceptance events wrap the checks; the command gate still ran.
		const acceptanceStarted =
			eventTypes(lifecycle).indexOf("acceptance.started");
		const acceptanceDone = eventTypes(lifecycle).indexOf("acceptance.finished");
		expect(acceptanceStarted).toBeGreaterThanOrEqual(0);
		expect(acceptanceDone).toBeGreaterThan(acceptanceStarted);
		const report = acceptanceFinished(lifecycle) as {
			passed: boolean;
			matched: number;
			total: number;
		};
		expect(report).toMatchObject({ passed: true, matched: 2, total: 2 });
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
			completion: "acceptance",
			acceptance: { passed: true, matched: 2, total: 2 },
			validation: { status: "passed" },
		});
		const kinds = artifactsOf(lifecycle).map((artifact) => artifact.kind_);
		expect(kinds).toEqual(["report", "log_bundle", "diff"]);
		const reportArtifact = artifactsOf(lifecycle)[0];
		expect(reportArtifact?.content).toContain('"passed":true');
		expect(reportArtifact?.content).not.toContain("all done");
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("a failing check fails the task, stores the report and never pushes", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			sandboxBackend: acceptanceBackend({}),
			acceptanceChecks: PASSING_CHECKS,
			validationPolicy: VALIDATION_POLICY,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "acceptance failed",
		});
		expect(workspace.pushes).toHaveLength(0);
		expect(transitionPairs(lifecycle)).toContainEqual(["validating", "failed"]);
		expect(transitionPairs(lifecycle)).not.toContainEqual([
			"validating",
			"review_ready",
		]);
		expect(acceptanceFinished(lifecycle)).toMatchObject({
			passed: false,
			matched: 0,
			total: 2,
		});
		expect(artifactsOf(lifecycle).map((artifact) => artifact.kind_)).toEqual([
			"report",
		]);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "failed",
			reason: "acceptance failed",
			acceptance: { passed: false },
		});
		// The validation command never ran: the checks failed first.
		expect(harness.provider.executeCalls).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("checks alone gate completion when no validation command is configured", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			sandboxBackend: acceptanceBackend({
				"LIVE_ACCEPTANCE.md": "done",
			}),
			acceptanceChecks: PASSING_CHECKS,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(eventTypes(lifecycle)).toContain("validation.finished");
		expect(harness.provider.executeCalls).toHaveLength(0);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
			completion: "acceptance",
		});
	});

	test("a malformed persisted check fails closed with a bounded report", async () => {
		const lifecycle = new FakeLifecycle();
		lifecycle.approval = { status: "approved", payloadSha256: APPROVAL_SHA };
		const workspace = new FakeWorkspaceGit();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			pushEnabled: true,
			handlerType: "resume_task",
			job: makeResumeJob(),
			// Not a member of the discriminated union: refused before any read.
			acceptanceChecks: [
				{
					kind: "command_exit_zero",
					command: "",
				} as unknown as AcceptanceCheck,
			],
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "invalid acceptance checks",
		});
		expect(acceptanceFinished(lifecycle)).toMatchObject({
			passed: false,
			matched: 0,
			total: 1,
			checks: [],
		});
		expect(workspace.pushes).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("without checks or a command the attempt records diff-only completion", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "" }],
		});
		await harness.handler.handle(harness.job, harness.ctx);
		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
			completion: "diff-only",
		});
	});
});

/* -------------------------- wave 9: tool audit ----------------------------- */

describe("task execution handler — wave 9 tool invocation audit", () => {
	test("executed and denied decisions reach the injected sink without payloads", async () => {
		const lifecycle = new FakeLifecycle();
		const rows: Array<Record<string, unknown>> = [];
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			recordToolInvocation: (input) => {
				rows.push({ ...input });
			},
			// A runtime that drives the audit hook the factory forwards.
			runtime: {
				factory: (options) => ({
					id: "audit-runtime",
					name: "Audit Runtime",
					async runTurn() {
						const hook = (
							options as {
								onToolDecision?: (record: ToolDecisionRecord) => Promise<void>;
							}
						).onToolDecision;
						await hook?.({
							tool: "repo.read_file",
							taskId: TASK_UUID,
							organizationId: ORG_ID,
							outcome: "executed",
							reason: null,
							argumentsSha256: "a".repeat(64),
							durationMs: 12,
						});
						await hook?.({
							tool: "git.push_branch",
							taskId: TASK_UUID,
							organizationId: ORG_ID,
							outcome: "denied",
							reason: "APPROVAL_REQUIRED",
							argumentsSha256: "b".repeat(64),
							durationMs: 3,
						});
						return "";
					},
				}),
				runTurns: [1],
				prompts: [],
			},
			script: [{ output: "" }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		expect(rows).toEqual([
			{
				organizationId: ORG_ID,
				taskId: TASK_ID,
				workflowRunId: null,
				toolName: "repo.read_file",
				outcome: "executed",
				denialReason: null,
				argumentsSha256: "a".repeat(64),
				durationMs: 12,
			},
			{
				organizationId: ORG_ID,
				taskId: TASK_ID,
				workflowRunId: null,
				toolName: "git.push_branch",
				outcome: "denied",
				denialReason: "APPROVAL_REQUIRED",
				argumentsSha256: "b".repeat(64),
				durationMs: 3,
			},
		]);
		expect(JSON.stringify(lifecycle.calls)).not.toContain("a".repeat(64));
	});

	test("a failing audit sink is logged bounded and never changes the verdict", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			recordToolInvocation: () => {
				throw new PlatformError("DB_UNAVAILABLE", "audit store down");
			},
			runtime: {
				factory: (options) => ({
					id: "audit-runtime",
					name: "Audit Runtime",
					async runTurn() {
						const hook = (
							options as {
								onToolDecision?: (record: ToolDecisionRecord) => Promise<void>;
							}
						).onToolDecision;
						await hook?.({
							tool: "repo.read_file",
							taskId: TASK_UUID,
							organizationId: ORG_ID,
							outcome: "executed",
							reason: null,
						});
						return "";
					},
				}),
				runTurns: [1],
				prompts: [],
			},
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(
			harness.logs.some(
				(log) => log.message === "tool invocation not recorded",
			),
		).toBe(true);
		expect(JSON.stringify(harness.logs)).not.toContain("audit store down");
	});
});

/* --------------------------- wave 9: branch lock --------------------------- */

function fakeLock() {
	const leases: Array<{ releases: number }> = [];
	const releases: string[] = [];
	return {
		acquireBranchLock: async () => {
			if (leases.length > 0) return null;
			const lease = { releases: 0 };
			leases.push(lease);
			return {
				release: () => {
					lease.releases += 1;
					releases.push("release");
				},
			};
		},
		leases,
		releases,
	};
}

describe("task execution handler — wave 9 branch lock", () => {
	test("acquires before provisioning and releases once after the run", async () => {
		const lifecycle = new FakeLifecycle();
		const lock = fakeLock();
		const calls: Array<Record<string, string>> = [];
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			acquireBranchLock: (input) => {
				calls.push({ ...input });
				return lock.acquireBranchLock();
			},
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(calls).toEqual([
			{
				organizationId: ORG_ID,
				repositoryId: DEFAULT_CONTEXT.repoUrl,
				branch: DEFAULT_CONTEXT.isolatedBranch,
			},
		]);
		expect(lock.releases).toEqual(["release"]);
		expect(lock.leases[0]?.releases).toBe(1);
		expect(harness.provider.createCalls).toHaveLength(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("a lock miss returns a bounded retry and provisions nothing", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			acquireBranchLock: async () => null,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "retry",
			code: "DEPENDENCY_CONFLICT",
			backoffMs: expect.any(Number),
		});
		expect(harness.provider.createCalls).toHaveLength(0);
		expect(harness.provider.destroyCalls).toHaveLength(0);
		expect(lifecycle.calls).toHaveLength(0);
	});

	test("releases exactly once on a failure path and still tears down once", async () => {
		const lifecycle = new FakeLifecycle();
		const lock = fakeLock();
		const workspace = new FakeWorkspaceGit();
		workspace.diffStatResult = {
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			files: [],
		};
		const harness = makeHarness({
			lifecycle,
			workspaceGit: workspace,
			acquireBranchLock: lock.acquireBranchLock,
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "empty diff",
		});
		expect(lock.releases).toEqual(["release"]);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("releases exactly once when a turn throws after provisioning", async () => {
		const lifecycle = new FakeLifecycle();
		const lock = fakeLock();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			acquireBranchLock: lock.acquireBranchLock,
			script: [
				{
					output: "",
					throwError: new PlatformError("DB_UNAVAILABLE", "db down"),
				},
			],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({
			outcome: "retry",
			code: "DB_UNAVAILABLE",
		});
		expect(lock.releases).toEqual(["release"]);
		expect(lock.leases[0]?.releases).toBe(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("releases exactly once when the lease is lost mid-run", async () => {
		const lifecycle = new FakeLifecycle();
		const lock = fakeLock();
		let abortRun: () => void = () => {};
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			acquireBranchLock: lock.acquireBranchLock,
			script: [{ output: "", onTurn: () => abortRun() }],
		});
		abortRun = () => harness.controller.abort();

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual({ outcome: "retry", code: "LEASE_LOST" });
		expect(lock.releases).toEqual(["release"]);
		expect(lock.leases[0]?.releases).toBe(1);
		expect(harness.provider.destroyCalls).toHaveLength(1);
	});

	test("a throwing release is logged bounded and never replaces the verdict", async () => {
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			acquireBranchLock: async () => ({
				release: () => {
					throw new PlatformError("DB_UNAVAILABLE", "lock store down");
				},
			}),
			script: [{ output: "" }],
		});

		const verdict = await harness.handler.handle(harness.job, harness.ctx);

		expect(verdict).toEqual(COMPLETE);
		expect(
			harness.logs.some((log) => log.message === "branch lock release failed"),
		).toBe(true);
		expect(JSON.stringify(harness.logs)).not.toContain("lock store down");
	});
});

/* ---------------------- wave 11 — trusted cost + metrics -------------------- */

describe("task execution handler — wave 11 cost accounting", () => {
	test("model rows are priced from the trusted table, not the runtime value", async () => {
		const harness = makeHarness({
			priceTable: {
				models: [
					{
						modelId: "test-model",
						promptTokenUsdPerMillion: 1,
						completionTokenUsdPerMillion: 2,
					},
				],
				sandbox: { cpuSecondUsd: 0, gibSecondUsd: 0 },
			},
			script: [
				{ output: "", promptTokens: 10, completionTokens: 5, costUsd: 99 },
			],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		const modelRow = modelRows(harness.sink.rows)[0];
		// 10 prompt tokens * $1/M + 5 completion tokens * $2/M
		expect(modelRow?.costUsd).toBe(0.00002);
	});

	test("an uncovered model keeps the runtime-reported cost when a table exists", async () => {
		const harness = makeHarness({
			priceTable: { models: [], sandbox: { cpuSecondUsd: 0, gibSecondUsd: 0 } },
			script: [{ output: "", costUsd: 0.001 }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		expect(modelRows(harness.sink.rows)[0]?.costUsd).toBe(0.001);
	});

	test("a null table leaves model and sandbox cost exactly as before", async () => {
		const harness = makeHarness({
			priceTable: null,
			script: [{ output: "", costUsd: 0.001 }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		expect(modelRows(harness.sink.rows)[0]?.costUsd).toBe(0.001);
		expect(sandboxRows(harness.sink.rows)[0]?.costUsd).toBeNull();
	});

	test("the measured sandbox time is recorded on the attempt for the summary", async () => {
		const clock = new FakeClock();
		const lifecycle = new FakeLifecycle();
		const harness = makeHarness({
			clock,
			lifecycle,
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "", onTurn: () => clock.advance(7000) }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		expect(lastAttemptOutcome(lifecycle)).toMatchObject({
			status: "review_ready",
			sandboxSeconds: 7,
		});
	});
});

describe("task execution handler — wave 11 metrics", () => {
	function metricRecords(logs: LogRecord[]): LogFields[] {
		return logs
			.filter((log) => log.message === "isolate.metric")
			.map((log) => log.fields);
	}

	test("emits turn, sandbox and validation metrics with bounded fields", async () => {
		const harness = makeHarness({
			lifecycle: new FakeLifecycle(),
			workspaceGit: new FakeWorkspaceGit(),
			script: [{ output: "working" }, { output: "" }],
		});

		await harness.handler.handle(harness.job, harness.ctx);

		const records = metricRecords(harness.logs);
		const turns = records.filter(
			(record) => record.metric === "worker.turn.latency_ms",
		);
		expect(turns).toHaveLength(2);
		expect(turns.map((record) => record.turn)).toEqual([1, 2]);
		const sandbox = records.filter(
			(record) => record.metric === "worker.sandbox.seconds",
		);
		expect(sandbox).toHaveLength(1);
		expect(typeof sandbox[0]?.seconds).toBe("number");
		const validation = records.filter(
			(record) => record.metric === "worker.validation.outcome",
		);
		// No configured command: the gate is recorded as skipped, not passed.
		expect(validation).toEqual([
			{ metric: "worker.validation.outcome", outcome: "skipped" },
		]);
		// No prompt or tool payload ever reaches a metric record.
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain("Fix the widget");
		expect(serialized).not.toContain("SECRET");
	});

	test("a failing validation command emits outcome failed", async () => {
		const valid = makeHarness({
			workspaceGit: new FakeWorkspaceGit(),
			lifecycle: new FakeLifecycle(),
			validationPolicy: { command: "bun test", timeoutMs: 5000 },
			executeHandler: () => commandResult({ exitCode: 1, stdout: "boom" }),
			script: [{ output: "" }],
		});

		await valid.handler.handle(valid.job, valid.ctx);

		expect(
			metricRecords(valid.logs).filter(
				(record) => record.metric === "worker.validation.outcome",
			),
		).toMatchObject([{ outcome: "failed" }]);
	});
});
