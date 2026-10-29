import { describe, expect, test } from "bun:test";
import { submitTaskSchema } from "./contracts";

const base = {
	repositoryId: "10000000-0000-4000-8000-000000000003",
	branch: "task/health",
	idempotencyKey: "10000000-0000-4000-8000-000000000001",
	workflowDefinitionId: "10000000-0000-4000-8000-000000000004",
	workflowVersion: 1,
	budget: { maxAgentTurns: 12, repairBudget: 2, jobTimeoutMs: 120000 },
};

describe("submitTaskSchema task context", () => {
	test("requires a goal and defaults the lists to empty", () => {
		const parsed = submitTaskSchema.parse({ ...base, goal: "  Add health  " });
		expect(parsed.goal).toBe("Add health");
		expect(parsed.acceptanceCriteria).toEqual([]);
		expect(parsed.fileOwnership).toEqual([]);
	});

	test("rejects a blank goal and unknown fields", () => {
		expect(submitTaskSchema.safeParse({ ...base, goal: "   " }).success).toBe(
			false,
		);
		expect(
			submitTaskSchema.safeParse({ ...base, goal: "ok", extra: true }).success,
		).toBe(false);
	});

	test("enforces bounded, non-empty list entries", () => {
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceCriteria: ["x".repeat(501)],
			}).success,
		).toBe(false);
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				fileOwnership: [""],
			}).success,
		).toBe(false);
	});
});
