import { describe, expect, test } from "bun:test";
import {
	parseRunsSearch,
	RUNS_PAGE_LIMIT_DEFAULT,
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
			}),
		).toEqual({
			status: "failed",
			repo: REPO_ID,
			q: "feature/login",
			sort: "status",
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
});

describe("runsListInputSchema", () => {
	test("applies defaults and accepts an empty filter", () => {
		expect(runsListInputSchema.parse({})).toEqual({
			status: "all",
			repositoryId: null,
			q: "",
			sort: "created",
			limit: RUNS_PAGE_LIMIT_DEFAULT,
		});
	});

	test("rejects unknown keys, bad UUIDs and out-of-range limits", () => {
		expect(
			runsListInputSchema.safeParse({ repositoryId: "nope" }).success,
		).toBe(false);
		expect(runsListInputSchema.safeParse({ limit: 0 }).success).toBe(false);
		expect(runsListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
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
			}),
		).toEqual({
			status: "executing",
			repositoryId: REPO_ID,
			q: "main",
			sort: "updated",
			limit: RUNS_PAGE_LIMIT_DEFAULT,
		});
	});

	test("maps an empty repo to a null repository filter", () => {
		expect(runsSearchToFilter(RUNS_SEARCH_DEFAULTS).repositoryId).toBeNull();
	});
});
