import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./table";

function slotTag(html: string, slot: string): string {
	const match = html.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
	return match?.[0] ?? "";
}

function renderTable() {
	return renderToStaticMarkup(
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Task</TableHead>
					<TableHead>Status</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell>t-1</TableCell>
					<TableCell>running</TableCell>
				</TableRow>
			</TableBody>
		</Table>,
	);
}

describe("Table", () => {
	test("cells get horizontal breathing room and keep the nowrap default", () => {
		const html = renderTable();
		const head = slotTag(html, "table-head");
		const cell = slotTag(html, "table-cell");
		expect(head).toContain("px-3");
		expect(cell).toContain("px-3");
		expect(head).toContain("whitespace-nowrap");
		expect(cell).toContain("whitespace-nowrap");
	});

	test("the scroll container insets the outer columns and only scrolls horizontally", () => {
		const container = slotTag(renderTable(), "table-container");
		expect(container).toContain("overflow-x-auto");
		expect(container).toContain("px-1");
		expect(container).not.toContain("overflow-auto");
	});
});
