import { describe, expect, test } from "bun:test";
import {
	type AcceptanceReport,
	acceptanceCheckSchema,
	acceptanceReportSchema,
} from "./acceptance";

describe("acceptance checks", () => {
	test("accepts the three bounded check kinds", () => {
		expect(
			acceptanceCheckSchema.parse({ kind: "path_exists", path: "src/app.ts" }),
		).toEqual({ kind: "path_exists", path: "src/app.ts" });
		expect(
			acceptanceCheckSchema.parse({
				kind: "content_matches",
				path: "README.md",
				pattern: "^# ",
			}).kind,
		).toBe("content_matches");
		expect(
			acceptanceCheckSchema.parse({
				kind: "command_exit_zero",
				command: "bun test",
			}).kind,
		).toBe("command_exit_zero");
	});

	test("rejects absolute paths, traversal and unknown fields", () => {
		expect(
			acceptanceCheckSchema.safeParse({
				kind: "path_exists",
				path: "/etc/passwd",
			}).success,
		).toBe(false);
		expect(
			acceptanceCheckSchema.safeParse({
				kind: "path_exists",
				path: "../outside",
			}).success,
		).toBe(false);
		expect(
			acceptanceCheckSchema.safeParse({
				kind: "path_exists",
				path: "ok.txt",
				extra: true,
			}).success,
		).toBe(false);
	});

	test("rejects unbounded commands and patterns", () => {
		expect(
			acceptanceCheckSchema.safeParse({
				kind: "command_exit_zero",
				command: "x".repeat(513),
			}).success,
		).toBe(false);
		expect(
			acceptanceCheckSchema.safeParse({
				kind: "content_matches",
				path: "a.txt",
				pattern: "x".repeat(201),
			}).success,
		).toBe(false);
	});
});

describe("acceptance report", () => {
	test("round-trips a bounded report", () => {
		const report: AcceptanceReport = {
			passed: true,
			matched: 1,
			total: 1,
			checks: [{ kind: "path_exists", target: "src/app.ts", passed: true }],
			durationMs: 12,
		};
		expect(acceptanceReportSchema.parse(report)).toEqual(report);
	});

	test("rejects counts above the total and unknown fields", () => {
		expect(
			acceptanceReportSchema.safeParse({
				passed: false,
				matched: 2,
				total: 1,
				checks: [],
				durationMs: 1,
			}).success,
		).toBe(false);
		expect(
			acceptanceReportSchema.safeParse({
				passed: true,
				matched: 0,
				total: 0,
				checks: [],
				durationMs: 0,
				extra: 1,
			}).success,
		).toBe(false);
	});
});
