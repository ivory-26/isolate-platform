import { describe, expect, test } from "bun:test";
import { asTaskId, type RunEventType, type TaskStatus } from "@isolate/shared";
import {
	approvalActionCreatePullRequest,
	approvalActionPushBranch,
	decisionMessages,
} from "../features/tasks/contracts";
import { harness, input, otherScope, scope } from "./test-fixtures";

type Harness = ReturnType<typeof harness>;

async function failedTask(
	h: Harness,
	key = crypto.randomUUID(),
): Promise<string> {
	const submitted = await h.service.submit(input({ idempotencyKey: key }));
	if (!submitted.ok) throw new Error("Expected a submitted task");
	const taskId = submitted.value.task.id;
	await h.tasks.transition({
		taskId: asTaskId(taskId),
		to: "failed",
		expectedStatus: "queued",
	});
	// The submission's own run_task job is not part of the action under test.
	h.queue.calls.length = 0;
	h.tasks.calls.length = 0;
	return taskId;
}

async function awaitingApprovalTask(h: Harness): Promise<string> {
	const submitted = await h.service.submit(input());
	if (!submitted.ok) throw new Error("Expected a submitted task");
	const taskId = submitted.value.task.id;
	const steps: Array<[TaskStatus, TaskStatus]> = [
		["queued", "planning"],
		["planning", "awaiting_approval"],
	];
	for (const [expectedStatus, to] of steps)
		await h.tasks.transition({
			taskId: asTaskId(taskId),
			to,
			expectedStatus,
		});
	h.queue.calls.length = 0;
	h.tasks.calls.length = 0;
	return taskId;
}

async function eventTypes(h: Harness, taskId: string): Promise<RunEventType[]> {
	return (await eventsFor(h, taskId)).map((event) => event.type);
}

function eventsFor(h: Harness, taskId: string) {
	return h.lifecycle.listEvents({
		organizationId: scope.organizationId,
		taskId: asTaskId(taskId),
	});
}

describe("retryTask service action", () => {
	test("a viewer is denied before any storage is touched", async () => {
		const h = harness();
		const viewer = h.serviceFor({ ...scope, role: "viewer" });
		expect(
			await viewer.retry({
				failedTaskId: crypto.randomUUID(),
				idempotencyKey: crypto.randomUUID(),
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.reads()).toBe(0);
		expect(h.tasks.retryCalls).toHaveLength(0);
		expect(h.queue.calls).toHaveLength(0);
	});
	test("reproduces the boundary server-side with one run_task job", async () => {
		const h = harness();
		const sourceId = await failedTask(h);
		const source = await h.tasks.get(asTaskId(sourceId));
		if (source === null) throw new Error("Expected the failed source");
		const key = crypto.randomUUID();
		const result = await h.service.retry({
			failedTaskId: sourceId,
			idempotencyKey: key,
		});
		if (!result.ok) throw new Error("Expected a retry receipt");
		// Only the source id + bounded request key reach storage; the boundary
		// (repository, goal, acceptance, ownership, budget) is copied server-side.
		expect(h.tasks.retryCalls).toHaveLength(1);
		expect(h.tasks.retryCalls[0]).toEqual({
			organizationId: scope.organizationId,
			failedTaskId: asTaskId(sourceId),
			idempotencyKey: key,
		});
		expect(result.value.created).toBe(true);
		expect(result.value.branch).toBe(`${source.branch}-retry-1`);
		const retried = await h.tasks.get(asTaskId(result.value.taskId));
		if (retried === null) throw new Error("Expected the retry task");
		expect(retried).toMatchObject({
			organization_id: source.organization_id,
			repository_id: source.repository_id,
			goal: source.goal,
			acceptance_criteria: source.acceptance_criteria,
			file_ownership: source.file_ownership,
			budget_limits: source.budget_limits,
			retry_of: source.id,
			retry_depth: 1,
			status: "queued",
		});
		expect(h.queue.calls).toHaveLength(1);
		expect(h.queue.calls[0]).toMatchObject({
			organizationId: scope.organizationId,
			taskId: result.value.taskId,
			type: "run_task",
			payload: { taskId: result.value.taskId },
		});
		// task.retried on the source, task.enqueued on the new task.
		const sourceEvents = await eventsFor(h, sourceId);
		expect(sourceEvents.map((event) => event.type)).toEqual(["task.retried"]);
		expect(sourceEvents[0].data).toMatchObject({
			retryTaskId: result.value.taskId,
			retryDepth: 1,
		});
		const retryEvents = await eventsFor(h, result.value.taskId);
		expect(retryEvents.map((event) => event.type)).toEqual(["task.enqueued"]);
	});
	test("a replayed request key returns the same task and enqueues nothing new", async () => {
		const h = harness();
		const sourceId = await failedTask(h);
		const key = crypto.randomUUID();
		const first = await h.service.retry({
			failedTaskId: sourceId,
			idempotencyKey: key,
		});
		const second = await h.service.retry({
			failedTaskId: sourceId,
			idempotencyKey: key,
		});
		if (!first.ok || !second.ok) throw new Error("Expected both replays");
		expect(second.value.taskId).toBe(first.value.taskId);
		expect(second.value.created).toBe(false);
		expect(h.queue.calls).toHaveLength(1);
		expect(await eventTypes(h, sourceId)).toEqual(["task.retried"]);
	});
	test("a foreign tenant can never rerun the task", async () => {
		const h = harness();
		const sourceId = await failedTask(h);
		expect(
			await h.serviceFor(otherScope).retry({
				failedTaskId: sourceId,
				idempotencyKey: crypto.randomUUID(),
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.queue.calls).toHaveLength(0);
	});
	test("a non-failed source is a bounded CONFLICT", async () => {
		const h = harness();
		const submitted = await h.service.submit(input());
		if (!submitted.ok) throw new Error("Expected a task");
		h.queue.calls.length = 0;
		const result = await h.service.retry({
			failedTaskId: submitted.value.task.id,
			idempotencyKey: crypto.randomUUID(),
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "CONFLICT", message: decisionMessages.retryNotFailed },
		});
		expect(h.queue.calls).toHaveLength(0);
	});
	test("depth 4 is refused as an exhausted boundary", async () => {
		const h = harness();
		const sourceId = await failedTask(h);
		let current = await h.service.retry({
			failedTaskId: sourceId,
			idempotencyKey: crypto.randomUUID(),
		});
		if (!current.ok) throw new Error("Expected a first retry");
		for (const depth of [2, 3]) {
			await h.tasks.transition({
				taskId: asTaskId(current.value.taskId),
				to: "failed",
				expectedStatus: "queued",
			});
			const next = await h.service.retry({
				failedTaskId: current.value.taskId,
				idempotencyKey: crypto.randomUUID(),
			});
			if (!next.ok) throw new Error("Expected a further retry");
			expect(
				(await h.tasks.get(asTaskId(next.value.taskId)))?.retry_depth,
			).toBe(depth);
			current = next;
		}
		await h.tasks.transition({
			taskId: asTaskId(current.value.taskId),
			to: "failed",
			expectedStatus: "queued",
		});
		const jobsBefore = h.queue.calls.length;
		const refused = await h.service.retry({
			failedTaskId: current.value.taskId,
			idempotencyKey: crypto.randomUUID(),
		});
		expect(refused).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				message: decisionMessages.retryDepthExhausted,
			},
		});
		expect(h.queue.calls).toHaveLength(jobsBefore);
	});
	test("invalid request keys never reach the store", async () => {
		const h = harness();
		for (const patch of [
			{ idempotencyKey: "" },
			{ idempotencyKey: "x".repeat(201) },
			{ failedTaskId: "not-a-uuid" },
			{ extra: true },
		]) {
			expect(
				await h.service.retry({
					failedTaskId: crypto.randomUUID(),
					idempotencyKey: crypto.randomUUID(),
					...patch,
				}),
			).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
		}
		expect(h.reads()).toBe(0);
	});
});

describe("decideApproval service action", () => {
	test("a viewer is denied before any storage is touched", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		const viewer = h.serviceFor({ ...scope, role: "viewer" });
		const storeReads = h.reads();
		expect(
			await viewer.decideApproval({
				taskId,
				approvalId: approval.id,
				decision: "approved",
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.reads()).toBe(storeReads);
		expect(h.approvals.listAuditEvents()).toHaveLength(0);
	});
	test("approving a push enqueues exactly one resume_task job", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		const result = await h.service.decideApproval({
			taskId,
			approvalId: approval.id,
			decision: "approved",
		});
		if (!result.ok) throw new Error("Expected an approval receipt");
		expect(result.value).toEqual({
			taskId,
			approvalId: approval.id,
			decision: "approved",
			jobId: expect.any(String),
		});
		expect(h.queue.calls).toHaveLength(1);
		expect(h.queue.calls[0]).toMatchObject({
			organizationId: scope.organizationId,
			taskId,
			type: "resume_task",
			payload: {
				taskId,
				approvalId: approval.id,
				action: approvalActionPushBranch,
			},
		});
		expect(await eventTypes(h, taskId)).toEqual(["approval.decided"]);
		const audit = h.approvals.listAuditEvents();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			organization_id: scope.organizationId,
			actor_id: scope.userId,
			actor_kind: "user",
			action: "approval.decide",
			target: `approval:${approval.id}`,
			details: {
				approvalId: approval.id,
				taskId,
				action: approvalActionPushBranch,
				decision: "approved",
			},
		});
		expect((await h.approvals.get(approval.id))?.status).toBe("approved");
		// The task resumes through the job, not through this action.
		expect((await h.tasks.get(asTaskId(taskId)))?.status).toBe(
			"awaiting_approval",
		);
	});
	test("approving a pull request enqueues exactly one create_pull_request job", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionCreatePullRequest,
		});
		expect(
			await h.service.decideApproval({
				taskId,
				approvalId: approval.id,
				decision: "approved",
			}),
		).toMatchObject({ ok: true });
		expect(h.queue.calls).toHaveLength(1);
		expect(h.queue.calls[0]).toMatchObject({
			taskId,
			type: "create_pull_request",
			payload: { taskId, approvalId: approval.id },
		});
	});
	test("rejecting fails the task and enqueues nothing", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		const result = await h.service.decideApproval({
			taskId,
			approvalId: approval.id,
			decision: "rejected",
		});
		if (!result.ok) throw new Error("Expected a rejection receipt");
		expect(result.value.jobId).toBeNull();
		expect(h.queue.calls).toHaveLength(0);
		expect((await h.tasks.get(asTaskId(taskId)))?.status).toBe("failed");
		expect(await eventTypes(h, taskId)).toEqual(["approval.decided"]);
		expect(h.approvals.listAuditEvents()).toHaveLength(1);
		expect((await h.approvals.get(approval.id))?.status).toBe("rejected");
	});
	test("an expired approval is CONFLICT and changes nothing", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
			expiresInSeconds: 1,
		});
		h.advanceClock(2_000);
		const result = await h.service.decideApproval({
			taskId,
			approvalId: approval.id,
			decision: "approved",
		});
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				message: decisionMessages.approvalNotPending,
			},
		});
		expect(h.queue.calls).toHaveLength(0);
		expect((await h.approvals.get(approval.id))?.status).toBe("pending");
		expect(await eventTypes(h, taskId)).toEqual([]);
		expect(h.approvals.listAuditEvents()).toHaveLength(0);
	});
	test("a replayed decision is CONFLICT with one job in total", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		const request = {
			taskId,
			approvalId: approval.id,
			decision: "approved" as const,
		};
		expect(await h.service.decideApproval(request)).toMatchObject({ ok: true });
		expect(await h.service.decideApproval(request)).toMatchObject({
			ok: false,
			error: { code: "CONFLICT" },
		});
		expect(h.queue.calls).toHaveLength(1);
		expect(h.approvals.listAuditEvents()).toHaveLength(1);
	});
	test("a foreign organization can never decide the approval", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		expect(
			await h.serviceFor(otherScope).decideApproval({
				taskId,
				approvalId: approval.id,
				decision: "approved",
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.queue.calls).toHaveLength(0);
		expect((await h.approvals.get(approval.id))?.status).toBe("pending");
		expect(h.approvals.listAuditEvents()).toHaveLength(0);
	});
	test("an approval for another task id is invisible", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const otherTaskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: approvalActionPushBranch,
		});
		expect(
			await h.service.decideApproval({
				taskId: otherTaskId,
				approvalId: approval.id,
				decision: "approved",
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.queue.calls).toHaveLength(0);
	});
	test("an approval action without a follow-up is refused before deciding", async () => {
		const h = harness();
		const taskId = await awaitingApprovalTask(h);
		const approval = await h.requestApproval({
			taskId: asTaskId(taskId),
			action: "db.migrate",
		});
		expect(
			await h.service.decideApproval({
				taskId,
				approvalId: approval.id,
				decision: "approved",
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "CONFLICT",
				message: decisionMessages.approvalActionUnsupported,
			},
		});
		expect((await h.approvals.get(approval.id))?.status).toBe("pending");
		expect(h.queue.calls).toHaveLength(0);
	});
	test("malformed decisions never reach the store", async () => {
		const h = harness();
		for (const patch of [
			{ decision: "maybe" },
			{ taskId: "not-a-uuid" },
			{ approvalId: "not-a-uuid" },
			{ extra: true },
		]) {
			expect(
				await h.service.decideApproval({
					taskId: crypto.randomUUID(),
					approvalId: crypto.randomUUID(),
					decision: "approved",
					...patch,
				}),
			).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
		}
		expect(h.reads()).toBe(0);
	});
});
