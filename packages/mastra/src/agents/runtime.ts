import { PlatformError } from "@isolate/shared";
import type { Agent } from "@mastra/core/agent";
import { estimateUsageCostUsd, type UsagePriceTable } from "./baseten";
import {
	isAbortLikeError,
	MAX_PROVIDER_RETRY_ATTEMPTS,
	toProviderError,
} from "./failure";
import {
	type ProviderCapabilities,
	UNKNOWN_PROVIDER_CAPABILITIES,
} from "./registry";
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

const UTF8 = new TextEncoder();

/**
 * Conservative prompt-size estimate from UTF-8 bytes (about four bytes per
 * token). This is a lower bound on cost, not a tokenizer: it exists only to
 * reject a call that cannot fit a configured window before the provider is
 * contacted.
 */
export function estimatePromptTokens(prompt: string): number {
	return Math.ceil(UTF8.encode(prompt).length / 4);
}

/** Fake agents script their output and advertise no provider feature. */
const FAKE_AGENT_CAPABILITIES: ProviderCapabilities = Object.freeze({
	streaming: false,
	toolCalls: false,
	approvals: false,
	session: false,
	context: false,
});

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
	/** Test-only override; defaults to the conservative fake record. */
	capabilities?: ProviderCapabilities;
};

export function createFakeAgentRuntime(
	options: FakeAgentRuntimeOptions,
): FakeAgentRuntime {
	const turns: AgentTurnRecord[] = [];
	let nextTurn = 0;
	return {
		id: options.id ?? "fake-coding-agent",
		name: options.name ?? "Fake Coding Agent",
		capabilities: options.capabilities ?? FAKE_AGENT_CAPABILITIES,
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
 * - `modelSettings.maxRetries` is always sent as 0, because Mastra otherwise
 *   retries a retryable model error twice inside a single `generate()` call.
 *   `withProviderRetry` is the only retry owner.
 * - The token accumulator is **task-wide**: it starts at
 *   `caps.priorTaskTokens` (spend persisted by earlier attempts) and blocks the
 *   next turn with `PlatformError("BUDGET_EXCEEDED")` once `caps.maxTaskTokens`
 *   is reached. It also reserves the size of the previous turn before starting
 *   the next one. That reservation is a heuristic, not an upper bound: a later
 *   turn can be much larger than the turn before it, so the cap can still be
 *   overshot by the size of the turn that crosses it.
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
	/** Honest capabilities from the descriptor; defaults to none advertised. */
	capabilities?: ProviderCapabilities;
};

export type MastraAgentRuntime = CodingAgentRuntime & {
	turns: AgentTurnRecord[];
	/**
	 * Cumulative provider-reported tokens for the whole task, including
	 * `caps.priorTaskTokens` from earlier attempts.
	 */
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
	if (caps.priorTaskTokens !== undefined) {
		const prior = caps.priorTaskTokens;
		if (!Number.isInteger(prior) || prior < 0) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"priorTaskTokens must be a finite non-negative integer",
			);
		}
	}
	if (
		caps.contextWindowTokens !== undefined &&
		(!Number.isInteger(caps.contextWindowTokens) ||
			caps.contextWindowTokens <= 0)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"contextWindowTokens must be a positive integer",
		);
	}
	if (
		caps.providerRetryAttempts !== undefined &&
		(!Number.isInteger(caps.providerRetryAttempts) ||
			caps.providerRetryAttempts < 0 ||
			caps.providerRetryAttempts > MAX_PROVIDER_RETRY_ATTEMPTS)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`providerRetryAttempts must be an integer between 0 and ${MAX_PROVIDER_RETRY_ATTEMPTS}`,
		);
	}
}

/** Honours an already-aborted signal before any provider work. */
function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	throw reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
}

/**
 * One bounded call to `generate()` with an explicit retry decision.
 *
 * Only classified retryable failures (rate limit, timeout, unavailable) are
 * retried, only before any usage is recorded, and only while the signal is
 * live. A partially produced turn is never retried: this runtime does not
 * stream, so a thrown call produced no usable output.
 */
async function withProviderRetry<T>(
	invoke: () => Promise<T>,
	signal: AbortSignal,
	providerRetryAttempts: number,
): Promise<T> {
	const attempts = 1 + providerRetryAttempts;
	for (let attempt = 1; ; attempt++) {
		try {
			return await invoke();
		} catch (error) {
			if (signal.aborted || isAbortLikeError(error)) throw error;
			const providerError = toProviderError(error);
			if (attempt >= attempts || !providerError.retryable || signal.aborted) {
				throw providerError;
			}
		}
	}
}

function trustedTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

/**
 * Next turn's heuristic reservation: the size of the turn that just reported
 * usage. A turn that reports no usage keeps the previous reservation, so an
 * unknown-size turn cannot silently disarm the estimate.
 */
export function nextTurnTokenReservation(
	previousTokens: number,
	usage: AgentUsage | null,
): number {
	return usage === null ? previousTokens : usage.totalTokens;
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
	// Task-wide: earlier attempts of the same task already spent these tokens.
	let totalTokensUsed = caps?.priorTaskTokens ?? 0;
	// Heuristic: size of the previous turn, reserved before the next one starts.
	let lastTurnTokens = 0;
	const onRecord = options.onRecord;
	const onUsage = options.onUsage;

	return {
		id: options.id,
		name: options.name,
		capabilities: options.capabilities ?? UNKNOWN_PROVIDER_CAPABILITIES,
		turns,
		get totalTokensUsed() {
			return totalTokensUsed;
		},
		async runTurn(input) {
			throwIfAborted(input.signal);
			if (
				caps &&
				(totalTokensUsed >= caps.maxTaskTokens ||
					totalTokensUsed + lastTurnTokens > caps.maxTaskTokens)
			) {
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
				// Prompt/context preflight (study P0-2): reject a call that cannot
				// fit the configured window before the provider is contacted.
				if (caps?.contextWindowTokens !== undefined) {
					const estimatedPromptTokens = estimatePromptTokens(input.prompt);
					if (
						estimatedPromptTokens + caps.maxOutputTokensPerTurn >
						caps.contextWindowTokens
					) {
						throw new PlatformError(
							"BUDGET_EXCEEDED",
							"prompt exceeds configured context window",
						);
					}
				}
				const result = await withProviderRetry(
					() =>
						agent.generate(input.prompt, {
							abortSignal: input.signal,
							...(caps === undefined ? {} : { maxSteps: caps.maxSteps }),
							// Inside one `generate()` call Mastra's model loop retries a
							// retryable model error `modelSettings.maxRetries ?? 2` times
							// (@mastra/core@1.79.0 dist/agent-*.js, `execute()`). That
							// hidden layer must stay off: forwarding
							// `providerRetryAttempts` here as well would square the
							// worst-case provider calls ((1+n)^2) and break the spend
							// bound. `withProviderRetry` is the only retry owner. An agent
							// constructed with an explicit `maxRetries` still wins over
							// this call-time value; our factory never sets one.
							modelSettings: {
								maxRetries: 0,
								...(caps === undefined
									? {}
									: { maxOutputTokens: caps.maxOutputTokensPerTurn }),
							},
						}),
					input.signal,
					caps?.providerRetryAttempts ?? 0,
				);
				const usage = mapUsage(
					result.totalUsage ?? result.usage,
					model,
					options.priceTable,
				);
				if (usage !== null) {
					totalTokensUsed += usage.totalTokens;
				}
				// Heuristic reservation for the next turn; a usage-less turn keeps
				// the previous value instead of disarming the estimate.
				lastTurnTokens = nextTurnTokenReservation(lastTurnTokens, usage);
				if (usage !== null && onUsage) {
					await onUsage(usage);
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
