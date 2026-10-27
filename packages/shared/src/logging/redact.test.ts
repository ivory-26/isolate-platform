import { describe, expect, test } from "bun:test";
import { MAX_REDACT_DEPTH, redactDeep } from "./redact";

describe("redactDeep", () => {
	test("redacts sensitive keys at any depth and reports their paths", () => {
		const { output, redacted } = redactDeep({
			organizationId: "org_1",
			config: {
				apiKey: "FAKE-SECRET-VALUE",
				nested: { accessToken: "FAKE-SECRET-VALUE" },
			},
		});
		expect(output).toEqual({
			organizationId: "org_1",
			config: {
				apiKey: "[redacted]",
				nested: { accessToken: "[redacted]" },
			},
		});
		expect(redacted).toEqual(["config.apiKey", "config.nested.accessToken"]);
	});

	test("sensitive keys win over traversal: entire subtree is elided", () => {
		const { output, redacted } = redactDeep({
			credentials: { user: "fake", password: "FAKE-SECRET-VALUE" },
		});
		expect(output).toEqual({ credentials: "[redacted]" });
		expect(redacted).toEqual(["credentials"]);
	});

	test("plain data passes through untouched", () => {
		const input = {
			a: 1,
			b: "two",
			c: { d: [1, 2, 3], e: null, f: true },
		};
		const { output, redacted } = redactDeep(input);
		expect(output).toEqual(input);
		expect(redacted).toEqual([]);
	});

	test("non-plain values become inert type markers", () => {
		class Thing {
			tag = "irrelevant";
		}
		const { output } = redactDeep({
			when: new Date(0),
			tags: new Set(["a"]),
			mapping: new Map([["a", 1]]),
			pattern: /x/,
			thing: new Thing(),
			fn: () => 1,
		});
		expect(output).toEqual({
			when: "[Date]",
			tags: "[Set]",
			mapping: "[Map]",
			pattern: "[RegExp]",
			thing: "[Thing]",
			fn: "[function]",
		});
	});

	test("errors never expose stacks or messages through markers", () => {
		const { output } = redactDeep({
			cause: new Error("sensitive stack trace content"),
		});
		expect(output).toEqual({ cause: "[Error]" });
	});

	test("depth is capped at MAX_REDACT_DEPTH", () => {
		// 8 nested objects: the innermost sits at depth 7 > 6.
		let tooDeep: Record<string, unknown> = { leaf: "bottom" };
		for (let index = 0; index < 7; index += 1) {
			tooDeep = { child: tooDeep };
		}
		const { output } = redactDeep(tooDeep);
		expect(JSON.stringify(output)).toBe(
			'{"child":{"child":{"child":{"child":{"child":{"child":{"child":"[truncated]"}}}}}}}',
		);
		expect(MAX_REDACT_DEPTH).toBe(6);
	});

	test("data within the cap is fully walked", () => {
		// 7 nested objects: innermost is at depth 6, so all leaves survive.
		let deep: Record<string, unknown> = { leaf: "bottom" };
		for (let index = 0; index < 6; index += 1) {
			deep = { child: deep };
		}
		const { output } = redactDeep(deep);
		expect(output).toEqual({
			child: {
				child: { child: { child: { child: { child: { leaf: "bottom" } } } } },
			},
		});
	});

	test("maxDepth option is clamped into the allowed range", () => {
		// 8 nested objects: same shape as the cap test above.
		let deep: Record<string, unknown> = { leaf: "bottom" };
		for (let index = 0; index < 7; index += 1) {
			deep = { child: deep };
		}
		const overCap = redactDeep(deep, { maxDepth: 999 });
		const atCap = redactDeep(deep);
		expect(overCap.output).toEqual(atCap.output);

		// maxDepth 0: only the root is walked, its children collapse.
		const zeroDepth = redactDeep(deep, { maxDepth: -3 });
		expect(zeroDepth.output).toEqual({ child: "[truncated]" });
	});

	test("large arrays are element-capped", () => {
		const items = Array.from({ length: 120 }, (_, index) => index);
		const { output } = redactDeep({ items });
		const walked = (output as { items: unknown[] }).items;
		expect(walked.length).toBe(101);
		expect(walked[100]).toBe("[truncated]");
	});

	test("cycles do not hang traversal", () => {
		const node: Record<string, unknown> = { name: "a" };
		node.self = node;
		const { output } = redactDeep({ node });
		expect(output).toEqual({
			node: { name: "a", self: "[circular]" },
		});
	});

	test("bigint values are coerced to strings for JSON safety", () => {
		const { output } = redactDeep({ count: 10n, small: 1 });
		expect(output).toEqual({ count: "10", small: 1 });
		expect(JSON.stringify(output)).toBe('{"count":"10","small":1}');
	});

	test("symbol values do not survive", () => {
		const { output } = redactDeep({ marker: Symbol("opaque") });
		expect(output).toEqual({ marker: "[symbol]" });
	});

	test("root-level sensitive keys are redacted", () => {
		const { output, redacted } = redactDeep({
			password: "FAKE-SECRET-VALUE",
		});
		expect(output).toEqual({ password: "[redacted]" });
		expect(redacted).toEqual(["password"]);
	});
});
