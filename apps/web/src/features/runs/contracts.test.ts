import { describe, expect, test } from "bun:test";
import {
	applyRunsSearchPatch,
	parseRunsPage,
	parseRunsSearch,
	RUNS_PAGE_LIMIT_DEFAULT,
	RUNS_PAGE_MAX,
	RUNS_QUERY_MAX_LENGTH,
	RUNS_SEARCH_DEFAULTS,
	runsListInputSchema,
	runsSearchToFilter,
} from "./contracts";

const REPO_ID = "11111111-1111-4111-8111-111111111111";

describe("parseRunsSearch", () => {
	test("falls back to defaults for missing or hostile values", () => {
		expect(parseRunsSearch(undefined)).toEqual(RUNS_SEARCH_DEFAULTS);
		expect(
			parseRunsSearch({
				status: "not-a-status",
				repo: "not-a-uuid",
				q: 42,
				sort: "drop table",
			}),
		).toEqual(RUNS_SEARCH_DEFAULTS);
	});

	test("accepts each supported filter and normalises the repository id", () => {
		expect(
			parseRunsSearch({
				status: "failed",
				repo: REPO_ID.toUpperCase(),
				q: "  feature/login  ",
				sort: "status",
				page: "3",
			}),
		).toEqual({
			status: "failed",
			repo: REPO_ID,
			q: "feature/login",
			sort: "status",
			page: 3,
		});
	});

	test("bounds free text and ignores unknown keys", () => {
		const parsed = parseRunsSearch({
			q: "x".repeat(RUNS_QUERY_MAX_LENGTH + 50),
			extra: "ignored",
		});
		expect(parsed.q).toHaveLength(RUNS_QUERY_MAX_LENGTH);
		expect(parsed).not.toHaveProperty("extra");
	});

	test("parses and clamps the page number", () => {
		expect(parseRunsPage(undefined)).toBe(1);
		expect(parseRunsPage("2")).toBe(2);
		expect(parseRunsPage("0")).toBe(1);
		expect(parseRunsPage("-4")).toBe(1);
		expect(parseRunsPage("2.5")).toBe(1);
		expect(parseRunsPage("nope")).toBe(1);
		expect(parseRunsPage(RUNS_PAGE_MAX + 50)).toBe(RUNS_PAGE_MAX);
	});
});

describe("applyRunsSearchPatch", () => {
	test("returns to page one when a filter, search or sort changes", () => {
		const current = { ...RUNS_SEARCH_DEFAULTS, page: 4 };
		expect(applyRunsSearchPatch(current, { status: "failed" }).page).toBe(1);
		expect(applyRunsSearchPatch(current, { repo: REPO_ID }).page).toBe(1);
		expect(applyRunsSearchPatch(current, { q: "main" }).page).toBe(1);
		expect(applyRunsSearchPatch(current, { sort: "status" }).page).toBe(1);
	});

	test("keeps and clamps the page when only the page changes", () => {
		const current = { ...RUNS_SEARCH_DEFAULTS, page: 2 };
		expect(applyRunsSearchPatch(current, { page: 3 }).page).toBe(3);
		expect(applyRunsSearchPatch(current, { page: 0 }).page).toBe(1);
		expect(applyRunsSearchPatch(current, { page: 9999 }).page).toBe(
			RUNS_PAGE_MAX,
		);
	});
});

describe("runsListInputSchema", () => {
	test("applies defaults and accepts an empty filter", () => {
		expect(runsListInputSchema.parse({})).toEqual({
			status: "all",
			repositoryId: null,
			q: "",
			sort: "created",
			limit: RUNS_PAGE_LIMIT_DEFAULT,
			offset: 0,
		});
	});

	test("rejects unknown keys, bad UUIDs and out-of-range limits or offsets", () => {
		expect(
			runsListInputSchema.safeParse({ repositoryId: "nope" }).success,
		).toBe(false);
		expect(runsListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
		expect(runsListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
		expect(runsListInputSchema.safeParse({ offset: -1 }).success).toBe(false);
		expect(runsListInputSchema.safeParse({ offset: 10_001 }).success).toBe(
			false,
		);
		expect(runsListInputSchema.safeParse({ status: "all;" }).success).toBe(
			false,
		);
		expect(runsListInputSchema.safeParse({ extra: true }).success).toBe(false);
	});
});

describe("runsSearchToFilter", () => {
	test("maps URL search to a typed server input", () => {
		expect(
			runsSearchToFilter({
				status: "executing",
				repo: REPO_ID,
				q: "main",
				sort: "updated",
				page: 3,
			}),
		).toEqual({
			status: "executing",
			repositoryId: REPO_ID,
			q: "main",
			sort: "updated",
			limit: RUNS_PAGE_LIMIT_DEFAULT,
			offset: 2 * RUNS_PAGE_LIMIT_DEFAULT,
		});
	});

	test("maps an empty repo to a null repository filter", () => {
		expect(runsSearchToFilter(RUNS_SEARCH_DEFAULTS).repositoryId).toBeNull();
	});
});
