import type { AgentTurnCaps, TaskContext } from "@isolate/mastra";
import type { CommandPolicy } from "@isolate/sandbox";
import { MAX_OUTPUT_BYTES, NullProvider } from "@isolate/sandbox";
import { type Logger, PlatformError, type UsageSink } from "@isolate/shared";
import type { WorkerConfig } from "./config";
import type { JobHandler } from "./contracts";
import {
	createPullRequestHandler,
	type PullRequestWorkflowDeps,
} from "./create-pull-request-handler";
import {
	createResumeTaskHandler,
	createTaskExecutionHandler,
	createUnconfiguredRuntimeFactory,
	type TaskExecutionDeps,
} from "./task-execution-handler";

/**
 * Composition seams for the worker's `run_task` handler.
 *
 * Wave 4 ships adapters in parallel lanes, so this module only knows the
 * injected interfaces (`SandboxProvider`, `CodingAgentRuntimeFactory`,
 * `UsageSink`, `loadTaskContext`). It never imports a concrete Modal/Baseten
 * symbol or a real model client: W4-OPS injects those after the adapter lanes
 * merge by passing overrides to `createOfflineWorkerDeps`.
 *
 * Defaults are deliberately offline and fail closed:
 * - `NullProvider` refuses to provision (SANDBOX_PROVISION_FAILED at runtime),
 * - the runtime factory and task loader throw MISSING_CONFIG,
 * - the usage sink is a no-op that logs one bounded warning. Offline no sandbox
 *   can be provisioned, so nothing is spendable; keeping the sink non-throwing
 *   lets the composed worker finish a locally scripted task instead of failing
 *   on accounting that has nowhere to write. A configured sink is required as
 *   soon as a real provider is injected (W4-OPS).
 */

/** Sandbox-internal root; never a host path. */
const OFFLINE_WORKSPACE_ROOT = "/workspace/task";
const OFFLINE_COMMAND_TIMEOUT_MS = 60_000;
const OFFLINE_SANDBOX_CPU = 1;
const OFFLINE_SANDBOX_MEMORY_MB = 1024;
const OFFLINE_IDLE_TIMEOUT_MS = 300_000;

export type WorkerCompositionOverrides = Partial<
	Omit<TaskExecutionDeps, "caps" | "maxSandboxSeconds" | "maxCostUsdPerTask">
> & {
	caps?: Partial<AgentTurnCaps>;
	maxSandboxSeconds?: number;
	maxCostUsdPerTask?: number;
	/**
	 * Wave 8 PR stage. Bound only when a GitHub broker and a real sandbox
	 * provider exist; without it the `create_pull_request` handler is not
	 * registered, so the job stays unclaimable (fail closed).
	 */
	pullRequest?: Omit<PullRequestWorkflowDeps, "lifecycle">;
};

export type WorkerComposition = {
	taskExecution: TaskExecutionDeps;
	handlers: JobHandler[];
};

/**
 * No-op spend sink for offline composition: one bounded warning, never a
 * payload or credential. A real sink (W4-DB `UsageRepository`) must be
 * injected before any provider with spend is enabled.
 */
export function createLoggingNoopUsageSink(logger: Logger): UsageSink {
	let warned = false;
	return {
		async record() {
			if (warned) return;
			warned = true;
			logger.warn(
				"usage sink not configured; spend is not persisted (offline composition)",
			);
		},
	};
}

function createUnconfiguredTaskContextLoader(): TaskExecutionDeps["loadTaskContext"] {
	return async (): Promise<TaskContext> => {
		throw new PlatformError(
			"MISSING_CONFIG",
			"task context loader not configured",
		);
	};
}

function createDefaultSandboxPolicy(): CommandPolicy {
	return {
		workspaceRoot: OFFLINE_WORKSPACE_ROOT,
		// No command is authorised offline; the real policy is injected.
		allowlist: [],
		maxTimeoutMs: OFFLINE_COMMAND_TIMEOUT_MS,
		maxOutputBytes: MAX_OUTPUT_BYTES,
		egress: { mode: "deny" },
	};
}

/**
 * Builds the worker's task-execution composition. Every adapter can be
 * overridden; the config only supplies the bounded caps and defaults.
 * W4-OPS wiring (after adapters merge) must supply at least:
 * `provider`, `createRuntime`, `usageSink`, `loadTaskContext`, and a real
 * `sandboxPolicy`; `sandboxPriceTable` should be set whenever sandbox spend
 * must be attributed.
 */
export function createOfflineWorkerDeps(
	config: WorkerConfig,
	logger: Logger,
	overrides: WorkerCompositionOverrides = {},
): WorkerComposition {
	const taskExecution: TaskExecutionDeps = {
		provider: overrides.provider ?? new NullProvider(),
		createRuntime:
			overrides.createRuntime ?? createUnconfiguredRuntimeFactory(),
		usageSink: overrides.usageSink ?? createLoggingNoopUsageSink(logger),
		loadTaskContext:
			overrides.loadTaskContext ?? createUnconfiguredTaskContextLoader(),
		caps: {
			maxOutputTokensPerTurn: config.maxOutputTokensPerTurn,
			maxTaskTokens: config.maxTokensPerTask,
			maxSteps: config.maxAgentSteps,
			...overrides.caps,
		},
		sandboxPolicy: overrides.sandboxPolicy ?? createDefaultSandboxPolicy(),
		sandbox: overrides.sandbox ?? {
			cpuCount: OFFLINE_SANDBOX_CPU,
			memoryMb: OFFLINE_SANDBOX_MEMORY_MB,
			// Config caps the provider lifetime; the handler applies the same
			// bound defensively before every turn.
			lifetimeMs: config.maxSandboxSeconds * 1000,
			idleTimeoutMs: OFFLINE_IDLE_TIMEOUT_MS,
		},
		maxSandboxSeconds: overrides.maxSandboxSeconds ?? config.maxSandboxSeconds,
		maxCostUsdPerTask: overrides.maxCostUsdPerTask ?? config.maxCostUsdPerTask,
		sandboxPriceTable: overrides.sandboxPriceTable ?? null,
		now: overrides.now,
		// Wave 7 seams. When `lifecycle` is absent the handler keeps the wave-6
		// semantics and the resume handler is not registered.
		lifecycle: overrides.lifecycle,
		createWorkspaceGit: overrides.createWorkspaceGit,
		pushEnabled: overrides.pushEnabled ?? false,
		// Bound by the real composition only; without these a job would clone
		// without a credential and run the agent tool-less.
		...(overrides.createSandboxBackend === undefined
			? {}
			: { createSandboxBackend: overrides.createSandboxBackend }),
		...(overrides.resolveSandboxEnv === undefined
			? {}
			: { resolveSandboxEnv: overrides.resolveSandboxEnv }),
		...(overrides.loadValidationPolicy === undefined
			? {}
			: { loadValidationPolicy: overrides.loadValidationPolicy }),
		// Wave 9 seams. Dropping any of these would silently degrade completion
		// to the diff-only fallback, disable the tool audit or allow two writers
		// on one branch, so every one is forwarded explicitly.
		...(overrides.loadAcceptanceChecks === undefined
			? {}
			: { loadAcceptanceChecks: overrides.loadAcceptanceChecks }),
		...(overrides.recordToolInvocation === undefined
			? {}
			: { recordToolInvocation: overrides.recordToolInvocation }),
		...(overrides.acquireBranchLock === undefined
			? {}
			: { acquireBranchLock: overrides.acquireBranchLock }),
	};

	const handlers: JobHandler[] = [createTaskExecutionHandler(taskExecution)];
	if (taskExecution.lifecycle !== undefined) {
		handlers.push(createResumeTaskHandler(taskExecution));
		// The PR handler needs a lifecycle plus the three DB reads and the
		// connector seam; the composition binds them only when GitHub and a real
		// sandbox are configured.
		if (overrides.pullRequest !== undefined) {
			handlers.push(
				createPullRequestHandler({
					lifecycle: taskExecution.lifecycle,
					...overrides.pullRequest,
				}),
			);
		}
	}

	return { taskExecution, handlers };
}
