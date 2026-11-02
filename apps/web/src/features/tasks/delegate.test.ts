import { describe, expect, test } from "bun:test";
import type { RepositoryOption, WorkflowOption } from "../overview/contracts";
import {
	DELEGATE_DEFAULT_BUDGETS,
	DELEGATE_MESSAGES,
	type DelegateFieldValues,
	defaultManualBranch,
	defaultRepositoryId,
	defaultWorkflowSelection,
	delegateBlockReason,
	parseDelegateSubmission,
	splitComposerLines,
	versionsFor,
} from "./delegate";

const REPOSITORIES: RepositoryOption[] = [
	{
		id: "55555555-5555-4555-8555-555555555555",
		name: "acme/api",
		defaultBranch: "main",
	},
	{
		id: "66666666-6666-4666-8666-666666666666",
		name: "acme/web",
		defaultBranch: "trunk",
	},
];

const WORKFLOWS: WorkflowOption[] = [
	{
		id: "77777777-7777-4777-8777-777777777777",
		name: "Draft only",
		versions: [],
	},
	{
		id: "88888888-8888-4888-8888-888888888888",
		name: "SDLC",
		versions: [4, 2, 1],
	},
];

function values(
	overrides: Partial<DelegateFieldValues> = {},
): DelegateFieldValues {
	return {
		repositoryId: REPOSITORIES[0]?.id ?? "",
		goal: "Fix the checkout test",
		acceptanceCriteria: ["All tests pass"],
		fileOwnership: ["apps/web/**"],
		branch: defaultManualBranch("a1b2c3d4-e5f6"),
		workflowDefinitionId: "88888888-8888-4888-8888-888888888888",
		workflowVersion: 4,
		...DELEGATE_DEFAULT_BUDGETS,
		...overrides,
	};
}

const KEY = "99999999-9999-4999-8999-999999999999";

describe("delegate defaults", () => {
	test("branch default is bounded, lowercase and schema-valid", () => {
		expect(defaultManualBranch("A1B2C3D4-E5F6-4788-9999")).toBe(
			"task/manual-a1b2c3d4",
		);
		expect(defaultManualBranch("")).toBe("task/manual-task");
		expect(defaultManualBranch("!!!")).toBe("task/manual-task");
	});

	test("workflow default skips definitions without a published version", () => {
		expect(defaultWorkflowSelection(WORKFLOWS)).toEqual({
			workflowDefinitionId: "88888888-8888-4888-8888-888888888888",
			workflowVersion: 4,
		});
		expect(defaultWorkflowSelection([])).toBeNull();
		expect(
			versionsFor(WORKFLOWS, "88888888-8888-4888-8888-888888888888"),
		).toEqual([4, 2, 1]);
	});

	test("repository default is the first imported repository", () => {
		expect(defaultRepositoryId(REPOSITORIES)).toBe(REPOSITORIES[0]?.id);
		expect(defaultRepositoryId([])).toBe("");
	});

	test("the form is blocked only when a default cannot exist", () => {
		expect(
			delegateBlockReason({
				repositories: REPOSITORIES,
				workflow: defaultWorkflowSelection(WORKFLOWS),
			}),
		).toBeNull();
		expect(
			delegateBlockReason({
				repositories: [],
				workflow: defaultWorkflowSelection(WORKFLOWS),
			}),
		).toBe(DELEGATE_MESSAGES.noRepository);
		expect(
			delegateBlockReason({ repositories: REPOSITORIES, workflow: null }),
		).toBe(DELEGATE_MESSAGES.noPublishedWorkflow);
	});
});

describe("delegate validation", () => {
	test("a complete request validates and keeps the supplied idempotency key", () => {
		const result = parseDelegateSubmission(values(), KEY);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.idempotencyKey).toBe(KEY);
		expect(result.value.branch).toBe("task/manual-a1b2c3d4");
		expect(result.value.budget).toEqual({
			maxAgentTurns: DELEGATE_DEFAULT_BUDGETS.maxAgentTurns,
			repairBudget: DELEGATE_DEFAULT_BUDGETS.repairBudget,
			jobTimeoutMs: DELEGATE_DEFAULT_BUDGETS.jobTimeoutMs,
		});
	});

	test("a missing repository, empty goal or invalid branch is refused", () => {
		for (const override of [
			{ repositoryId: "" },
			{ goal: "   " },
			{ workflowDefinitionId: "" },
			{ branch: "task/with space" },
			{ branch: "task//double" },
			{ jobTimeoutMs: 1 },
		]) {
			const result = parseDelegateSubmission(values(override), KEY);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.message).toBe(DELEGATE_MESSAGES.missingFields);
		}
	});

	test("composer lines are trimmed, dropped when empty and capped", () => {
		expect(splitComposerLines("a\n\n b \n")).toEqual(["a", "b"]);
		expect(
			splitComposerLines(
				Array.from({ length: 40 }, (_, i) => `c${i}`).join("\n"),
			),
		).toHaveLength(32);
	});
});
