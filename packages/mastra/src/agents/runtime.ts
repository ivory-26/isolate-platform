import type { Agent } from "@mastra/core/agent";
import type { AgentTurnRecord, CodingAgentRuntime, TaskContext } from "./types";

/**
 * Timelines carry bounded narratives only: raw model dumps, payloads and
 * provider metadata never reach the record store.
 */
export const AGENT_TURN_SUMMARY_LIMIT = 2000;

export function limitSummary(text: string): string {
	return text.length > AGENT_TURN_SUMMARY_LIMIT
		? `${text.slice(0, AGENT_TURN_SUMMARY_LIMIT - 1)}…`
		: text;
}

/**
 * Model-agnostic fake runtime used by tests and by callers that script agent
 * behaviour. Never touches a provider or the network; the script itself is the
 * only source of output.
 */
export type FakeAgentRuntime = CodingAgentRuntime & {
	/** All turns this runtime has served; assert turn budgets against it. */
	turns: AgentTurnRecord[];
	onRecord: ((record: AgentTurnRecord) => Promise<void>) | undefined;
};

export type FakeAgentRuntimeOptions = {
	id?: string;
	name?: string;
	script: (input: {
		turn: number;
		prompt: string;
		context: TaskContext;
	}) => Promise<string> | string;
	onRecord?: (record: AgentTurnRecord) => Promise<void>;
};

export function createFakeAgentRuntime(
	options: FakeAgentRuntimeOptions,
): FakeAgentRuntime {
	const turns: AgentTurnRecord[] = [];
	let nextTurn = 0;
	return {
		id: options.id ?? "fake-coding-agent",
		name: options.name ?? "Fake Coding Agent",
		turns,
		onRecord: options.onRecord,
		async runTurn(input) {
			const turn = ++nextTurn;
			const record: AgentTurnRecord = {
				turn,
				status: "started",
				toolCalls: [],
				summary: null,
			};
			turns.push(record);
			try {
				const text = await options.script(input);
				const finished: AgentTurnRecord = {
					turn,
					status: "finished",
					toolCalls: [],
					summary: text === "" ? null : limitSummary(text),
				};
				turns[turn - 1] = finished;
				if (options.onRecord) {
					await options.onRecord(finished);
				}
				return text;
			} catch (error) {
				const failed: AgentTurnRecord = {
					turn,
					status: "failed",
					toolCalls: [],
					summary: limitSummary(
						error instanceof Error ? error.message : String(error),
					),
				};
				turns[turn - 1] = failed;
				if (options.onRecord) {
					await options.onRecord(failed);
				}
				throw error;
			}
		},
	};
}

/**
 * Adapter from a real `@mastra/core` {@link Agent} to the platform runtime
 * contract. The model is supplied by the caller (factory, gateway or a test
 * mock); provider keys stay server-side inside the model config.
 */
export type MastraAgentRuntimeOptions = {
	id: string;
	name: string;
	onRecord?: (record: AgentTurnRecord) => Promise<void>;
};

export type MastraAgentRuntime = CodingAgentRuntime & {
	turns: AgentTurnRecord[];
};

export function createMastraAgentRuntime(
	agent: Agent,
	options: MastraAgentRuntimeOptions,
): MastraAgentRuntime {
	const turns: AgentTurnRecord[] = [];
	let nextTurn = 0;
	const onRecord = options.onRecord;
	return {
		id: options.id,
		name: options.name,
		turns,
		async runTurn(input) {
			const turn = ++nextTurn;
			const record: AgentTurnRecord = {
				turn,
				status: "started",
				toolCalls: [],
				summary: null,
			};
			turns.push(record);
			try {
				const result = await agent.generate(input.prompt, {
					abortSignal: input.signal,
				});
				const finished: AgentTurnRecord = {
					turn,
					status: "finished",
					toolCalls: [],
					summary: result.text === "" ? null : limitSummary(result.text),
				};
				turns[turn - 1] = finished;
				if (onRecord) {
					await onRecord(finished);
				}
				return result.text;
			} catch (error) {
				const failed: AgentTurnRecord = {
					turn,
					status: "failed",
					toolCalls: [],
					summary: limitSummary(
						error instanceof Error ? error.message : String(error),
					),
				};
				turns[turn - 1] = failed;
				if (onRecord) {
					await onRecord(failed);
				}
				throw error;
			}
		},
	};
}
