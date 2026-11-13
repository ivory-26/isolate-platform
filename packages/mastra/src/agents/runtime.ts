import { isPlatformError, PlatformError } from "@isolate/shared";
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
};

export type MastraAgentRuntime = CodingAgentRuntime & {
	turns: AgentTurnRecord[];
	/**
	 * Cumulative provider-reported tokens for the whole task, including
	 * `caps.priorTaskTokens` from earlier attempts.
	 */
	readonly totalTokensUsed: number;
};

/**
 * At most two `generate` calls for one turn: the original plus one bounded
 * retry. A stale Meta stream can end a turn without any usable response; a
 * second attempt is usually enough. The deliberate tradeoff is that a failure
 * can happen after some sandbox tool calls already executed, so the retry may
 * in principle re-run them. The observed failures completed zero tool calls,
 * and one retry is the bound that keeps duplicate side effects small while
 * still rescuing a stalled stream.
 */
export const MAX_GENERATE_ATTEMPTS_PER_TURN = 2;

/**
 * Bounded transport-failure signatures. Matched case-insensitively against the
 * error name and message at each level of the `cause` chain. Anything not on
 * this list (including every `PlatformError`) is not retried.
 */
const TRANSPORT_FAILURE_SIGNATURES = [
	"timed out",
	"timeout",
	"econnreset",
	"socket hang up",
	"fetch failed",
	"terminated",
	"und_err_",
] as const;

const MAX_CAUSE_DEPTH = 4;

function matchesTransportSignature(text: string): boolean {
	const lower = text.toLowerCase();
	return TRANSPORT_FAILURE_SIGNATURES.some((signature) =>
		lower.includes(signature),
	);
}

/**
 * True only for provider/transport failures that a single retry may fix.
 *
 * - Never when the caller's signal is aborted: the caller asked to stop.
 * - Never for `PlatformError` (budget, validation); those are terminal.
 * - `TimeoutError` (DOMException) and code 23 are Bun's timeout forms.
 * - `AbortError` without an aborted caller signal is a provider-side stall.
 * - Otherwise a bounded `cause` walk looks for transport signatures.
 */
export function isRetryableGenerationFailure(
	error: unknown,
	signal: AbortSignal,
): boolean {
	if (signal.aborted) return false;
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
		if (current === null || current === undefined) return false;
		if (isPlatformError(current)) return false;
		if (typeof current !== "object") return false;
		if (seen.has(current)) return false;
		seen.add(current);
		const candidate = current as {
			name?: unknown;
			message?: unknown;
			code?: unknown;
			cause?: unknown;
		};
		const name = typeof candidate.name === "string" ? candidate.name : "";
		const message =
			typeof candidate.message === "string" ? candidate.message : "";
		if (name === "TimeoutError" || name === "AbortError") return true;
		if (candidate.code === 23) return true;
		if (matchesTransportSignature(name) || matchesTransportSignature(message)) {
			return true;
		}
		current = candidate.cause;
	}
	return false;
}

/**
 * Runs one model call with at most one transport retry. `produce` must contain
 * only the provider call: usage recording, record emission and budget checks
 * stay outside so a retry can never duplicate those side effects or produce a
 * second turn record.
 */
async function generateWithRetry<T>(
	produce: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let lastError: unknown;
	for (
		let attempt = 1;
		attempt <= MAX_GENERATE_ATTEMPTS_PER_TURN;
		attempt += 1
	) {
		try {
			return await produce();
		} catch (error) {
			lastError = error;
			if (
				attempt >= MAX_GENERATE_ATTEMPTS_PER_TURN ||
				!isRetryableGenerationFailure(error, signal)
			) {
				throw error;
			}
		}
	}
	throw lastError;
}

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
		turns,
		get totalTokensUsed() {
			return totalTokensUsed;
		},
		async runTurn(input) {
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
				const result = await generateWithRetry(
					() =>
						agent.generate(input.prompt, {
							abortSignal: input.signal,
							...(caps === undefined
								? {}
								: {
										maxSteps: caps.maxSteps,
										modelSettings: {
											maxOutputTokens: caps.maxOutputTokensPerTurn,
										},
									}),
						}),
					input.signal,
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
