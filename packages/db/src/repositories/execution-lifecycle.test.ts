import { beforeEach, describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	type OrganizationId,
} from "@isolate/shared";
import {
	createInMemoryExecutionTruth,
	type InMemoryArtifactRepository,
	type InMemoryExecutionLifecycle,
} from "../testing/execution-truth-fakes";
import type { InMemoryTaskRepository } from "../testing/fakes";
import {
	evaluateLifecycleApprovalStatus,
	isLifecycleError,
	type LifecycleErrorCode,
} from "./execution-lifecycle";

const orgA = asOrganizationId("30000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("30000000-0000-4000-8000-000000000002");
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

let now = new Date("2026-10-30T09:00:00.000Z");
let counter = 0;

let tasks: InMemoryTaskRepository;
let artifacts: InMemoryArtifactRepository;
let lifecycle: InMemoryExecutionLifecycle;

function clock(): Date {
	return new Date(now);
}

async function seedTask(
	organizationId: OrganizationId = orgA,
): Promise<string> {
	counter += 1;
	const task = await tasks.create({
		organizationId,
		repositoryId: crypto.randomUUID(),
		branch: `task/lifecycle-${counter}`,
		idempotencyKey: `idem-lifecycle-${counter}`,
		budgetLimits: {
			maxAgentTurns: 5,
			maxRepairAttempts: 2,
			maxDurationMs: 600000,
		},
		createdBy: "user-1",
	});
	return task.id;
}

async function expectLifecycleFailure(
	promise: Promise<unknown>,
	code: LifecycleErrorCode,
): Promise<void> {
	let caught: unknown;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(isLifecycleError(caught)).toBe(true);
	if (isLifecycleError(caught)) {
		expect(caught.code).toBe(code);
	}
}

beforeEach(() => {
	now = new Date("2026-10-30T09:00:00.000Z");
	const truth = createInMemoryExecutionTruth(clock);
	tasks = truth.tasks;
	artifacts = truth.artifacts;
	lifecycle = truth.lifecycle;
});

describe("InMemoryExecutionLifecycle transitions", () => {
	test("a legal transition changes the task status exactly once", async () => {
		const taskId = await seedTask();
		await lifecycle.transition({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			from: "queued",
			to: "planning",
			actor: "worker",
			reason: "claimed",
		});
		expect((await tasks.get(asTaskId(taskId)))?.status).toBe("planning");
	});

	test("a stale `from` is CONFLICT, not INVALID_TRANSITION", async () => {
		const taskId = await seedTask();
		await lifecycle.transition({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			from: "queued",
			to: "planning",
			actor: "worker",
		});
		// planning -> executing is legal, but the caller still expects queued.
		await expectLifecycleFailure(
			lifecycle.transition({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				from: "queued",
				to: "executing",
				actor: "worker",
			}),
			"CONFLICT",
		);
	});

	test("an undeclared pair is INVALID_TRANSITION and leaves the row untouched", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.transition({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				from: "queued",
				to: "completed",
				actor: "worker",
			}),
			"INVALID_TRANSITION",
		);
		expect((await tasks.get(asTaskId(taskId)))?.status).toBe("queued");
	});

	test("a foreign task is NOT_FOUND and is not mutated", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.transition({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				from: "queued",
				to: "planning",
				actor: "worker",
			}),
			"NOT_FOUND",
		);
		expect((await tasks.get(asTaskId(taskId)))?.status).toBe("queued");
	});

	test("a missing task is NOT_FOUND", async () => {
		await expectLifecycleFailure(
			lifecycle.transition({
				organizationId: orgA,
				taskId: asTaskId(crypto.randomUUID()),
				from: "queued",
				to: "planning",
				actor: "worker",
			}),
			"NOT_FOUND",
		);
	});

	test("an unknown status token is INVALID_INPUT", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.transition({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				from: "queued",
				to: "exploded" as never,
				actor: "worker",
			}),
			"INVALID_INPUT",
		);
	});
});

describe("InMemoryExecutionLifecycle events", () => {
	test("events are appended with their payload and tenant scope", async () => {
		const taskId = await seedTask();
		const otherTaskId = await seedTask();
		await lifecycle.event({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			type: "workspace.cloned",
			actor: "worker",
			data: { branch: "task/x", nested: { ok: true } },
		});
		const events = await lifecycle.listEvents({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "workspace.cloned",
			actor: "worker",
			data: { branch: "task/x", nested: { ok: true } },
		});
		expect(
			await lifecycle.listEvents({
				organizationId: orgA,
				taskId: asTaskId(otherTaskId),
			}),
		).toEqual([]);
		expect(
			await lifecycle.listEvents({
				organizationId: orgB,
				taskId: asTaskId(taskId),
			}),
		).toEqual([]);
	});

	test("the returned event list is a copy (append-only store)", async () => {
		const taskId = await seedTask();
		await lifecycle.event({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			type: "agent.turn_started",
			actor: "agent",
			data: { turn: 1 },
		});
		const first = await lifecycle.listEvents({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		first[0].data.mutated = true;
		const second = await lifecycle.listEvents({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		expect(second[0].data).toEqual({ turn: 1 });
	});

	test("an event for a foreign task is NOT_FOUND and writes nothing", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.event({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				workflowRunId: null,
				type: "task.claimed",
				actor: "worker",
			}),
			"NOT_FOUND",
		);
		expect(
			await lifecycle.listEvents({
				organizationId: orgB,
				taskId: asTaskId(taskId),
			}),
		).toEqual([]);
	});
});

describe("InMemoryExecutionLifecycle artifacts", () => {
	test("stores sha verbatim behind storage_ref inline:<sha>", async () => {
		const taskId = await seedTask();
		const result = await lifecycle.artifact({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			kind: "diff",
			contentType: "text/x-diff",
			content: "+hello",
			sha256: SHA,
		});
		const listed = await artifacts.listByTask({
			organizationId: orgA,
			taskId: asTaskId(taskId),
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: result.artifactId,
			sha256: SHA,
			storage_ref: `inline:${SHA}`,
			content: "+hello",
		});
	});

	test("oversize content is rejected before insert", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.artifact({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				kind: "diff",
				contentType: "text/plain",
				content: "a".repeat(262145),
				sha256: SHA,
			}),
			"INVALID_INPUT",
		);
		expect(
			await artifacts.listByTask({
				organizationId: orgA,
				taskId: asTaskId(taskId),
			}),
		).toEqual([]);
	});

	test("a foreign task is NOT_FOUND", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.artifact({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				kind: "diff",
				contentType: "text/plain",
				content: "stolen",
				sha256: SHA,
			}),
			"NOT_FOUND",
		);
	});
});

describe("InMemoryExecutionLifecycle attempts", () => {
	test("attempt indexes are monotonic per task", async () => {
		const taskId = await seedTask();
		const first = await lifecycle.attemptStarted({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
		});
		const second = await lifecycle.attemptStarted({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
		});
		expect(first.attemptIndex).toBe(1);
		expect(second.attemptIndex).toBe(2);
		expect(second.attemptId).not.toBe(first.attemptId);
	});

	test("attemptFinished is tenant-scoped and rejects a foreign attempt id", async () => {
		const taskId = await seedTask();
		const attempt = await lifecycle.attemptStarted({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
		});
		await lifecycle.attemptFinished({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			attemptId: attempt.attemptId,
			outcome: { kind: "execution", notes: "done" },
		});
		await expectLifecycleFailure(
			lifecycle.attemptFinished({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				attemptId: attempt.attemptId,
				outcome: null,
			}),
			"NOT_FOUND",
		);
	});

	test("attemptStarted for a foreign task is NOT_FOUND", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.attemptStarted({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				workflowRunId: null,
			}),
			"NOT_FOUND",
		);
	});
});

describe("InMemoryExecutionLifecycle approvals", () => {
	test("a duplicate pending (task, action) is idempotent and keeps the first sha", async () => {
		const taskId = await seedTask();
		const first = await lifecycle.approvalRequested({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			action: "git.push_branch",
			payloadSha256: SHA,
			requestedBy: "worker",
			expiresAt: new Date(now.getTime() + 60000),
		});
		const duplicate = await lifecycle.approvalRequested({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			action: "git.push_branch",
			payloadSha256: OTHER_SHA,
			requestedBy: "worker",
			expiresAt: new Date(now.getTime() + 120000),
		});
		expect(duplicate.approvalId).toBe(first.approvalId);
		expect(
			await lifecycle.approvalStatus({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				approvalId: first.approvalId,
			}),
		).toEqual({ status: "pending", payloadSha256: SHA });

		const otherAction = await lifecycle.approvalRequested({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			action: "github.create_pull_request",
			payloadSha256: OTHER_SHA,
			requestedBy: "worker",
			expiresAt: new Date(now.getTime() + 60000),
		});
		expect(otherAction.approvalId).not.toBe(first.approvalId);
	});

	test("expires_at in the past reads as expired, including an approved row", async () => {
		const taskId = await seedTask();
		const approval = await lifecycle.approvalRequested({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			action: "git.push_branch",
			payloadSha256: SHA,
			requestedBy: "worker",
			expiresAt: new Date(now.getTime() + 1000),
		});
		expect(
			await lifecycle.approvalStatus({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				approvalId: approval.approvalId,
			}),
		).toMatchObject({ status: "pending" });
		now = new Date(now.getTime() + 1000);
		expect(
			await lifecycle.approvalStatus({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				approvalId: approval.approvalId,
			}),
		).toEqual({ status: "expired", payloadSha256: SHA });
	});

	test("approval reads are tenant-scoped: foreign org -> null, foreign write -> NOT_FOUND", async () => {
		const taskId = await seedTask();
		const approval = await lifecycle.approvalRequested({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			workflowRunId: null,
			action: "git.push_branch",
			payloadSha256: SHA,
			requestedBy: "worker",
			expiresAt: new Date(now.getTime() + 60000),
		});
		expect(
			await lifecycle.approvalStatus({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				approvalId: approval.approvalId,
			}),
		).toBeNull();
		expect(
			await lifecycle.approvalStatus({
				organizationId: orgA,
				taskId: asTaskId(crypto.randomUUID()),
				approvalId: approval.approvalId,
			}),
		).toBeNull();
		await expectLifecycleFailure(
			lifecycle.approvalRequested({
				organizationId: orgB,
				taskId: asTaskId(taskId),
				workflowRunId: null,
				action: "git.push_branch",
				payloadSha256: SHA,
				requestedBy: "worker",
				expiresAt: new Date(now.getTime() + 60000),
			}),
			"NOT_FOUND",
		);
	});

	test("an invalid payload digest is INVALID_INPUT", async () => {
		const taskId = await seedTask();
		await expectLifecycleFailure(
			lifecycle.approvalRequested({
				organizationId: orgA,
				taskId: asTaskId(taskId),
				workflowRunId: null,
				action: "git.push_branch",
				payloadSha256: "too-short",
				requestedBy: "worker",
				expiresAt: new Date(now.getTime() + 60000),
			}),
			"INVALID_INPUT",
		);
	});
});

describe("InMemoryExecutionLifecycle cancellation", () => {
	test("only `cancelled` is true; missing/foreign tasks are NOT_FOUND", async () => {
		const taskId = await seedTask();
		expect(
			await lifecycle.isCancelled({
				organizationId: orgA,
				taskId: asTaskId(taskId),
			}),
		).toBe(false);
		await lifecycle.transition({
			organizationId: orgA,
			taskId: asTaskId(taskId),
			from: "queued",
			to: "cancelled",
			actor: "user",
		});
		expect(
			await lifecycle.isCancelled({
				organizationId: orgA,
				taskId: asTaskId(taskId),
			}),
		).toBe(true);
		await expectLifecycleFailure(
			lifecycle.isCancelled({
				organizationId: orgB,
				taskId: asTaskId(taskId),
			}),
			"NOT_FOUND",
		);
		await expectLifecycleFailure(
			lifecycle.isCancelled({
				organizationId: orgA,
				taskId: asTaskId(crypto.randomUUID()),
			}),
			"NOT_FOUND",
		);
	});
});

describe("evaluateLifecycleApprovalStatus", () => {
	test("expiry overrides pending and approved but not a decision", () => {
		const nowMs = 1000;
		expect(
			evaluateLifecycleApprovalStatus({
				status: "pending",
				expiresAtMs: 2000,
				nowMs,
			}),
		).toBe("pending");
		expect(
			evaluateLifecycleApprovalStatus({
				status: "pending",
				expiresAtMs: 1000,
				nowMs,
			}),
		).toBe("expired");
		expect(
			evaluateLifecycleApprovalStatus({
				status: "approved",
				expiresAtMs: 500,
				nowMs,
			}),
		).toBe("expired");
		expect(
			evaluateLifecycleApprovalStatus({
				status: "rejected",
				expiresAtMs: 500,
				nowMs,
			}),
		).toBe("rejected");
		expect(
			evaluateLifecycleApprovalStatus({
				status: "expired",
				expiresAtMs: 5000,
				nowMs,
			}),
		).toBe("expired");
	});
});
