import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	classifyProviderFailure,
	isAbortLikeError,
	MAX_PROVIDER_RETRY_ATTEMPTS,
	toProviderError,
} from "./failure";

function withFields(
	fields: Record<string, unknown>,
	message = "provider failed",
): Error {
	return Object.assign(new Error(message), fields);
}

describe("classifyProviderFailure", () => {
	const cases: Array<{
		label: string;
		error: unknown;
		kind: ReturnType<typeof classifyProviderFailure>["kind"];
		retryable: boolean;
	}> = [
		{
			label: "HTTP 429",
			error: withFields({ status: 429 }),
			kind: "rate_limited",
			retryable: true,
		},
		{
			label: "rate-limit code without a status",
			error: withFields({ code: "rate_limit_exceeded" }),
			kind: "rate_limited",
			retryable: true,
		},
		{
			label: "HTTP 401",
			error: withFields({ status: 401 }),
			kind: "auth",
			retryable: false,
		},
		{
			label: "HTTP 403",
			error: withFields({ statusCode: 403 }),
			kind: "auth",
			retryable: false,
		},
		{
			label: "HTTP 408",
			error: withFields({ status: 408 }),
			kind: "timeout",
			retryable: true,
		},
		{
			label: "HTTP 500",
			error: withFields({ status: 500 }),
			kind: "unavailable",
			retryable: true,
		},
		{
			label: "HTTP 503",
			error: withFields({ response: { status: 503 } }),
			kind: "unavailable",
			retryable: true,
		},
		{
			label: "HTTP 400",
			error: withFields({ status: 400 }),
			kind: "invalid_request",
			retryable: false,
		},
		{
			label: "HTTP 400 with a context-length code",
			error: withFields({ status: 400, code: "context_length_exceeded" }),
			kind: "context_overflow",
			retryable: false,
		},
		{
			label: "context code without a status",
			error: withFields({ code: "context_overflow" }),
			kind: "context_overflow",
			retryable: false,
		},
		{
			label: "TimeoutError name",
			error: withFields({ name: "TimeoutError" }),
			kind: "timeout",
			retryable: true,
		},
		{
			label: "RateLimitError name",
			error: withFields({ name: "RateLimitError" }),
			kind: "rate_limited",
			retryable: true,
		},
		{
			label: "connection-refused message",
			error: new TypeError("socket ECONNREFUSED 127.0.0.1:443"),
			kind: "unavailable",
			retryable: true,
		},
		{
			label: "invalid-key message",
			error: new Error("invalid api key supplied"),
			kind: "auth",
			retryable: false,
		},
		{
			label: "prompt-too-long message",
			error: new Error("prompt is too long for this model"),
			kind: "context_overflow",
			retryable: false,
		},
		{
			label: "rate-limit message",
			error: new Error("rate limit exceeded, retry later"),
			kind: "rate_limited",
			retryable: true,
		},
		{
			label: "unknown error",
			error: new TypeError("boom"),
			kind: "unknown",
			retryable: false,
		},
		{
			label: "unknown thrown value",
			error: null,
			kind: "unknown",
			retryable: false,
		},
	];

	for (const entry of cases) {
		test(`classifies ${entry.label}`, () => {
			expect(classifyProviderFailure(entry.error)).toEqual({
				kind: entry.kind,
				retryable: entry.retryable,
			});
		});
	}

	test("honours the configured retry-attempt ceiling", () => {
		expect(MAX_PROVIDER_RETRY_ATTEMPTS).toBe(3);
	});
});

describe("toProviderError", () => {
	test("maps each kind to a stable code and retryability", () => {
		expect(toProviderError(withFields({ status: 429 }))).toMatchObject({
			code: "RATE_LIMITED",
			retryable: true,
		});
		expect(toProviderError(withFields({ status: 401 }))).toMatchObject({
			code: "AGENT_EXECUTION_FAILED",
			retryable: false,
		});
		expect(toProviderError(withFields({ status: 408 }))).toMatchObject({
			code: "INTEGRATION_UNAVAILABLE",
			retryable: true,
		});
		expect(
			toProviderError(withFields({ code: "context_length_exceeded" })),
		).toMatchObject({
			code: "BUDGET_EXCEEDED",
			retryable: false,
		});
		expect(toProviderError(withFields({ status: 400 }))).toMatchObject({
			code: "VALIDATION_FAILED",
			retryable: false,
		});
		expect(toProviderError(new TypeError("boom"))).toMatchObject({
			code: "AGENT_EXECUTION_FAILED",
			retryable: false,
		});
	});

	test("unknown provider payloads never reach the message", () => {
		const error = toProviderError(
			new Error("failed at https://user:secret@provider.internal?api_key=zzz"),
		);
		expect(error).toBeInstanceOf(PlatformError);
		expect(error.message).toBe("provider call failed");
		expect(JSON.stringify(error.message)).not.toContain("secret");
		expect(JSON.stringify(error.message)).not.toContain("provider.internal");
	});

	test("keeps the original error only as cause", () => {
		const original = withFields({ status: 429 }, "raw provider body");
		const error = toProviderError(original);
		expect(error.cause).toBe(original);
		expect(error.message).not.toContain("raw provider body");
	});

	test("does not re-wrap an existing PlatformError", () => {
		const existing = new PlatformError("POLICY_DENIED", "denied");
		expect(toProviderError(existing)).toBe(existing);
	});
});

describe("isAbortLikeError", () => {
	test("recognizes abort-shaped errors without classifying them", () => {
		const abortError = Object.assign(new Error("aborted"), {
			name: "AbortError",
		});
		expect(isAbortLikeError(abortError)).toBe(true);
		expect(isAbortLikeError(withFields({ code: "ABORT_ERR" }))).toBe(true);
		expect(isAbortLikeError(new Error("boom"))).toBe(false);
		expect(isAbortLikeError(null)).toBe(false);
	});
});
