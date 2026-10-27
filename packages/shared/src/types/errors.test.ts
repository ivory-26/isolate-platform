import { describe, expect, test } from "bun:test";
import {
	BASE_ERROR_CODES,
	type ErrorCode,
	errorCodeOf,
	isPlatformError,
	PLATFORM_ERROR_CODES,
	PlatformError,
} from "./errors";

const ALL_CODES: readonly ErrorCode[] = [
	...BASE_ERROR_CODES,
	...PLATFORM_ERROR_CODES,
];

const EXPECTED_RETRYABLE: readonly ErrorCode[] = [
	"DB_UNAVAILABLE",
	"QUEUE_UNAVAILABLE",
	"LEASE_LOST",
	"AGENT_EXECUTION_FAILED",
	"SANDBOX_PROVISION_FAILED",
	"INTEGRATION_UNAVAILABLE",
];

describe("PlatformError", () => {
	test("error codes are unique", () => {
		expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
	});

	test("default retryability mapping is exactly the retryable set", () => {
		for (const code of ALL_CODES) {
			const error = new PlatformError(code, "synthetic probe");
			expect(error.retryable).toBe(EXPECTED_RETRYABLE.includes(code));
		}
	});

	test("explicit retryable option overrides the default", () => {
		expect(
			new PlatformError("VALIDATION_FAILED", "x", { retryable: true })
				.retryable,
		).toBe(true);
		expect(
			new PlatformError("DB_UNAVAILABLE", "x", { retryable: false }).retryable,
		).toBe(false);
	});

	test("exposes name and cause without stack emission helpers", () => {
		const cause = new Error("root failure");
		const error = new PlatformError("DB_UNAVAILABLE", "down", { cause });
		expect(error.name).toBe("PlatformError");
		expect((error as unknown as { cause: unknown }).cause).toBe(cause);
	});

	test("isPlatformError distinguishes platform errors", () => {
		expect(isPlatformError(new PlatformError("NOT_FOUND", "x"))).toBe(true);
		expect(isPlatformError(new Error("plain"))).toBe(false);
		expect(isPlatformError(null)).toBe(false);
		expect(isPlatformError("NOT_FOUND")).toBe(false);
	});

	test("errorCodeOf collapses unknown throwables to INTERNAL", () => {
		expect(errorCodeOf(new Error("boom with secret-looking text"))).toBe(
			"INTERNAL",
		);
		expect(errorCodeOf(undefined)).toBe("INTERNAL");
		expect(errorCodeOf(42)).toBe("INTERNAL");
		expect(errorCodeOf(new PlatformError("POLICY_DENIED", "denied"))).toBe(
			"POLICY_DENIED",
		);
	});
});
