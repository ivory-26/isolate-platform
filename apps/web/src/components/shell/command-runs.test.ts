import { describe, expect, test } from "bun:test";
import type { RunListRow } from "@/features/runs/contracts";
import {
	COMMAND_RUN_LIMIT,
	COMMAND_RUN_QUERY_MIN_LENGTH,
	commandRunItems,
	commandRunQuery,
} from "./command-runs";

function row(
	taskId: string,
	branch: string,
	fullName = "acme/web",
	goal = "",
): RunListRow {
	return {
		taskId,
		branch,
		goal,
		status: "queued",
		retryDepth: 0,
		incidentSource: null,
		createdAt: "2026-11-17T00:00:00.000Z",
		updatedAt: "2026-11-17T00:00:00.000Z",
		repository: { id: `repo-${fullName}`, fullName, defaultBranch: "main" },
		latestRun: null,
	};
}

describe("commandRunQuery", () => {
	test("a single character does not query the tenant's history", () => {
		expect(commandRunQuery("a")).toBe("");
		expect(commandRunQuery("  ")).toBe("");
	});

	test("a real term is trimmed and kept", () => {
		expect(commandRunQuery("  checkout ")).toBe("checkout");
		expect(commandRunQuery("ab")).toBe("ab");
		expect(COMMAND_RUN_QUERY_MIN_LENGTH).toBe(2);
	});
});

describe("commandRunItems", () => {
	test("maps a row to the id, branch and repository the palette shows", () => {
		const [item] = commandRunItems([
			row(
				"97f9e8a7-0000-4000-8000-000000000000",
				"task/w28-checkout",
				"acme/web",
				"Fix the checkout timeout",
			),
		]);
		expect(item?.taskId).toBe("97f9e8a7-0000-4000-8000-000000000000");
		expect(item?.label).toBe("97f9e8a7 · task/w28-checkout");
		expect(item?.hint).toBe("acme/web");
		expect(item?.value).toContain("97f9e8a7-0000-4000-8000-000000000000");
		expect(item?.value).toContain("acme/web");
		// cmdk filters the item locally, so the value must carry the goal the
		// server matched on; otherwise a goal-only hit disappears on render.
		expect(item?.value).toContain("Fix the checkout timeout");
	});

	test("caps the list and never exceeds the palette budget", () => {
		const rows = Array.from({ length: 12 }, (_, index) =>
			row(`task-${index}`, `task/branch-${index}`),
		);
		expect(commandRunItems(rows)).toHaveLength(COMMAND_RUN_LIMIT);
		expect(commandRunItems(rows, 99)).toHaveLength(COMMAND_RUN_LIMIT);
		expect(commandRunItems(rows, 0)).toHaveLength(1);
	});

	test("an empty result renders no group", () => {
		expect(commandRunItems([])).toEqual([]);
	});
});
