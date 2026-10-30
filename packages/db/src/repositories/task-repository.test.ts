import { expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	TASK_STATE_TRANSITIONS,
	type TaskStatus,
} from "@isolate/shared";
import type { TaskRow } from "../schema";
import { InMemoryTaskRepository } from "../testing/fakes";
import {
	buildRetryIdempotencyKey,
	buildTransitionValuesSql,
	deriveRetryBranch,
	evaluateRetryEligibility,
	guardTransition,
	MAX_RETRY_DEPTH,
	requireNonEmpty,
	requireNonNegativeInt,
	requirePositiveInt,
} from "./task-repository";

test("guardTransition accepts every declared transition when status matches", () => {
	for (const [from, targets] of Object.entries(TASK_STATE_TRANSITIONS)) {
		for (const to of targets) {
			const outcome = guardTransition(
				from as TaskStatus,
				from as TaskStatus,
				to,
			);
			expect(outcome.ok).toBe(true);
		}
	}
});

test("guardTransition rejects undeclared transitions with INVALID_TRANSITION", () => {
	// queued has no edge to completed or pull_request_created.
	expect(guardTransition("queued", "queued", "completed")).toEqual({
		ok: false,
		code: "INVALID_TRANSITION",
	});
	expect(guardTransition("queued", "queued", "pull_request_created")).toEqual({
		ok: false,
		code: "INVALID_TRANSITION",
	});
});

test("guardTransition rejects terminal states (no outgoing edges)", () => {
	for (const terminal of [
		"completed",
		"failed",
		"cancelled",
		"blocked",
	] as const) {
		expect(guardTransition(terminal, terminal, "executing")).toEqual({
			ok: false,
			code: "INVALID_TRANSITION",
		});
	}
});

test("guardTransition reports CONFLICT when current != expected", () => {
	// planning -> awaiting_approval is legal, but the row moved on already.
	expect(guardTransition("planning", "executing", "awaiting_approval")).toEqual(
		{
			ok: false,
			code: "CONFLICT",
		},
	);
});

test("buildTransitionValuesSql emits one (from,to) row per declared edge", () => {
	const fragment = buildTransitionValuesSql();
	const edgeCount = Object.values(TASK_STATE_TRANSITIONS).reduce(
		(sum, targets) => sum + targets.length,
		0,
	);
	// The SQL fragments pairs as ('a','b'), ('c','d') — count via "), (".
	expect(fragment.split("), (").length).toBe(edgeCount);
	expect(fragment).toContain("('queued','planning')");
	expect(fragment).not.toContain("('completed','queued')");
});

test("buildTransitionValuesSql rejects unknown status tokens", () => {
	expect(() =>
		buildTransitionValuesSql({ queued: ["definitely_not_a_status"] } as never),
	).toThrow(/target is not a known status/);
	expect(() => buildTransitionValuesSql({ not_a_status: [] } as never)).toThrow(
		/source is not a known status/,
	);
});

test("require* validators reject bad input", () => {
	expect(() => requireNonEmpty("", "x")).toThrow();
	expect(() => requireNonEmpty("   ", "x")).toThrow();
	expect(() => requirePositiveInt(0, "x")).toThrow();
	expect(() => requirePositiveInt(1.5, "x")).toThrow();
	expect(() => requirePositiveInt(1, "x")).not.toThrow();
	expect(() => requireNonNegativeInt(-1, "x")).toThrow();
	expect(() => requireNonNegativeInt(0, "x")).not.toThrow();
});

const orgA = asOrganizationId("10000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("10000000-0000-4000-8000-000000000002");

function createInput(idempotencyKey: string) {
	return {
		organizationId: orgA,
		repositoryId: "20000000-0000-4000-8000-000000000001",
		branch: "task/original",
		idempotencyKey,
		budgetLimits: {
			maxAgentTurns: 5,
			maxRepairAttempts: 1,
			maxDurationMs: 600000,
		},
		goal: "Fix the failing test",
		acceptanceCriteria: ["bun test passes", "no unowned writes"],
		fileOwnership: ["src/**"],
		createdBy: "30000000-0000-4000-8000-000000000001",
	};
}

async function failedSource(repo: InMemoryTaskRepository): Promise<TaskRow> {
	const task = await repo.create(createInput("source-key"));
	// queued -> failed is a declared transition; failed stays terminal.
	await repo.transition({
		taskId: task.id,
		to: "failed",
		expectedStatus: "queued",
	});
	return task;
}

test("evaluateRetryEligibility orders NOT_FOUND over CONFLICT over POLICY_DENIED", () => {
	expect(
		evaluateRetryEligibility({
			sourceFound: false,
			sameOrganization: false,
			sourceStatus: null,
			sourceRetryDepth: null,
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	// A foreign row is indistinguishable from an absent one.
	expect(
		evaluateRetryEligibility({
			sourceFound: true,
			sameOrganization: false,
			sourceStatus: "failed",
			sourceRetryDepth: 0,
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	expect(
		evaluateRetryEligibility({
			sourceFound: true,
			sameOrganization: true,
			sourceStatus: "executing",
			sourceRetryDepth: 0,
		}),
	).toEqual({ ok: false, code: "CONFLICT" });
	expect(
		evaluateRetryEligibility({
			sourceFound: true,
			sameOrganization: true,
			sourceStatus: "failed",
			sourceRetryDepth: MAX_RETRY_DEPTH,
		}),
	).toEqual({ ok: false, code: "POLICY_DENIED" });
	expect(
		evaluateRetryEligibility({
			sourceFound: true,
			sameOrganization: true,
			sourceStatus: "failed",
			sourceRetryDepth: MAX_RETRY_DEPTH - 1,
		}),
	).toEqual({ ok: true });
});

test("retry key/branch derivation is deterministic and bounded", () => {
	const taskId = asTaskId("40000000-0000-4000-8000-000000000001");
	expect(buildRetryIdempotencyKey(taskId, "req-1")).toBe(
		`retry:${taskId}:req-1`,
	);
	expect(deriveRetryBranch("task/original", 1)).toBe("task/original-retry-1");
	const longBranch = deriveRetryBranch("b".repeat(400), 3);
	expect(longBranch.length).toBe(255);
	expect(longBranch.endsWith("-retry-3")).toBe(true);
});

test("createRetry copies the boundary, links retry_of and increments depth", async () => {
	const repo = new InMemoryTaskRepository();
	const source = await failedSource(repo);
	const result = await repo.createRetry({
		organizationId: orgA,
		failedTaskId: source.id,
		idempotencyKey: "rerun-1",
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.created).toBe(true);
	expect(result.task.id).not.toBe(source.id);
	expect(result.task).toMatchObject({
		organization_id: source.organization_id,
		repository_id: source.repository_id,
		goal: source.goal,
		created_by: source.created_by,
		status: "queued",
		retry_of: source.id,
		retry_depth: 1,
		branch: "task/original-retry-1",
	});
	expect(result.task.acceptance_criteria).toEqual(source.acceptance_criteria);
	expect(result.task.file_ownership).toEqual(source.file_ownership);
	// The cap is the original one; a retry never widens the budget.
	expect(result.task.budget_limits).toEqual(source.budget_limits);
	// The source stays a terminal `failed` row; no state was reopened.
	expect((await repo.get(source.id))?.status).toBe("failed");
});

test("recordPullRequest is tenant-scoped and persists number and url", async () => {
	const repo = new InMemoryTaskRepository();
	const source = await failedSource(repo);
	const url = "https://github.com/example/repo/pull/12";
	const updated = await repo.recordPullRequest({
		organizationId: orgA,
		taskId: source.id,
		pullRequestNumber: 12,
		pullRequestUrl: url,
	});
	expect(updated).toMatchObject({
		pull_request_number: 12,
		pull_request_url: url,
	});
	expect((await repo.get(source.id))?.pull_request_number).toBe(12);

	// A foreign organization can neither write nor read another tenant's task.
	expect(
		await repo.recordPullRequest({
			organizationId: orgB,
			taskId: source.id,
			pullRequestNumber: 99,
			pullRequestUrl: "https://github.com/example/repo/pull/99",
		}),
	).toBeNull();
	expect((await repo.get(source.id))?.pull_request_number).toBe(12);
});

test("createRetry replay returns the same task and exactly one row", async () => {
	const repo = new InMemoryTaskRepository();
	const source = await failedSource(repo);
	const input = {
		organizationId: orgA,
		failedTaskId: source.id,
		idempotencyKey: "rerun-replay",
	};
	const first = await repo.createRetry(input);
	const second = await repo.createRetry(input);
	expect(first.ok && second.ok).toBe(true);
	if (!first.ok || !second.ok) return;
	expect(second.created).toBe(false);
	expect(second.task.id).toBe(first.task.id);
	expect(
		await repo.getByIdempotencyKey(orgA, `retry:${source.id}:rerun-replay`),
	).not.toBeNull();
});

test("createRetry refuses a non-failed source with CONFLICT", async () => {
	const repo = new InMemoryTaskRepository();
	const queued = await repo.create(createInput("still-queued"));
	expect(
		await repo.createRetry({
			organizationId: orgA,
			failedTaskId: queued.id,
			idempotencyKey: "rerun-conflict",
		}),
	).toEqual({ ok: false, code: "CONFLICT" });
});

test("createRetry refuses an absent or foreign source with NOT_FOUND", async () => {
	const repo = new InMemoryTaskRepository();
	const source = await failedSource(repo);
	expect(
		await repo.createRetry({
			organizationId: orgB,
			failedTaskId: source.id,
			idempotencyKey: "rerun-foreign",
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	expect(
		await repo.createRetry({
			organizationId: orgA,
			failedTaskId: asTaskId("40000000-0000-4000-8000-0000000000ff"),
			idempotencyKey: "rerun-absent",
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
});

test("createRetry stops at the depth ceiling (POLICY_DENIED)", async () => {
	const repo = new InMemoryTaskRepository();
	let current = await failedSource(repo);
	for (let depth = 1; depth <= MAX_RETRY_DEPTH; depth += 1) {
		const result = await repo.createRetry({
			organizationId: orgA,
			failedTaskId: current.id,
			idempotencyKey: `rerun-depth-${depth}`,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.task.retry_depth).toBe(depth);
		current = result.task;
		await repo.transition({
			taskId: current.id,
			to: "failed",
			expectedStatus: "queued",
		});
	}
	expect(
		await repo.createRetry({
			organizationId: orgA,
			failedTaskId: current.id,
			idempotencyKey: "rerun-depth-4",
		}),
	).toEqual({ ok: false, code: "POLICY_DENIED" });
});

test("createRetry accepts an explicit branch for the rerun", async () => {
	const repo = new InMemoryTaskRepository();
	const source = await failedSource(repo);
	const result = await repo.createRetry({
		organizationId: orgA,
		failedTaskId: source.id,
		idempotencyKey: "rerun-branch",
		branch: "task/rerun-explicit",
	});
	expect(result.ok && result.task.branch).toBe("task/rerun-explicit");
	expect(result.ok && result.task.worktree).toBe("task/rerun-explicit");
});
