import { describe, expect, test } from "bun:test";
import { paginateItems } from "@/components/common/pagination";
import {
	DEFAULT_USAGE_PAGE,
	parseUsagePage,
	parseUsageSearch,
	USAGE_MAX_PAGE,
	USAGE_PAGE_SIZE,
	usageSearchForPeriod,
} from "./contracts";

const DAYS = Array.from({ length: 30 }, (_, index) => `day-${index}`);

describe("parseUsagePage", () => {
	test("defaults to the first page", () => {
		expect(parseUsagePage(undefined)).toBe(DEFAULT_USAGE_PAGE);
		expect(parseUsagePage(null)).toBe(1);
		expect(parseUsagePage("")).toBe(1);
	});

	test("accepts whole page numbers from the URL", () => {
		expect(parseUsagePage("1")).toBe(1);
		expect(parseUsagePage("3")).toBe(3);
		expect(parseUsagePage(2)).toBe(2);
	});

	test("rejects zero, negative, fractional and non-numeric pages", () => {
		for (const value of ["0", 0, -4, "1.5", 2.25, "abc", {}, []]) {
			expect(parseUsagePage(value)).toBe(1);
		}
	});

	test("bounds a hand-edited page by the longest period", () => {
		expect(USAGE_MAX_PAGE).toBe(7);
		expect(parseUsagePage(99)).toBe(USAGE_MAX_PAGE);
		expect(parseUsagePage("9000")).toBe(USAGE_MAX_PAGE);
	});
});

describe("parseUsageSearch", () => {
	test("an absent search is the default period, first page", () => {
		expect(parseUsageSearch({})).toEqual({ period: 30, page: 1 });
	});

	test("period and page are independent", () => {
		expect(parseUsageSearch({ period: "7", page: "2" })).toEqual({
			period: 7,
			page: 2,
		});
	});

	test("an invalid page never breaks the period", () => {
		expect(parseUsageSearch({ period: "90", page: "nope" })).toEqual({
			period: 90,
			page: 1,
		});
	});
});

describe("usageSearchForPeriod", () => {
	test("changing the period resets to the first page", () => {
		expect(usageSearchForPeriod(7)).toEqual({ period: 7, page: 1 });
		expect(usageSearchForPeriod(90)).toEqual({ period: 90, page: 1 });
	});
});

describe("usage daily breakdown pages", () => {
	test("30 days split into three 14-row pages", () => {
		const first = paginateItems(DAYS, USAGE_PAGE_SIZE, 1);
		expect(first.pageCount).toBe(3);
		expect(first.pageItems).toHaveLength(14);
		expect(first.pageItems[0]).toBe("day-0");
		expect(first.pageItems.at(-1)).toBe("day-13");

		const last = paginateItems(DAYS, USAGE_PAGE_SIZE, 3);
		expect(last.pageItems).toHaveLength(2);
		expect(last.pageItems[0]).toBe("day-28");
	});

	test("a 7-day window is a single page", () => {
		const page = paginateItems(DAYS.slice(0, 7), USAGE_PAGE_SIZE, 4);
		expect(page.pageCount).toBe(1);
		expect(page.page).toBe(1);
		expect(page.pageItems).toHaveLength(7);
	});

	test("a 90-day window is seven pages, the last one partial", () => {
		const days = Array.from({ length: 90 }, (_, index) => `day-${index}`);
		const last = paginateItems(days, USAGE_PAGE_SIZE, USAGE_MAX_PAGE);
		expect(last.pageCount).toBe(USAGE_MAX_PAGE);
		expect(last.pageItems).toHaveLength(90 - USAGE_PAGE_SIZE * 6);
	});
});
