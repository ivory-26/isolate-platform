import { describe, expect, test } from "bun:test";
import {
	aggregateUsage,
	buildUsageWindow,
	costMicros,
	formatUsd,
} from "./aggregate";
import { parseUsagePeriod, parseUsageSearch } from "./contracts";

const NOW = new Date("2026-11-15T23:30:00.000Z");

function usage(overrides: Record<string, unknown> = {}) {
	return {
		day: "2026-11-14",
		prompt_tokens: 100,
		completion_tokens: "40",
		cost_usd: "0.100000",
		known_cost_rows: 1,
		total_rows: 1,
		...overrides,
	};
}

describe("parseUsagePeriod", () => {
	test("accepts the enumerated periods from URL strings or numbers", () => {
		expect(parseUsagePeriod("7")).toBe(7);
		expect(parseUsagePeriod(30)).toBe(30);
		expect(parseUsagePeriod("90")).toBe(90);
	});

	test("falls back to 30 for anything else", () => {
		for (const value of ["14", 0, -7, null, undefined, "abc", 7.5]) {
			expect(parseUsagePeriod(value)).toBe(30);
		}
	});

	test("parses the URL search object", () => {
		expect(parseUsageSearch({ period: "7" })).toEqual({ period: 7 });
		expect(parseUsageSearch({})).toEqual({ period: 30 });
	});
});

describe("buildUsageWindow", () => {
	test("builds an inclusive N-day UTC window ending today", () => {
		const window = buildUsageWindow(7, NOW);
		expect(window.since.toISOString()).toBe("2026-11-09T00:00:00.000Z");
		expect(window.until.toISOString()).toBe("2026-11-16T00:00:00.000Z");
		expect(window.days).toHaveLength(7);
		expect(window.days[0]).toBe("2026-11-09");
		expect(window.days[6]).toBe("2026-11-15");
	});

	test("handles a month boundary in UTC", () => {
		const window = buildUsageWindow(30, new Date("2026-03-01T00:10:00.000Z"));
		expect(window.since.toISOString()).toBe("2026-01-31T00:00:00.000Z");
		expect(window.days[0]).toBe("2026-01-31");
		expect(window.days.at(-1)).toBe("2026-03-01");
	});
});

describe("aggregateUsage", () => {
	test("fills every UTC day and sums exact costs without float drift", () => {
		const model = aggregateUsage({
			period: 7,
			now: NOW,
			usageRows: [
				usage({ day: "2026-11-13", cost_usd: "0.100000" }),
				usage({ day: "2026-11-14", cost_usd: "0.200000" }),
			],
			sandboxRows: [],
			taskCount: "2",
		});
		expect(model.days).toHaveLength(7);
		expect(model.days[0]).toMatchObject({
			day: "2026-11-09",
			totalTokens: 0,
			costUsd: null,
			costCoverage: "none",
		});
		expect(model.days.at(-1)).toMatchObject({
			day: "2026-11-15",
			totalTokens: 0,
		});
		expect(model.days.find((day) => day.day === "2026-11-14")).toMatchObject({
			promptTokens: 100,
			completionTokens: 40,
			totalTokens: 140,
			costUsd: "0.200000",
			costCoverage: "complete",
		});
		expect(model.totals.costUsd).toBe("0.300000");
		expect(model.totals.totalTokens).toBe(280);
		expect(model.totals.tasks).toBe(2);
		expect(model.hasRows).toBe(true);
	});

	test("keeps an unknown price null, never a fabricated zero", () => {
		const model = aggregateUsage({
			period: 7,
			now: NOW,
			usageRows: [
				usage({
					known_cost_rows: 0,
					cost_usd: null,
				}),
			],
			sandboxRows: [],
			taskCount: 1,
		});
		const day = model.days.find((entry) => entry.day === "2026-11-14");
		expect(day?.costUsd).toBeNull();
		expect(day?.costCoverage).toBe("none");
		expect(model.totals.costUsd).toBeNull();
	});

	test("marks a partially priced day and totals the known rows", () => {
		const model = aggregateUsage({
			period: 7,
			now: NOW,
			usageRows: [
				usage({
					known_cost_rows: 1,
					total_rows: 3,
					cost_usd: "0.050000",
					prompt_tokens: 10,
					completion_tokens: 0,
				}),
			],
			sandboxRows: [],
			taskCount: 1,
		});
		const day = model.days.find((entry) => entry.day === "2026-11-14");
		expect(day?.costCoverage).toBe("partial");
		expect(day?.costUsd).toBe("0.050000");
		expect(model.totals.costCoverage).toBe("partial");
	});

	test("sums measured sandbox seconds and floors the total", () => {
		const model = aggregateUsage({
			period: 7,
			now: NOW,
			usageRows: [],
			sandboxRows: [
				{ day: "2026-11-14", sandbox_seconds: "12.8" },
				{ day: "2026-11-15", sandbox_seconds: 7 },
				{ day: "2026-10-01", sandbox_seconds: 99 },
			],
			taskCount: 0,
		});
		expect(model.totals.sandboxSeconds).toBe(19);
		expect(model.hasRows).toBe(true);
		expect(model.totals.costUsd).toBeNull();
	});

	test("reports an empty model when nothing was recorded", () => {
		const model = aggregateUsage({
			period: 30,
			now: NOW,
			usageRows: [],
			sandboxRows: [],
			taskCount: 0,
		});
		expect(model.hasRows).toBe(false);
		expect(model.days).toHaveLength(30);
		expect(model.totals).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			sandboxSeconds: 0,
			costUsd: null,
			costCoverage: "none",
			tasks: 0,
		});
	});
});

describe("cost helpers", () => {
	test("parses exact decimals into micro-dollars", () => {
		expect(costMicros("0.100000")).toBe(100_000n);
		expect(costMicros("12")).toBe(12_000_000n);
		expect(costMicros(null)).toBeNull();
	});

	test("formats small and large amounts without losing sub-cent precision", () => {
		expect(formatUsd("0.000001")).toContain("0.000001");
		expect(formatUsd("1.234567")).toBe("$1.23");
		expect(formatUsd(null)).toBe("—");
	});
});
