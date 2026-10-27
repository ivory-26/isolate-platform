/**
 * Canonical, bounded error codes across the platform.
 *
 * These are stable API surface: server responses, DB `error_code` columns, and
 * audit records use them. Values carry no secrets; messages built from user or
 * repository content must be sanitised by the caller before they reach here.
 */
export const BASE_ERROR_CODES = [
	"VALIDATION_FAILED",
	"MISSING_CONFIG",
	"AGENT_EXECUTION_FAILED",
	"DB_UNAVAILABLE",
	"RATE_LIMITED",
	"NOT_FOUND",
	"INTERNAL",
] as const;

export const PLATFORM_ERROR_CODES = [
	"TASK_NOT_FOUND",
	"INVALID_TRANSITION",
	"QUEUE_UNAVAILABLE",
	"LEASE_LOST",
	"APPROVAL_REQUIRED",
	"APPROVAL_REJECTED",
	"APPROVAL_EXPIRED",
	"POLICY_DENIED",
	"BUDGET_EXCEEDED",
	"SANDBOX_PROVISION_FAILED",
	"GIT_OPERATION_FAILED",
	"INTEGRATION_UNAVAILABLE",
	"DEPENDENCY_CONFLICT",
] as const;

export type ErrorCode =
	| (typeof BASE_ERROR_CODES)[number]
	| (typeof PLATFORM_ERROR_CODES)[number];

/** Which codes are safe to retry automatically (bounded, idempotent units). */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
	"DB_UNAVAILABLE",
	"QUEUE_UNAVAILABLE",
	"LEASE_LOST",
	"AGENT_EXECUTION_FAILED",
	"SANDBOX_PROVISION_FAILED",
	"INTEGRATION_UNAVAILABLE",
]);

export class PlatformError extends Error {
	override readonly name = "PlatformError";
	readonly code: ErrorCode;
	readonly retryable: boolean;

	constructor(
		code: ErrorCode,
		message: string,
		options?: { retryable?: boolean; cause?: unknown },
	) {
		super(
			message,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.code = code;
		this.retryable = options?.retryable ?? RETRYABLE_CODES.has(code);
	}
}

export function isPlatformError(value: unknown): value is PlatformError {
	return value instanceof PlatformError;
}

/**
 * Maps any thrown value to a safe `code` string. Never emits raw error text:
 * unknown errors collapse to `INTERNAL`.
 */
export function errorCodeOf(value: unknown): ErrorCode {
	return isPlatformError(value) ? value.code : "INTERNAL";
}
