import { Agent } from "@mastra/core/agent";

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
	limits: TaskLimits;
};

export type AgentTurnRecord = {
	turn: number;
	status: "started" | "finished" | "failed" | "denied";
	toolCalls: string[];
	// Narrative/text output for the timeline; never provider payloads.
	summary: string | null;
};

/** Minimal agent-facing surface used by the SDLC workflow. */
export type CodingAgentRuntime = {
	id: string;
	name: string;
	runTurn(input: {
		prompt: string;
		context: TaskContext;
		signal: AbortSignal;
	}): Promise<string>;
};

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
	},
): Agent {
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
	});
}
