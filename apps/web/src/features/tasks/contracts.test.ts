import { describe, expect, test } from "bun:test";
import {
	decideApprovalSchema,
	retryTaskSchema,
	submitTaskSchema,
} from "./contracts";

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

describe("decision action schemas", () => {
	test("bounds the retry request key and rejects unknown fields", () => {
		const failedTaskId = base.repositoryId;
		expect(
			retryTaskSchema.parse({
				failedTaskId,
				idempotencyKey: "  retry-key  ",
			}).idempotencyKey,
		).toBe("retry-key");
		expect(
			retryTaskSchema.safeParse({
				failedTaskId,
				idempotencyKey: "k".repeat(200),
			}).success,
		).toBe(true);
		for (const idempotencyKey of ["", "k".repeat(201), "   "])
			expect(
				retryTaskSchema.safeParse({ failedTaskId, idempotencyKey }).success,
			).toBe(false);
		expect(
			retryTaskSchema.safeParse({
				failedTaskId,
				idempotencyKey: "key",
				goal: "smuggled",
			}).success,
		).toBe(false);
	});

	test("accepts only an explicit approve or reject decision", () => {
		const decision = {
			taskId: base.repositoryId,
			approvalId: base.workflowDefinitionId,
		};
		for (const value of ["approved", "rejected"] as const)
			expect(
				decideApprovalSchema.safeParse({ ...decision, decision: value })
					.success,
			).toBe(true);
		for (const value of ["maybe", "", null])
			expect(
				decideApprovalSchema.safeParse({ ...decision, decision: value })
					.success,
			).toBe(false);
	});
});
