import { type ContextItem, PlatformError } from "@isolate/shared";
import { Agent, type ToolsInput } from "@mastra/core/agent";
import type { ToolDecisionRecord } from "../tools/registry";
import type { SandboxToolBackend } from "../tools/sandbox-backend";

/**
 * Task execution context handed to agents and workflow steps.
 *
 * Sprint B-2 grows this package. Security invariants:
 * - No credentials in this object; the model never sees provider keys.
 * - Repository contentAgent instructions treat repo/issue text as untrusted
 *   (prompt-injection defence lives in trusted policy code, not instructions).
 */
export type TaskLimits = {
	max_agent_turns: number;
	max_repair_attempts: number;
	max_duration_ms: number;
};

export type TaskContext = {
	taskId: string;
	organizationId: string;
	goal: string;
	repoUrl: string;
	baseBranch: string;
	isolatedBranch: string;
	// Explicit file ownership keeps parallel agents out of shared paths.
	fileOwnership: string[];
	acceptanceCriteria: string[];
	/**
	 * Wave 9: stable repository identity for the per-branch execution lock.
	 * Supplied by the loader when the task row exposes the repository id; the
	 * worker falls back to `repoUrl` (same string for every job on one repo).
	 */
	repositoryId?: string;
	/** Wave 13: set for incident-triggered tasks; enables context loading. */
	incidentFingerprint?: string;
	/**
	 * Wave 13: bounded, cited, untrusted incident evidence appended to the
	 * prompt. Every item is data, never an instruction or an authorization.
	 */
	contextBundle?: ContextItem[];
	/**
	 * Wave 13: `ContextBundle.truncated`. The items array alone cannot carry
	 * the flag, so the loader result records it here and the prompt renders
	 * `(truncated)` when evidence was dropped or capped.
	 */
	contextBundleTruncated?: boolean;
	limits: TaskLimits;
};

export type AgentTurnRecord = {
	turn: number;
	status: "started" | "finished" | "failed" | "denied";
	toolCalls: string[];
	// Narrative/text output for the timeline; never provider payloads.
	summary: string | null;
	/**
	 * Provider-reported token usage for this turn. Null/absent for fakes,
	 * denials and turns that never reached the model. Never estimated here.
	 */
	usage?: AgentUsage | null;
};

/**
 * Token usage exactly as reported by the provider for one model call.
 *
 * `costUsd` comes from a trusted, configured price table; null means no price
 * is configured. Agents and model output must never supply token counts or
 * prices — only `generate()`'s reported usage is mapped into this shape.
 */
export type AgentUsage = {
	providerId: string;
	modelId: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	costUsd: number | null;
};

/** Trusted spend listener; awaited before the next turn so caps see the spend. */
export type AgentUsageListener = (usage: AgentUsage) => Promise<void> | void;

/**
 * Hard per-task bounds enforced by the runtime, not by model judgement.
 * Exhaustion surfaces as `PlatformError("BUDGET_EXCEEDED")`.
 */
export type AgentTurnCaps = {
	/** Max output tokens requested per model call. */
	maxOutputTokensPerTurn: number;
	/** Max cumulative tokens for the whole task. */
	maxTaskTokens: number;
	/** Finite Mastra step bound passed to `generate()`. */
	maxSteps: number;
};

/** Minimal agent-facing surface driven by the worker's imperative handler. */
export type CodingAgentRuntime = {
	id: string;
	name: string;
	/**
	 * Runs one bounded turn. Implementations must throw
	 * `PlatformError("BUDGET_EXCEEDED")` when `caps` are exhausted and honour
	 * the abort signal instead of continuing to call the model.
	 */
	runTurn(input: {
		prompt: string;
		context: TaskContext;
		signal: AbortSignal;
	}): Promise<string>;
};

/**
 * Per-task runtime factory (wave 4). The worker supplies the record/usage
 * listeners and caps; the concrete model, tools and provider stay in the
 * composition root. Tests inject fake factories with the same shape.
 *
 * Wave 6 adds the per-job sandbox binding: the worker provisions the sandbox
 * first, builds a `SandboxToolBackend` over that handle, and passes it here
 * with the task ids. The factory wires the policy-gated tools to exactly that
 * sandbox; no other task can reach it.
 */
export type CodingAgentRuntimeFactoryOptions = {
	onRecord?: (record: AgentTurnRecord) => Promise<void>;
	onUsage?: AgentUsageListener;
	caps?: AgentTurnCaps;
	/** Sandbox-bound tool backend for this job (absent = no tools). */
	sandboxBackend?: SandboxToolBackend;
	/** Trusted ids the tool gate binds to; never model-supplied. */
	toolContext?: {
		organizationId: string;
		taskId: string;
		scopes?: readonly string[];
		/** Wave 7: authored paths the task may modify; empty means no writes. */
		fileOwnership?: readonly string[];
	};
	/**
	 * Wave 9: audit hook for every gated tool call (executed, denied or
	 * approval-required). Receives ids, the denial reason and an argument
	 * digest only — never tool payloads. Threaded into `wireSandboxTools`.
	 */
	onToolDecision?: (record: ToolDecisionRecord) => Promise<void> | void;
};

export type CodingAgentRuntimeFactory = (
	options: CodingAgentRuntimeFactoryOptions,
) => CodingAgentRuntime;

export type OpenAICompatibleModelConfig = {
	/**
	 * Verified against the installed @mastra/core@1.79.0 d.ts: the
	 * OpenAI-compatible model object form is `{ providerId, modelId, url, apiKey,
	 * headers?, api? }`. Sprint B-2 re-verifies against the d.ts before use and
	 * keeps this split central so provider drift is fixed in one file.
	 */
	providerId: string;
	modelId: string;
	url: string;
	apiKey: string;
};

/** Factory for the provider-agnostic coding agent. */
export function defineCodingAgent(
	model: OpenAICompatibleModelConfig,
	config: {
		id: string;
		name: string;
		instructions: string;
		/**
		 * Trusted, policy-wired tool collection (see `wireSandboxTools`). The
		 * model only sees tool metadata; execution still passes the policy gate.
		 */
		tools?: ToolsInput;
		/**
		 * Default agentic-loop bound. Runtime callers override this per turn from
		 * `AgentTurnCaps`; the installed d.ts has no top-level Agent config
		 * `maxSteps`, so this maps to `defaultOptions.maxSteps`.
		 */
		maxSteps?: number;
	},
): Agent {
	if (config.maxSteps !== undefined) {
		if (
			typeof config.maxSteps !== "number" ||
			!Number.isFinite(config.maxSteps) ||
			config.maxSteps <= 0
		) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"maxSteps must be a finite positive number",
			);
		}
	}
	return new Agent({
		id: config.id,
		name: config.name,
		instructions: config.instructions,
		model: {
			providerId: model.providerId,
			modelId: model.modelId,
			url: model.url,
			apiKey: model.apiKey,
		},
		...(config.tools === undefined ? {} : { tools: config.tools }),
		...(config.maxSteps === undefined
			? {}
			: { defaultOptions: { maxSteps: config.maxSteps } }),
	});
}
