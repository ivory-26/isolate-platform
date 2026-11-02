import { z } from "zod";

/**
 * Client-safe usage contracts. A period is one of three fixed windows; the
 * server resolves the UTC boundaries, never the browser.
 */
export const usagePeriods = [7, 30, 90] as const;
export type UsagePeriod = (typeof usagePeriods)[number];
export const DEFAULT_USAGE_PERIOD: UsagePeriod = 30;
export const USAGE_TIME_ZONE = "UTC" as const;
/** Daily breakdown rows per page. */
export const USAGE_PAGE_SIZE = 14;
export const DEFAULT_USAGE_PAGE = 1;
/**
 * The longest period bounds how many pages a URL may ask for, so a hand-edited
 * `page` can never request an unbounded slice.
 */
export const USAGE_MAX_PAGE = Math.ceil(
	Math.max(...usagePeriods) / USAGE_PAGE_SIZE,
);

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

/**
 * Page numbers are whole, positive and bounded by the longest period. Anything
 * else falls back to the first page; the table clamps again to its real page
 * count once the days are known.
 */
export function parseUsagePage(value: unknown): number {
	const candidate =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: NaN;
	if (!Number.isInteger(candidate) || candidate < 1) {
		return DEFAULT_USAGE_PAGE;
	}
	return Math.min(candidate, USAGE_MAX_PAGE);
}

export type UsageSearch = { period: UsagePeriod; page: number };

/**
 * URL search parser; an absent or invalid period falls back to 30 days and an
 * absent or invalid page falls back to the first page.
 */
export function parseUsageSearch(search: Record<string, unknown>): UsageSearch {
	return {
		period: parseUsagePeriod(search.period),
		page: parseUsagePage(search.page),
	};
}

/** Selecting a period starts at the first page of the new window. */
export function usageSearchForPeriod(period: UsagePeriod): UsageSearch {
	return { period, page: DEFAULT_USAGE_PAGE };
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
