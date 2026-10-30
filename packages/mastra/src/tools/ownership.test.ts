import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	createOwnershipMatcher,
	MAX_OWNERSHIP_PATH_LENGTH,
	MAX_OWNERSHIP_PATTERNS,
	normalizeOwnershipPath,
} from "./ownership";

function owns(patterns: readonly string[] | undefined, path: string): boolean {
	return createOwnershipMatcher(patterns).owns(path);
}

describe("ownership glob matcher", () => {
	test("literal paths match exactly", () => {
		const patterns = ["src/a.ts"];
		expect(owns(patterns, "src/a.ts")).toBe(true);
		expect(owns(patterns, "src/a.tsx")).toBe(false);
		expect(owns(patterns, "src/b.ts")).toBe(false);
		expect(owns(patterns, "./src/a.ts")).toBe(true);
	});
});

test("dir/** matches everything below a directory, not siblings", () => {
	const patterns = ["apps/web/**"];
	expect(owns(patterns, "apps/web/src/page.tsx")).toBe(true);
	expect(owns(patterns, "apps/web/a.ts")).toBe(true);
	expect(owns(patterns, "apps/web/a/b/c.ts")).toBe(true);
	expect(owns(patterns, "apps/web")).toBe(false);
	expect(owns(patterns, "apps/webhook/a.ts")).toBe(false);
	expect(owns(patterns, "apps/api/a.ts")).toBe(false);
});

test("**/*.ts spans segments at any depth, including the root", () => {
	const patterns = ["**/*.ts"];
	expect(owns(patterns, "a.ts")).toBe(true);
	expect(owns(patterns, "src/a.ts")).toBe(true);
	expect(owns(patterns, "src/deep/nested/a.ts")).toBe(true);
	expect(owns(patterns, "src/a.js")).toBe(false);
	expect(owns(patterns, "src/a.tsx")).toBe(false);
});

test("? matches exactly one character inside a segment", () => {
	const patterns = ["src/?.ts"];
	expect(owns(patterns, "src/a.ts")).toBe(true);
	expect(owns(patterns, "src/ab.ts")).toBe(false);
	expect(owns(patterns, "src//.ts")).toBe(false);
	expect(owns(patterns, "src/a/b.ts")).toBe(false);
});

test("* stays inside one segment", () => {
	const patterns = ["src/*.ts"];
	expect(owns(patterns, "src/a.ts")).toBe(true);
	expect(owns(patterns, "src/a/b.ts")).toBe(false);
});

test("backslashes are normalized on both sides", () => {
	expect(owns(["src/**"], "src\\a.ts")).toBe(true);
	expect(owns(["src\\**"], "src/a.ts")).toBe(true);
});

test("traversal candidates are never owned", () => {
	const patterns = ["**"];
	expect(owns(patterns, "../etc/passwd")).toBe(false);
	expect(owns(patterns, "src/../../etc/passwd")).toBe(false);
	expect(owns(patterns, "src/..")).toBe(false);
	expect(normalizeOwnershipPath("../etc/passwd")).toBeNull();
});

test("absolute paths, NUL, empty and over-long candidates are never owned", () => {
	const patterns = ["**"];
	expect(owns(patterns, "/etc/passwd")).toBe(false);
	expect(owns(patterns, "C:\\Windows\\a.ts")).toBe(false);
	expect(owns(patterns, "src/\u0000a.ts")).toBe(false);
	expect(owns(patterns, "")).toBe(false);
	expect(owns(patterns, ".")).toBe(false);
	expect(owns(patterns, "a".repeat(MAX_OWNERSHIP_PATH_LENGTH + 1))).toBe(false);
});

test("empty or absent ownership authorizes nothing", () => {
	expect(owns([], "src/a.ts")).toBe(false);
	expect(owns(undefined, "src/a.ts")).toBe(false);
});

test("malformed patterns are rejected with a bounded VALIDATION_FAILED", () => {
	const invalid = [
		["../**"],
		["/etc/**"],
		["C:\\Windows\\**"],
		["src/\u0000a.ts"],
		[""],
		["."],
		["a".repeat(MAX_OWNERSHIP_PATH_LENGTH + 1)],
	];
	for (const patterns of invalid) {
		expect(() => createOwnershipMatcher(patterns)).toThrow(PlatformError);
		try {
			createOwnershipMatcher(patterns);
		} catch (error) {
			expect(error).toBeInstanceOf(PlatformError);
			expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
			// Bounded: the offending pattern is never echoed.
			const pattern = patterns[0] ?? "";
			if (pattern !== "") {
				expect((error as PlatformError).message).not.toContain(pattern);
			}
		}
	}
});

test("more than 200 patterns is rejected", () => {
	const tooMany = Array.from(
		{ length: MAX_OWNERSHIP_PATTERNS + 1 },
		(_, index) => `src/f${index}.ts`,
	);
	expect(MAX_OWNERSHIP_PATTERNS).toBe(200);
	expect(() => createOwnershipMatcher(tooMany)).toThrow(PlatformError);
});

test("exactly 200 patterns is accepted", () => {
	const atLimit = Array.from(
		{ length: MAX_OWNERSHIP_PATTERNS },
		(_, index) => `src/f${index}.ts`,
	);
	const matcher = createOwnershipMatcher(atLimit);
	expect(matcher.owns("src/f0.ts")).toBe(true);
	expect(matcher.owns("src/f199.ts")).toBe(true);
	expect(matcher.owns("src/other.ts")).toBe(false);
});
