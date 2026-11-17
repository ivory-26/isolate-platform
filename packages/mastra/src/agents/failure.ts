import {
	type ErrorCode,
	isPlatformError,
	PlatformError,
} from "@isolate/shared";

/**
 * Typed provider-failure classification (T3 Code harness study P0-3).
 *
 * Provider SDKs throw unstructured errors. Left alone, the worker treats every
 * non-PlatformError as a retryable `INTERNAL`, so an authentication failure or a
 * prompt that can never fit burns job attempts and sandboxes. This module
 * normalizes the failure at the adapter boundary and gives the runtime a single
 * bounded decision: retry this call, or fail the turn once.
 *
 * The message fallback is deliberately small. Structured fields win; `unknown`
 * is non-retryable so a misclassification can never increase spend.
 */

export const PROVIDER_FAILURE_KINDS = [
	"rate_limited",
	"auth",
	"context_overflow",
	"timeout",
	"unavailable",
	"invalid_request",
	"unknown",
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

export type ProviderFailureClassification = {
	kind: ProviderFailureKind;
	/** Only rate limits, timeouts and unavailability may be retried. */
	retryable: boolean;
};

/** Hard cap for opt-in automatic provider retries (0 = classify once). */
export const MAX_PROVIDER_RETRY_ATTEMPTS = 3;

const RETRYABLE_KINDS: ReadonlySet<ProviderFailureKind> =
	new Set<ProviderFailureKind>(["rate_limited", "timeout", "unavailable"]);

const FAILURE_CODE: Record<ProviderFailureKind, ErrorCode> = {
	rate_limited: "RATE_LIMITED",
	auth: "AGENT_EXECUTION_FAILED",
	context_overflow: "BUDGET_EXCEEDED",
	timeout: "INTEGRATION_UNAVAILABLE",
	unavailable: "INTEGRATION_UNAVAILABLE",
	invalid_request: "VALIDATION_FAILED",
	unknown: "AGENT_EXECUTION_FAILED",
};

/**
 * Static messages only: a provider payload or URL must never reach a turn
 * record, log line or persisted error note. The original error is kept as
 * `cause` for local diagnosis and is never serialized.
 */
const FAILURE_MESSAGE: Record<ProviderFailureKind, string> = {
	rate_limited: "provider rate limited the request",
	auth: "provider rejected the credentials",
	context_overflow: "provider rejected the prompt as too large",
	timeout: "provider request timed out",
	unavailable: "provider is unavailable",
	invalid_request: "provider rejected the request",
	unknown: "provider call failed",
};

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

/**
 * Mastra's `Agent.generate()` does not rethrow the SDK error it caught: it
 * throws `MastraError({ id: "AGENT_GENERATE_FAILED" }, cause)` whose `message`
 * and `name` say nothing about the HTTP status, and keeps the SDK error
 * (`APICallError`, whose `statusCode`/`code` are the real signal) only as
 * `cause`. Classification therefore reads a bounded `cause` chain, the same
 * shape Mastra itself traverses (@mastra/core@1.79.0, `MAX_CAUSE_DEPTH = 5`).
 * The walk is cycle-safe: a self-referencing `cause` stops the chain.
 */
const MAX_CAUSE_DEPTH = 5;

function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
		if (current === null || current === undefined) break;
		if (seen.has(current)) break;
		seen.add(current);
		chain.push(current);
		if (typeof current !== "object") break;
		current = (current as UnknownRecord).cause;
	}
	return chain;
}

/** Structured HTTP status from `status`, `statusCode`, `response.status` or a numeric `code`. */
function statusOfRecord(error: unknown): number | undefined {
	const record = recordOf(error);
	if (record === undefined) return undefined;
	const candidates = [
		record.status,
		record.statusCode,
		recordOf(record.response)?.status,
		// Some gateways surface the HTTP status in `code`/`errorCode` instead.
		record.code,
		record.errorCode,
	];
	for (const candidate of candidates) {
		if (
			typeof candidate === "number" &&
			Number.isInteger(candidate) &&
			candidate >= 100 &&
			candidate <= 599
		) {
			return candidate;
		}
		if (typeof candidate === "string" && /^[1-5][0-9]{2}$/.test(candidate)) {
			return Number(candidate);
		}
	}
	return undefined;
}

/** Outermost structured status wins; a wrapper without one defers to its cause. */
function statusOf(error: unknown): number | undefined {
	for (const link of causeChain(error)) {
		const status = statusOfRecord(link);
		if (status !== undefined) return status;
	}
	return undefined;
}

type StructuredText = { codes: string; names: string };

function structuredTextOf(error: unknown): StructuredText {
	const codes: string[] = [];
	const names: string[] = [];
	for (const link of causeChain(error)) {
		const record = recordOf(link);
		if (record === undefined) continue;
		const rawCode = record.code ?? record.errorCode ?? record.type;
		if (typeof rawCode === "string" && rawCode.length > 0) {
			codes.push(rawCode);
		} else if (typeof rawCode === "number" && Number.isInteger(rawCode)) {
			codes.push(String(rawCode));
		}
		const rawName =
			record.name ?? (link instanceof Error ? link.name : undefined);
		if (typeof rawName === "string" && rawName.length > 0) {
			names.push(rawName);
		}
	}
	return { codes: codes.join(" "), names: names.join(" ") };
}

/** Messages from the whole chain, including a plain object's `message`. */
function messageOf(error: unknown): string {
	const messages: string[] = [];
	for (const link of causeChain(error)) {
		if (link instanceof Error) {
			if (link.message.length > 0) messages.push(link.message);
			continue;
		}
		const raw = recordOf(link)?.message;
		if (typeof raw === "string" && raw.length > 0) messages.push(raw);
	}
	if (messages.length === 0) return typeof error === "string" ? error : "";
	return messages.join(" ");
}

function hasContextSignal(text: string): boolean {
	return /context[ _-]?(window|length|overflow)|maximum context|too many tokens|prompt is too long|input is too long|token limit/.test(
		text,
	);
}

function kindFromStatus(
	status: number,
	contextSignal: boolean,
): ProviderFailureKind | undefined {
	if (status === 429) return "rate_limited";
	if (status === 401 || status === 403) return "auth";
	if (status === 408) return "timeout";
	if (status >= 500) return "unavailable";
	if (status >= 400) {
		// A prompt that cannot fit the model's window is a budget failure, not a
		// malformed request, even though providers commonly report it as 400/413.
		return contextSignal ? "context_overflow" : "invalid_request";
	}
	return undefined;
}

function kindFromStructured(text: string): ProviderFailureKind | undefined {
	if (hasContextSignal(text)) return "context_overflow";
	if (/rate.?limit|too.?many.?requests/.test(text)) return "rate_limited";
	if (
		/unauthori[sz]ed|forbidden|authentication|api.?key|permission.?denied/.test(
			text,
		)
	) {
		return "auth";
	}
	if (/abort|timeout|timed.?out|deadline|etimedout/.test(text))
		return "timeout";
	if (
		/unavailable|overloaded|connection|econnrefused|econnreset|enotfound|eai_again|fetch.?failed/.test(
			text,
		)
	) {
		return "unavailable";
	}
	if (/invalid.?request|bad.?request|validation|unprocessable/.test(text)) {
		return "invalid_request";
	}
	return undefined;
}

function kindFromMessage(message: string): ProviderFailureKind | undefined {
	if (hasContextSignal(message)) return "context_overflow";
	if (/rate.?limit|too.?many.?requests|429/.test(message)) {
		return "rate_limited";
	}
	if (
		/unauthori[sz]ed|forbidden|invalid.?api.?key|authentication/.test(message)
	) {
		return "auth";
	}
	if (/timed?.?out|timeout|deadline/.test(message)) return "timeout";
	if (
		/unavailable|overloaded|econnrefused|econnreset|enotfound|eai_again|fetch.?failed|network/.test(
			message,
		)
	) {
		return "unavailable";
	}
	if (/invalid.?request|bad.?request/.test(message)) return "invalid_request";
	return undefined;
}

/**
 * Classifies any thrown value. Structured fields (`status`, `statusCode`,
 * `code`, `name`) anywhere in the bounded `cause` chain win over the message
 * fallback, so a provider error wrapped by the agent library is still
 * classified. Unknown stays non-retryable.
 */
export function classifyProviderFailure(
	error: unknown,
): ProviderFailureClassification {
	const status = statusOf(error);
	const { codes, names } = structuredTextOf(error);
	const structured = `${codes} ${names}`.trim().toLowerCase();
	const message = messageOf(error).toLowerCase();
	const contextSignal = hasContextSignal(`${structured} ${message}`);

	const kind =
		(status === undefined
			? undefined
			: kindFromStatus(status, contextSignal)) ??
		kindFromStructured(structured) ??
		kindFromMessage(message) ??
		"unknown";

	return { kind, retryable: RETRYABLE_KINDS.has(kind) };
}

/**
 * Normalizes a provider failure into a stable `PlatformError`.
 *
 * An existing `PlatformError` is already normalized (and may carry a deliberate
 * retryability), so it is returned unchanged. Otherwise the raw error is kept
 * only as `cause`; it never appears in the message.
 */
export function toProviderError(error: unknown): PlatformError {
	if (isPlatformError(error)) return error;
	const { kind, retryable } = classifyProviderFailure(error);
	return new PlatformError(FAILURE_CODE[kind], FAILURE_MESSAGE[kind], {
		retryable,
		cause: error,
	});
}

/**
 * True for cancellation-shaped errors, which keep their original identity.
 * The bounded `cause` chain is checked too, so a cancellation wrapped by the
 * agent library is never retried or reclassified as a provider failure.
 */
export function isAbortLikeError(error: unknown): boolean {
	for (const link of causeChain(error)) {
		if (link instanceof Error && link.name === "AbortError") return true;
		const record = recordOf(link);
		if (record?.code === "ABORT_ERR" || record?.name === "AbortError") {
			return true;
		}
	}
	return false;
}
