import { describe, expect, test } from "bun:test";
import { PlatformError } from "./errors";
import { err, isErr, isOk, ok, type Result } from "./result";

type Fetch = Result<number>;

describe("Result helpers", () => {
	test("ok wraps the value", () => {
		const r = ok(3);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toBe(3);
		}
	});

	test("err wraps the typed error", () => {
		const failure = new PlatformError("NOT_FOUND", "task missing");
		const r = err(failure);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.code).toBe("NOT_FOUND");
		}
	});

	test("isOk narrows result unions", () => {
		const results: Fetch[] = [ok(3), err(new PlatformError("NOT_FOUND", "x"))];
		for (const r of results) {
			if (isOk(r)) {
				expect(r.value).toBe(3);
			}
		}
	});

	test("isErr narrows result unions", () => {
		const failure = new PlatformError("POLICY_DENIED", "tool denied");
		const r = err(failure);
		if (isErr(r)) {
			expect(r.error.retryable).toBe(false);
		}
	});

	test("isOk and isErr are mutually exclusive", () => {
		const r: Fetch = ok(1);
		expect(isOk(r)).toBe(!isErr(r));
	});
});
