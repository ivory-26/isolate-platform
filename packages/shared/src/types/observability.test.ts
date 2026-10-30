import { describe, expect, test } from "bun:test";
import {
	costPriceTableSchema,
	modelCallCostUsd,
	type RunSummary,
	runSummarySchema,
	sandboxCostUsd,
} from "./observability";

const table = costPriceTableSchema.parse({
	models: [
		{
			modelId: "muse-spark-1.3-contributor",
			promptTokenUsdPerMillion: 1.5,
			completionTokenUsdPerMillion: 6,
		},
	],
	sandbox: { cpuSecondUsd: 0.0001, gibSecondUsd: 0.00005 },
});

describe("cost table", () => {
	test("computes an exact model cost to six decimals", () => {
		// 1_000_000 prompt * 1.5 + 1_000_000 completion * 6 = 7.5 USD
		expect(
			modelCallCostUsd(
				{
					modelId: "muse-spark-1.3-contributor",
					promptTokens: 1_000_000,
					completionTokens: 1_000_000,
				},
				table,
			),
		).toBe(7.5);
	});

	test("an unknown model or no table yields null, never zero", () => {
		expect(
			modelCallCostUsd(
				{ modelId: "other", promptTokens: 10, completionTokens: 10 },
				table,
			),
		).toBeNull();
		expect(
			modelCallCostUsd(
				{
					modelId: "muse-spark-1.3-contributor",
					promptTokens: 1,
					completionTokens: 1,
				},
				null,
			),
		).toBeNull();
	});

	test("sandbox cost uses provisioned cpu and GiB-seconds", () => {
		// 60s * (0.5 cpu * 0.0001 + 0.5 GiB * 0.00005) = 0.0045
		expect(
			sandboxCostUsd({ cpuCount: 0.5, memoryMb: 512, seconds: 60 }, table),
		).toBe(0.0045);
	});

	test("rejects a malformed table", () => {
		expect(
			costPriceTableSchema.safeParse({
				models: [],
				sandbox: { cpuSecondUsd: -1, gibSecondUsd: 0 },
			}).success,
		).toBe(false);
	});
});

describe("run summary", () => {
	test("accepts a bounded rollup with null cost and no PR", () => {
		const summary: RunSummary = {
			taskId: "t1",
			status: "review_ready",
			promptTokens: 10,
			completionTokens: 5,
			sandboxSeconds: 42,
			costUsd: null,
			attempts: 1,
			artifacts: 2,
			validation: "passed",
			pullRequest: null,
		};
		expect(runSummarySchema.parse(summary)).toEqual(summary);
	});

	test("rejects unknown validation outcomes and negative counters", () => {
		const base = {
			taskId: "t1",
			status: "failed",
			promptTokens: 0,
			completionTokens: 0,
			sandboxSeconds: 0,
			costUsd: 0,
			attempts: 0,
			artifacts: 0,
			validation: null,
			pullRequest: null,
		};
		expect(
			runSummarySchema.safeParse({ ...base, validation: "flaky" }).success,
		).toBe(false);
		expect(
			runSummarySchema.safeParse({ ...base, promptTokens: -1 }).success,
		).toBe(false);
	});
});
