import {
	BASE_ERROR_CODES,
	type ErrorCode,
	isPlatformError,
	PLATFORM_ERROR_CODES,
} from "@isolate/shared";

/**
 * Error sanitisation for the worker boundary.
 *
 * Anything that crosses process/organization boundaries (queue `lastError`
 * columns, audit rows, logs) must carry a bounded `ErrorCode` and a message
 * free of payloads, stack frames, URLs with credentials, or tokens.
 */

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
	...BASE_ERROR_CODES,
	...PLATFORM_ERROR_CODES,
]);

/** Clamp an arbitrary string to a real ErrorCode; unknown values collapse. */
export function clampErrorCode(code: string): ErrorCode {
	return KNOWN_CODES.has(code) ? (code as ErrorCode) : "INTERNAL";
}

/** Static fallback so no raw thrown text ever leaves the handler boundary. */
export const INTERNAL_FAILURE_MESSAGE =
	"internal handler failure (details withheld)";

/** Hard cap for materialised messages. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Collapse whitespace, drop every URL (they can embed credentials), drop
 * bearer-style credentials, and cap the length. Never throws.
 */
export function sanitizeMessage(raw: string, maxLength = MAX_MESSAGE_LENGTH) {
	const collapsed = raw.replace(/\s+/g, " ").trim();
	const stripped = collapsed
		.replace(/https?:\/\/\S+/gi, "[url]")
		.replace(/bearer\s+\S+/gi, "[redacted]")
		.replace(/api[-_]?key\s*[=:]\s*\S+/gi, "[redacted]");
	return stripped.slice(0, maxLength);
}

/** Provider HTTP responses that are worth another attempt. */
const TRANSIENT_PROVIDER_STATUS: ReadonlySet<number> = new Set([
	408, 409, 425, 429,
]);

/**
 * True when an inference/SDK error carries a provider HTTP status that will not
 * change on retry (bad request, auth, model deactivated). Retrying such a call
 * is pure spend: each attempt provisions a fresh sandbox first.
 */
export function isDeterministicProviderRejection(error: unknown): boolean {
	const status = (error as { statusCode?: unknown } | null)?.statusCode;
	if (typeof status !== "number" || !Number.isInteger(status)) return false;
	return (
		status >= 400 && status < 500 && !TRANSIENT_PROVIDER_STATUS.has(status)
	);
}

export type AckError = {
	code: ErrorCode;
	message: string;
	retryable: boolean;
};

/**
 * Maps a thrown value to a safe ack payload. Known PlatformErrors keep their
 * code with a sanitised message; everything else collapses to INTERNAL with a
 * static message — raw error text, stacks, and payloads never leave here.
 */
export function toAckError(value: unknown): AckError {
	if (isPlatformError(value)) {
		const message = sanitizeMessage(value.message) || INTERNAL_FAILURE_MESSAGE;
		return {
			code: clampErrorCode(value.code),
			message,
			retryable: value.retryable,
		};
	}
	return {
		code: "INTERNAL",
		message: INTERNAL_FAILURE_MESSAGE,
		retryable: false,
	};
}
