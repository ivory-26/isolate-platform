import { describe, expect, test } from "bun:test";
import { PlatformError, runSummarySchema } from "@isolate/shared";
import {
	buildRunSummary,
	type RunSummaryInput,
	validationOutcomeFromAttempts,
} from "./run-summary";

function input(overrides: Partial<RunSummaryInput> = {}): RunSummaryInput {
	return {
		task: {
			id: "task_1",
			status: "review_ready",
			pull_request_number: null,
			pull_request_url: null,
		},
		usage: [],
		attempts: [],
		artifacts: [],
		...overrides,
	};
}

describe("buildRunSummary", () => {
	test("rolls up tokens, measured sandbox seconds, attempts and artifacts", () => {
		const summary = buildRunSummary(
			input({
				task: {
					id: "task_1",
					status: "review_ready",
					pull_request_number: 7,
					pull_request_url: "https://github.com/acme/widget/pull/7",
				},
				usage: [
					{
						prompt_tokens: 120,
						completion_tokens: 30,
						cost_usd: "0.000120",
					},
					{
						prompt_tokens: null,
						completion_tokens: null,
						cost_usd: "0.000030",
					},
				],
				attempts: [
					{
						outcome: {
							status: "failed",
							sandboxSeconds: 12,
							validation: { status: "failed" },
						},
					},
					{
						outcome: {
							status: "review_ready",
							sandboxSeconds: 41,
							validation: { status: "passed" },
						},
					},
				],
				artifacts: [{ id: "a1" }, { id: "a2" }, { id: "a3" }],
			}),
		);

		expect(summary).toEqual({
			taskId: "task_1",
			status: "review_ready",
			promptTokens: 120,
			completionTokens: 30,
			sandboxSeconds: 53,
			costUsd: 0.00015,
			attempts: 2,
			artifacts: 3,
			// The latest attempt's gate wins.
			validation: "passed",
			pullRequest: {
				number: 7,
				url: "https://github.com/acme/widget/pull/7",
			},
		});
		expect(runSummarySchema.safeParse(summary).success).toBe(true);
	});

	test("no priced usage row and no pull request keep nulls, never zeros", () => {
		const summary = buildRunSummary(
			input({
				task: {
					id: "task_2",
					status: "queued",
					pull_request_number: null,
					pull_request_url: null,
				},
				usage: [{ prompt_tokens: 10, completion_tokens: 5, cost_usd: null }],
			}),
		);
		expect(summary.costUsd).toBeNull();
		expect(summary.validation).toBeNull();
		expect(summary.pullRequest).toBeNull();
		expect(summary.sandboxSeconds).toBe(0);
		expect(runSummarySchema.safeParse(summary).success).toBe(true);
	});

	test("costs sum exactly at 6 decimal places", () => {
		const summary = buildRunSummary(
			input({
				usage: [
					{ prompt_tokens: 0, completion_tokens: 0, cost_usd: "0.000001" },
					{ prompt_tokens: 0, completion_tokens: 0, cost_usd: "0.000002" },
					{ prompt_tokens: 0, completion_tokens: 0, cost_usd: 0.1 },
					{ prompt_tokens: 0, completion_tokens: 0, cost_usd: 0.2 },
				],
			}),
		);
		expect(summary.costUsd).toBe(0.300003);
	});

	test("malformed cost rows fail closed instead of understating spend", () => {
		expect(() =>
			buildRunSummary(
				input({
					usage: [
						{ prompt_tokens: 0, completion_tokens: 0, cost_usd: "0.01" },
						{ prompt_tokens: 0, completion_tokens: 0, cost_usd: "not-money" },
					],
				}),
			),
		).toThrow(PlatformError);
		expect(() =>
			buildRunSummary(
				input({
					usage: [{ prompt_tokens: 0, completion_tokens: 0, cost_usd: -1 }],
				}),
			),
		).toThrow(/cost/);
	});

	test("malformed token counts fail closed", () => {
		expect(() =>
			buildRunSummary(
				input({
					usage: [{ prompt_tokens: 1.5, completion_tokens: 0, cost_usd: null }],
				}),
			),
		).toThrow(PlatformError);
	});

	test("an explicit validation outcome wins over the attempt rows", () => {
		const summary = buildRunSummary(
			input({
				attempts: [{ outcome: { validation: { status: "failed" } } }],
				validation: "skipped",
			}),
		);
		expect(summary.validation).toBe("skipped");
	});

	test("bounded: unknown attempt outcome shapes are ignored safely", () => {
		const summary = buildRunSummary(
			input({
				attempts: [
					{ outcome: null },
					{ outcome: "not-an-object" },
					{ outcome: { sandboxSeconds: "many", validation: { status: "x" } } },
					{ outcome: { sandboxSeconds: 3.9 } },
				],
			}),
		);
		expect(summary.sandboxSeconds).toBe(3);
		expect(summary.validation).toBeNull();
		expect(summary.attempts).toBe(4);
	});

	test("a pull request record needs both a positive number and a url", () => {
		expect(
			buildRunSummary(
				input({
					task: {
						id: "task_3",
						status: "pull_request_created",
						pull_request_number: 9,
						pull_request_url: null,
					},
				}),
			).pullRequest,
		).toBeNull();
		expect(
			buildRunSummary(
				input({
					task: {
						id: "task_3",
						status: "pull_request_created",
						pull_request_number: null,
						pull_request_url: "https://github.com/acme/widget/pull/9",
					},
				}),
			).pullRequest,
		).toBeNull();
	});
});

describe("validationOutcomeFromAttempts", () => {
	test("reads the newest attempt first and ignores unknown statuses", () => {
		expect(
			validationOutcomeFromAttempts([
				{ outcome: { validation: { status: "failed" } } },
				{ outcome: { validation: { status: "flaky" } } },
			]),
		).toBe("failed");
		expect(validationOutcomeFromAttempts([])).toBeNull();
	});
});
