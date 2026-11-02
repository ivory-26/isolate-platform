import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TableCell, TableRow } from "@/components/ui/table";
import { DataTable } from "./data-table";

const COLUMNS = [
	{ key: "day", header: "Day" },
	{ key: "total", header: "Total tokens", align: "right" as const },
];

function renderTable(overrides: Partial<Parameters<typeof DataTable>[0]> = {}) {
	return renderToStaticMarkup(
		<DataTable caption="Daily measured usage" columns={COLUMNS} {...overrides}>
			<TableRow>
				<TableCell>2026-11-15</TableCell>
				<TableCell>120</TableCell>
			</TableRow>
		</DataTable>,
	);
}

describe("DataTable", () => {
	test("renders the accessible caption, headers and rows", () => {
		const html = renderTable();
		expect(html).toContain("<caption");
		expect(html).toContain("Daily measured usage");
		expect(html).toContain('scope="col"');
		expect(html).toContain("2026-11-15");
		expect(html).toContain("120");
	});

	test("right-aligned columns align their header with the numbers", () => {
		const html = renderTable();
		const header = html.match(/<th[^>]*>Total tokens<\/th>/)?.[0] ?? "";
		expect(header).toContain("text-right");
	});

	test("renders the explicit empty state instead of rows", () => {
		const html = renderTable({ isEmpty: true, empty: "No usage rows yet." });
		expect(html).toMatch(/colspan="2"/i);
		expect(html).toContain("No usage rows yet.");
		expect(html).not.toContain("2026-11-15");
	});

	test("falls back to a short empty sentence", () => {
		expect(renderTable({ isEmpty: true })).toContain("No rows to show.");
	});

	test("renders pagination and footnote only when given", () => {
		const bare = renderTable();
		expect(bare).not.toContain("pagination-marker");
		expect(bare).not.toContain("footnote-marker");

		const full = renderTable({
			pagination: <span>pagination-marker</span>,
			footer: <p>footnote-marker</p>,
		});
		expect(full).toContain("pagination-marker");
		expect(full).toContain("footnote-marker");
	});
});
