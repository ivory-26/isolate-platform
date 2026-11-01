import { z } from "zod";

/**
 * Client-safe usage contracts. A period is one of three fixed windows; the
 * server resolves the UTC boundaries, never the browser.
 */
export const usagePeriods = [7, 30, 90] as const;
export type UsagePeriod = (typeof usagePeriods)[number];
export const DEFAULT_USAGE_PERIOD: UsagePeriod = 30;
export const USAGE_TIME_ZONE = "UTC" as const;

export function parseUsagePeriod(value: unknown): UsagePeriod {
	const candidate =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: NaN;
	return usagePeriods.includes(candidate as UsagePeriod)
		? (candidate as UsagePeriod)
		: DEFAULT_USAGE_PERIOD;
}

export type UsageSearch = { period: UsagePeriod };

/** URL search parser; an absent or invalid period falls back to 30 days. */
export function parseUsageSearch(search: Record<string, unknown>): UsageSearch {
	return { period: parseUsagePeriod(search.period) };
}

export const usageRequestSchema = z.strictObject({
	period: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
});
export type UsageRequest = z.output<typeof usageRequestSchema>;

/**
 * How much of a day's cost total rests on trusted prices:
 * - `complete`: every usage row carried a cost;
 * - `partial`: at least one row carried a cost and at least one did not;
 * - `none`: no row carried a price, so the amount is null.
 */
export type CostCoverage = "complete" | "partial" | "none";

export type UsageDay = {
	/** UTC calendar day, `YYYY-MM-DD`. */
	day: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	sandboxSeconds: number;
	/** Exact decimal string, or null when no row carried a trusted price. */
	costUsd: string | null;
	costCoverage: CostCoverage;
};

export type UsageTotals = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	sandboxSeconds: number;
	/** Exact decimal string, or null when no row carried a trusted price. */
	costUsd: string | null;
	costCoverage: CostCoverage;
	/** Distinct tasks represented by usage rows in the window. */
	tasks: number;
};

export type UsageReadModel = {
	period: UsagePeriod;
	/** Inclusive UTC start, ISO instant. */
	since: string;
	/** Exclusive UTC end, ISO instant. */
	until: string;
	timeZone: typeof USAGE_TIME_ZONE;
	totals: UsageTotals;
	days: UsageDay[];
	/** True when at least one usage row or measured sandbox second exists. */
	hasRows: boolean;
};
