import { describe, expect, test } from "bun:test";
import {
	decideApprovalSchema,
	incidentSubmissionSchema,
	MAX_SUBMITTED_ACCEPTANCE_CHECKS,
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

const checks = [
	{ kind: "path_exists", path: "apps/web/src/features/tasks/contracts.ts" },
	{
		kind: "content_matches",
		path: "package.json",
		pattern: '"type": "module"',
	},
	{ kind: "command_exit_zero", command: "bun run validate" },
] as const;

describe("submitTaskSchema task context", () => {
	test("requires a goal and defaults the lists to empty", () => {
		const parsed = submitTaskSchema.parse({ ...base, goal: "  Add health  " });
		expect(parsed.goal).toBe("Add health");
		expect(parsed.acceptanceCriteria).toEqual([]);
		expect(parsed.acceptanceChecks).toEqual([]);
		expect(parsed.fileOwnership).toEqual([]);
	});

	test("accepts bounded machine-checkable acceptance criteria", () => {
		const parsed = submitTaskSchema.parse({
			...base,
			goal: "ok",
			acceptanceChecks: [...checks],
		});
		expect(parsed.acceptanceChecks).toEqual([...checks]);
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceChecks: Array.from(
					{ length: MAX_SUBMITTED_ACCEPTANCE_CHECKS },
					() => ({ kind: "path_exists", path: "README.md" }),
				),
			}).success,
		).toBe(true);
	});

	test("rejects more checks than the bound", () => {
		expect(MAX_SUBMITTED_ACCEPTANCE_CHECKS).toBe(32);
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceChecks: Array.from(
					{ length: MAX_SUBMITTED_ACCEPTANCE_CHECKS + 1 },
					() => ({ kind: "path_exists", path: "README.md" }),
				),
			}).success,
		).toBe(false);
	});

	test("rejects absolute, traversal and overlong check paths", () => {
		for (const path of [
			"/etc/passwd",
			"../outside.md",
			"apps/../../outside.md",
			"a".repeat(401),
			"",
		])
			expect(
				submitTaskSchema.safeParse({
					...base,
					goal: "ok",
					acceptanceChecks: [{ kind: "path_exists", path }],
				}).success,
			).toBe(false);
	});

	test("rejects unknown fields on the submission and inside a check", () => {
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceChecks: [
					{ kind: "path_exists", path: "README.md", shell: "rm -rf /" },
				],
			}).success,
		).toBe(false);
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceChecks: [{ kind: "shell", command: "rm -rf /" }],
			}).success,
		).toBe(false);
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				acceptanceChecks: checks.map((check) => ({ ...check })),
				acceptanceChecksRaw: "smuggled",
			}).success,
		).toBe(false);
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

describe("incident provenance", () => {
	test("the browser-facing submission rejects provenance fields", () => {
		expect(
			submitTaskSchema.safeParse({
				...base,
				goal: "ok",
				incidentSource: "github",
				incidentFingerprint: "github:owner/repo:CI:main",
			}).success,
		).toBe(false);
	});

	test("server submissions accept provenance only as a bounded pair", () => {
		const parsed = incidentSubmissionSchema.parse({
			...base,
			goal: "ok",
			incidentSource: "github",
			incidentFingerprint: "github:owner/repo:CI:main",
		});
		expect(parsed.incidentSource).toBe("github");
		expect(parsed.incidentFingerprint).toBe("github:owner/repo:CI:main");
		// Neither is valid too (ordinary submission through the same schema).
		expect(
			incidentSubmissionSchema.safeParse({ ...base, goal: "ok" }).success,
		).toBe(true);
		for (const half of [
			{ incidentSource: "github" },
			{ incidentFingerprint: "gitHub:owner/repo:CI:main" },
			{ incidentSource: "s".repeat(33), incidentFingerprint: "fp" },
			{ incidentSource: "github", incidentFingerprint: "f".repeat(129) },
			{ incidentSource: "github", incidentFingerprint: "" },
		])
			expect(
				incidentSubmissionSchema.safeParse({ ...base, goal: "ok", ...half })
					.success,
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
