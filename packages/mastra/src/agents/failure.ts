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

/** Structured HTTP status from `status`, `statusCode` or `response.status`. */
function statusOf(error: unknown): number | undefined {
	const record = recordOf(error);
	if (record === undefined) return undefined;
	const candidates = [
		record.status,
		record.statusCode,
		recordOf(record.response)?.status,
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

function structuredCode(error: unknown): string {
	const record = recordOf(error);
	if (record === undefined) return "";
	const raw = record.code ?? record.errorCode ?? record.type;
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
	return "";
}

function structuredName(error: unknown): string {
	const record = recordOf(error);
	const raw = record?.name ?? (error instanceof Error ? error.name : "");
	return typeof raw === "string" ? raw : "";
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === "string" ? error : "";
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
 * `code`, `name`) win over the message fallback. Unknown stays non-retryable.
 */
export function classifyProviderFailure(
	error: unknown,
): ProviderFailureClassification {
	const status = statusOf(error);
	const codeText = structuredCode(error);
	const nameText = structuredName(error);
	const structured = `${codeText} ${nameText}`.trim().toLowerCase();
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

/** True for cancellation-shaped errors, which keep their original identity. */
export function isAbortLikeError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	const record = recordOf(error);
	return record?.code === "ABORT_ERR" || record?.name === "AbortError";
}
