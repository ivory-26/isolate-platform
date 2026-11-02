import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	clampPage,
	getPageCount,
	Pagination,
	paginateItems,
} from "./pagination";

const ITEMS = Array.from({ length: 25 }, (_, index) => index + 1);

function disabledCount(html: string): number {
	return html.match(/disabled=/g)?.length ?? 0;
}

function renderPagination(page: number, pageCount: number, label?: string) {
	return renderToStaticMarkup(
		<Pagination
			page={page}
			pageCount={pageCount}
			onPageChange={() => {}}
			label={label}
		/>,
	);
}

describe("getPageCount", () => {
	test("an empty list still has one page", () => {
		expect(getPageCount(0, 14)).toBe(1);
	});

	test("counts a partial last page", () => {
		expect(getPageCount(1, 14)).toBe(1);
		expect(getPageCount(14, 14)).toBe(1);
		expect(getPageCount(15, 14)).toBe(2);
		expect(getPageCount(90, 14)).toBe(7);
	});

	test("a non-positive page size falls back to one item per page", () => {
		expect(getPageCount(3, 0)).toBe(3);
		expect(getPageCount(3, -5)).toBe(3);
	});
});

describe("clampPage", () => {
	test("keeps in-range pages untouched", () => {
		expect(clampPage(1, 3)).toBe(1);
		expect(clampPage(2, 3)).toBe(2);
		expect(clampPage(3, 3)).toBe(3);
	});

	test("clamps both ends", () => {
		expect(clampPage(0, 3)).toBe(1);
		expect(clampPage(-9, 3)).toBe(1);
		expect(clampPage(4, 3)).toBe(3);
		expect(clampPage(9_999, 3)).toBe(3);
	});

	test("a non-finite page becomes the first page", () => {
		expect(clampPage(Number.NaN, 3)).toBe(1);
		expect(clampPage(Number.POSITIVE_INFINITY, 3)).toBe(1);
	});

	test("a page count below one is treated as a single page", () => {
		expect(clampPage(5, 0)).toBe(1);
	});
});

describe("paginateItems", () => {
	test("an empty list yields one empty page", () => {
		expect(paginateItems([], 10, 3)).toEqual({
			pageItems: [],
			page: 1,
			pageCount: 1,
			start: 0,
		});
	});

	test("one page is returned unchanged", () => {
		const slice = paginateItems(["a", "b"], 10, 1);
		expect(slice.pageItems).toEqual(["a", "b"]);
		expect(slice.pageCount).toBe(1);
		expect(slice.start).toBe(0);
	});

	test("an exact page size does not create a trailing empty page", () => {
		const page = paginateItems(ITEMS.slice(0, 20), 10, 2);
		expect(page.pageCount).toBe(2);
		expect(page.pageItems).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
		expect(page.start).toBe(10);
	});

	test("an out-of-range page clamps to the last page", () => {
		const page = paginateItems(ITEMS, 10, 99);
		expect(page.page).toBe(3);
		expect(page.pageItems).toEqual([21, 22, 23, 24, 25]);
		expect(page.start).toBe(20);
	});

	test("an out-of-range page clamps to the first page", () => {
		const page = paginateItems(ITEMS, 10, 0);
		expect(page.page).toBe(1);
		expect(page.start).toBe(0);
		expect(page.pageItems).toHaveLength(10);
	});

	test("the last page holds only the remainder", () => {
		expect(paginateItems(ITEMS, 10, 3).pageItems).toHaveLength(5);
		expect(paginateItems(ITEMS, 10, 2).pageItems).toHaveLength(10);
	});
});

describe("Pagination", () => {
	test("renders the page indicator and both controls", () => {
		const html = renderPagination(2, 3);
		expect(html).toContain("Page 2 of 3");
		expect(html).toContain('aria-label="Previous page"');
		expect(html).toContain('aria-label="Next page"');
	});

	test("disables previous only on the first page", () => {
		const html = renderPagination(1, 3);
		expect(html).toContain("Page 1 of 3");
		expect(disabledCount(html)).toBe(1);
	});

	test("disables next only on the last page", () => {
		expect(disabledCount(renderPagination(3, 3))).toBe(1);
		expect(disabledCount(renderPagination(2, 3))).toBe(0);
	});

	test("a single page renders both controls disabled", () => {
		expect(disabledCount(renderPagination(1, 1))).toBe(2);
	});

	test("shows the clamped page for an out-of-range request", () => {
		expect(renderPagination(9, 3)).toContain("Page 3 of 3");
		expect(renderPagination(0, 3)).toContain("Page 1 of 3");
	});

	test("names the landmark", () => {
		expect(renderPagination(1, 2, "Daily breakdown pages")).toContain(
			'aria-label="Daily breakdown pages"',
		);
	});
});
