import { describe, expect, test } from "bun:test";
import {
	assertReadOnlyAxiomApl,
	axiomAplDataset,
	buildAxiomApl,
	clampAxiomWindowMinutes,
	escapeAxiomString,
	renderAxiomTableSummary,
	resolveAxiomWindow,
} from "./context";

const DATASET = "app-logs";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");

describe("assertReadOnlyAxiomApl", () => {
	test("accepts the fixed template and a bounded tool query", () => {
		const template = buildAxiomApl({ dataset: DATASET, service: "checkout" });
		expect(assertReadOnlyAxiomApl(template, DATASET)).toBe(template);
		expect(
			assertReadOnlyAxiomApl(
				"['app-logs'] | where status >= 500 and service == \"checkout\" | summarize count = count() by status | order by count desc | limit 20",
				DATASET,
			),
		).toContain("summarize count = count()");
	});

	test("rejects mutation-like operators and statements", () => {
		const rejected = [
			`['${DATASET}'] | delete`,
			`['${DATASET}'] | update set status = "x"`,
			`['${DATASET}'] | where service == "checkout" | insert`,
			`['${DATASET}'] | summarize count() by service; drop ${DATASET}`,
			`['${DATASET}'] | where service == "checkout" | set status = "x"`,
			"let x = 1",
			`['${DATASET}'] | union other-logs`,
			`['${DATASET}'] | join (['other-logs']) on service`,
			`['${DATASET}'] | externaldata (x: string) [@"https://example.com"]`,
		];
		for (const apl of rejected) {
			expect(() => assertReadOnlyAxiomApl(apl, DATASET)).toThrow(
				"single read-only pipeline",
			);
		}
	});

	test("rejects wildcard projections, comments and unknown functions", () => {
		expect(() =>
			assertReadOnlyAxiomApl(`['${DATASET}'] | project *`, DATASET),
		).toThrow("single read-only pipeline");
		expect(() =>
			assertReadOnlyAxiomApl(
				`['${DATASET}'] | where service == "checkout" // comment`,
				DATASET,
			),
		).toThrow("single read-only pipeline");
		expect(() =>
			assertReadOnlyAxiomApl(
				`['${DATASET}'] | summarize x = evil_function(service)`,
				DATASET,
			),
		).toThrow("single read-only pipeline");
	});

	test("binds the query to the configured dataset", () => {
		expect(() =>
			assertReadOnlyAxiomApl(`['other-logs'] | limit 1`, DATASET),
		).toThrow("configured dataset");
		expect(() =>
			assertReadOnlyAxiomApl(`['../app-logs'] | limit 1`, DATASET),
		).toThrow("single read-only pipeline");
		expect(axiomAplDataset(`['${DATASET}'] | limit 1`)).toBe(DATASET);
		expect(axiomAplDataset("not a query;")).toBeNull();
	});

	test("rejects empty, oversized and non-string APL", () => {
		expect(() => assertReadOnlyAxiomApl("   ")).toThrow();
		expect(() => assertReadOnlyAxiomApl("x".repeat(2001))).toThrow();
		expect(() =>
			assertReadOnlyAxiomApl(undefined as unknown as string),
		).toThrow();
	});
});

describe("buildAxiomApl", () => {
	test("produces a dataset-bound aggregate with no raw projection", () => {
		const apl = buildAxiomApl({ dataset: DATASET, service: "checkout" });
		expect(apl.startsWith(`['${DATASET}']`)).toBe(true);
		expect(apl).toContain('where service == "checkout"');
		expect(apl).toContain("summarize count = count() by service");
		expect(apl).toContain("['error.kind']");
		expect(apl).toContain("limit 20");
		expect(apl).not.toContain("project *");
		expect(assertReadOnlyAxiomApl(apl, DATASET)).toBe(apl);
	});

	test("escapes payload text so it stays inert", () => {
		expect(escapeAxiomString('checkout" | delete | "')).toBe(
			'checkout\\" | delete | \\"',
		);
		const apl = buildAxiomApl({
			dataset: DATASET,
			service: 'checkout"\n| delete',
		});
		expect(apl).toContain('where service == "checkout\\" | delete"');
		expect(assertReadOnlyAxiomApl(apl, DATASET)).toBe(apl);
	});

	test("clamps the row limit to 20", () => {
		expect(
			buildAxiomApl({ dataset: DATASET, service: "x", rowLimit: 50 }),
		).toContain("limit 20");
		expect(
			buildAxiomApl({ dataset: DATASET, service: "x", rowLimit: 0 }),
		).toContain("limit 1");
	});
});

describe("window and rendering", () => {
	test("resolves a maximum 60-minute window with a 15-minute pre-start", () => {
		expect(
			resolveAxiomWindow({
				nowMs: NOW_MS,
				startsAt: "2026-10-30T23:50:00Z",
			}),
		).toEqual({
			fromMs: Date.parse("2026-10-30T23:35:00Z"),
			toMs: NOW_MS,
		});
		expect(
			resolveAxiomWindow({
				nowMs: NOW_MS,
				startsAt: "2026-10-29T00:00:00Z",
			}).fromMs,
		).toBe(NOW_MS - 60 * 60_000);
		expect(resolveAxiomWindow({ nowMs: NOW_MS }).fromMs).toBe(
			NOW_MS - 30 * 60_000,
		);
		expect(clampAxiomWindowMinutes(120)).toBe(60);
		expect(clampAxiomWindowMinutes(1)).toBe(5);
		expect(clampAxiomWindowMinutes(Number.NaN)).toBe(30);
	});

	test("renders at most 20 rows, 2,000 chars and redacts cells", () => {
		const rows = Array.from({ length: 25 }, (_, index) => [
			"checkout",
			`region-${index}`,
			"500",
			"timeout",
			index,
		]);
		rows[0] = ["checkout", "alice@example.com", "500", "10.0.0.1", 42];
		const summary = renderAxiomTableSummary({
			dataset: DATASET,
			fromMs: NOW_MS - 60_000,
			toMs: NOW_MS,
			fields: ["service", "environment", "status", "error_kind", "count"],
			rows,
			totalRows: rows.length,
		});
		expect(summary.truncated).toBe(true);
		expect(summary.text).toContain("showing 20");
		expect(summary.text).not.toContain("alice@example.com");
		expect(summary.text).not.toContain("10.0.0.1");
		expect(summary.text).toContain("[email-redacted]");
		expect(summary.text).toContain("[ip-redacted]");
		expect(summary.text.length).toBeLessThanOrEqual(2000);
		expect((summary.text.match(/^checkout \|/gm) ?? []).length).toBe(20);
	});
});
