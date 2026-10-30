import { PlatformError } from "@isolate/shared";
import type { Agent } from "@mastra/core/agent";
import { estimateUsageCostUsd, type UsagePriceTable } from "./baseten";
import type {
	AgentTurnCaps,
	AgentTurnRecord,
	AgentUsage,
	AgentUsageListener,
	CodingAgentRuntime,
	TaskContext,
} from "./types";

/**
 * Timelines carry bounded narratives only: raw model dumps, payloads and
 * provider metadata never reach the record store.
 */
export const AGENT_TURN_SUMMARY_LIMIT = 2000;
const MAX_RECORDED_TOOL_NAMES = 100;
const MAX_TOOL_NAME_LENGTH = 200;

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
				usage: null,
			};
			turns.push(record);
			try {
				const text = await options.script(input);
				const finished: AgentTurnRecord = {
					turn,
					status: "finished",
					toolCalls: [],
					summary: text === "" ? null : limitSummary(text),
					usage: null,
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
					usage: null,
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
 *
 * Bounds are enforced here, in trusted code, not by model judgement:
 * - `maxSteps` and `modelSettings.maxOutputTokens` are sent on every call
 *   (verified against @mastra/core@1.79.0 `AgentExecutionOptionsBase`).
 * - A cumulative token accumulator blocks the next turn with
 *   `PlatformError("BUDGET_EXCEEDED")` once `caps.maxTaskTokens` is reached.
 */
export type MastraAgentRuntimeOptions = {
	id: string;
	name: string;
	onRecord?: (record: AgentTurnRecord) => Promise<void>;
	/** Awaited after each model call, before the turn record is emitted. */
	onUsage?: AgentUsageListener;
	/** Hard per-task bounds; invalid values fail at construction. */
	caps?: AgentTurnCaps;
	/** Provider/model ids stamped onto reported usage. */
	model?: { providerId: string; modelId: string };
	/** Injected USD price table; absence yields `costUsd: null`, never a guess. */
	priceTable?: UsagePriceTable;
};

export type MastraAgentRuntime = CodingAgentRuntime & {
	turns: AgentTurnRecord[];
	/** Cumulative provider-reported tokens across turns of this runtime. */
	readonly totalTokensUsed: number;
};

function assertValidCaps(caps: AgentTurnCaps): void {
	const values = [
		caps.maxOutputTokensPerTurn,
		caps.maxTaskTokens,
		caps.maxSteps,
	];
	if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"agent caps must be finite positive numbers",
		);
	}
}

function trustedTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

type RawUsageLike = Record<string, unknown>;

/**
 * Maps provider-reported usage. `inputTokens`/`outputTokens`/`totalTokens` are
 * the installed @mastra/core@1.79.0 field names; the OpenAI-style aliases are
 * accepted defensively because some OpenAI-compatible gateways report them.
 */
function mapUsage(
	raw: unknown,
	model: { providerId: string; modelId: string },
	priceTable: UsagePriceTable | undefined,
): AgentUsage | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as RawUsageLike;
	const promptTokens =
		trustedTokenCount(record.inputTokens) ??
		trustedTokenCount(record.promptTokens) ??
		0;
	const completionTokens =
		trustedTokenCount(record.outputTokens) ??
		trustedTokenCount(record.completionTokens) ??
		0;
	const totalTokens =
		trustedTokenCount(record.totalTokens) ?? promptTokens + completionTokens;
	const usage: AgentUsage = {
		providerId: model.providerId,
		modelId: model.modelId,
		promptTokens,
		completionTokens,
		totalTokens,
		costUsd: null,
	};
	usage.costUsd = estimateUsageCostUsd(usage, priceTable);
	return usage;
}

/**
 * Tool calls are chunk-shaped in 1.79 (`payload.toolName`). Accept both that
 * form and a flattened `toolName`/`name` so provider drift cannot silently
 * drop names; only names are retained — args and payloads are discarded.
 */
function toolNamesFrom(toolCalls: unknown): string[] {
	if (!Array.isArray(toolCalls)) return [];
	const names: string[] = [];
	for (const entry of toolCalls) {
		if (names.length >= MAX_RECORDED_TOOL_NAMES) break;
		if (typeof entry !== "object" || entry === null) continue;
		const chunk = entry as Record<string, unknown>;
		const payload =
			typeof chunk.payload === "object" && chunk.payload !== null
				? (chunk.payload as Record<string, unknown>)
				: undefined;
		const candidate =
			chunk.toolName ?? chunk.name ?? payload?.toolName ?? payload?.name;
		if (typeof candidate !== "string" || candidate.length === 0) continue;
		names.push(candidate.slice(0, MAX_TOOL_NAME_LENGTH));
	}
	return names;
}

export function createMastraAgentRuntime(
	agent: Agent,
	options: MastraAgentRuntimeOptions,
): MastraAgentRuntime {
	if (options.caps) {
		assertValidCaps(options.caps);
	}
	const caps = options.caps;
	const model = options.model ?? {
		providerId: "unknown",
		modelId: "unknown",
	};
	const turns: AgentTurnRecord[] = [];
	let nextTurn = 0;
	let totalTokensUsed = 0;
	const onRecord = options.onRecord;
	const onUsage = options.onUsage;

	return {
		id: options.id,
		name: options.name,
		turns,
		get totalTokensUsed() {
			return totalTokensUsed;
		},
		async runTurn(input) {
			if (caps && totalTokensUsed >= caps.maxTaskTokens) {
				throw new PlatformError(
					"BUDGET_EXCEEDED",
					"task token budget exhausted",
				);
			}

			const turn = ++nextTurn;
			const record: AgentTurnRecord = {
				turn,
				status: "started",
				toolCalls: [],
				summary: null,
				usage: null,
			};
			turns.push(record);
			try {
				const result = await agent.generate(input.prompt, {
					abortSignal: input.signal,
					...(caps === undefined
						? {}
						: {
								maxSteps: caps.maxSteps,
								modelSettings: {
									maxOutputTokens: caps.maxOutputTokensPerTurn,
								},
							}),
				});
				const usage = mapUsage(
					result.totalUsage ?? result.usage,
					model,
					options.priceTable,
				);
				if (usage !== null) {
					totalTokensUsed += usage.totalTokens;
					if (onUsage) {
						await onUsage(usage);
					}
				}
				// Reasoning models can spend the whole output budget on reasoning and
				// return empty text. That means "truncated", not "no further work":
				// the empty-output completion protocol must not treat it as done.
				if (
					caps !== undefined &&
					result.text === "" &&
					usage !== null &&
					usage.completionTokens >= caps.maxOutputTokensPerTurn
				) {
					throw new PlatformError(
						"BUDGET_EXCEEDED",
						"agent turn exhausted its output budget",
					);
				}
				const finished: AgentTurnRecord = {
					turn,
					status: "finished",
					toolCalls: toolNamesFrom(result.toolCalls),
					summary: result.text === "" ? null : limitSummary(result.text),
					usage,
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
					usage: null,
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
