import { describe, expect, test } from "bun:test";
import {
	type PullRequestRecord,
	pullRequestRecordSchema,
	type ValidationReport,
	validationReportSchema,
} from "./review";

const report: ValidationReport = {
	command: "bun test",
	argv: ["bun", "test"],
	status: "passed",
	exitCode: 0,
	durationMs: 1234,
	outputBytes: 42,
	truncated: false,
};

const record: PullRequestRecord = {
	number: 7,
	url: "https://github.com/example/repo/pull/7",
	headBranch: "task/w8-demo",
	baseBranch: "main",
	headSha: "a".repeat(40),
};

describe("validationReportSchema", () => {
	test("accepts a bounded report", () => {
		expect(validationReportSchema.parse(report)).toEqual(report);
	});

	test("accepts unknown statuses nowhere: only passed/failed/skipped", () => {
		expect(
			validationReportSchema.safeParse({ ...report, status: "flaky" }).success,
		).toBe(false);
	});

	test("rejects an empty argv, a negative duration and unknown fields", () => {
		expect(
			validationReportSchema.safeParse({ ...report, argv: [] }).success,
		).toBe(false);
		expect(
			validationReportSchema.safeParse({ ...report, durationMs: -1 }).success,
		).toBe(false);
		expect(
			validationReportSchema.safeParse({ ...report, extra: true }).success,
		).toBe(false);
	});

	test("bounds the command and each argument", () => {
		expect(
			validationReportSchema.safeParse({ ...report, command: "x".repeat(513) })
				.success,
		).toBe(false);
		expect(
			validationReportSchema.safeParse({ ...report, argv: ["a".repeat(257)] })
				.success,
		).toBe(false);
	});
});

describe("pullRequestRecordSchema", () => {
	test("accepts an https PR record", () => {
		expect(pullRequestRecordSchema.parse(record)).toEqual(record);
	});

	test("rejects a non-https URL and a malformed head sha", () => {
		expect(
			pullRequestRecordSchema.safeParse({
				...record,
				url: "http://github.com/example/repo/pull/7",
			}).success,
		).toBe(false);
		expect(
			pullRequestRecordSchema.safeParse({ ...record, headSha: "not-a-sha" })
				.success,
		).toBe(false);
	});

	test("rejects unknown fields so a producer cannot smuggle a token", () => {
		expect(
			pullRequestRecordSchema.safeParse({ ...record, token: "secret" }).success,
		).toBe(false);
	});
});
