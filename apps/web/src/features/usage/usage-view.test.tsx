import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageDay, UsageReadModel } from "./contracts";
import { USAGE_PAGE_SIZE } from "./contracts";
import { UsageTable } from "./usage-view";

function day(index: number): UsageDay {
	const date = new Date(Date.UTC(2026, 9, 17 + index))
		.toISOString()
		.slice(0, 10);
	return {
		day: date,
		promptTokens: 100 + index,
		completionTokens: 20,
		totalTokens: 120 + index,
		sandboxSeconds: 3,
		costUsd: "0.010000",
		costCoverage: "complete",
	};
}

const DAYS = Array.from({ length: 30 }, (_, index) => day(index));

const MODEL: UsageReadModel = {
	period: 30,
	since: "2026-10-17T00:00:00.000Z",
	until: "2026-11-16T00:00:00.000Z",
	timeZone: "UTC",
	totals: {
		promptTokens: 100,
		completionTokens: 20,
		totalTokens: 120,
		sandboxSeconds: 3,
		costUsd: "0.010000",
		costCoverage: "complete",
		tasks: 1,
	},
	days: DAYS,
	hasRows: true,
};

function renderTable(page: number): string {
	return renderToStaticMarkup(
		<UsageTable model={MODEL} page={page} onPageChange={() => {}} />,
	);
}

function bodyRowCount(html: string): number {
	// Header row plus the rows on the page.
	return html.match(/data-slot="table-row"/g)?.length ?? 0;
}

describe("UsageTable", () => {
	test("renders a page of the newest days, not the whole window", () => {
		const html = renderTable(1);
		expect(bodyRowCount(html)).toBe(USAGE_PAGE_SIZE + 1);
		expect(html).toContain(DAYS.at(-1)?.day ?? "");
		expect(html).not.toContain(DAYS[0].day);
		expect(html).toContain("Page 1 of 3");
	});

	test("the last page holds the oldest days", () => {
		const html = renderTable(3);
		expect(bodyRowCount(html)).toBe(30 - USAGE_PAGE_SIZE * 2 + 1);
		expect(html).toContain(DAYS[0].day);
		expect(html).not.toContain(DAYS.at(-1)?.day ?? "");
	});

	test("an out-of-range page clamps to the last page", () => {
		const html = renderTable(99);
		expect(html).toContain("Page 3 of 3");
		expect(bodyRowCount(html)).toBe(3);
	});

	test("no inner vertical scrollbar wraps the table", () => {
		const html = renderTable(1);
		expect(html).not.toContain("max-h-[460px]");
		expect(html).not.toContain("overflow-auto");
	});

	test("keeps the accessible caption and the partial-cost footnote", () => {
		const html = renderTable(1);
		expect(html).toContain("<caption");
		expect(html).toContain("newest first");
		expect(html).toContain("* Partial cost");
	});
});
