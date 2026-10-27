import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	type OrganizationId,
} from "@isolate/shared";
import {
	InMemoryApprovalRepository,
	InMemoryQueueRepository,
	InMemoryTaskRepository,
} from "./fakes";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

function org(): OrganizationId {
	return asOrganizationId(crypto.randomUUID());
}

describe("InMemoryTaskRepository (TaskRepository contract)", () => {
	test("create -> queued with budget persisted; idempotent on same key", async () => {
		const repo = new InMemoryTaskRepository();
		const input = {
			organizationId: org(),
			repositoryId: crypto.randomUUID(),
			branch: "task/demo",
			idempotencyKey: "idem-1",
			budgetLimits: {
				maxAgentTurns: 5,
				maxRepairAttempts: 2,
				maxDurationMs: 600000,
			},
			createdBy: "user-1",
		} as const;
		const first = await repo.create(input);
		expect(first.status).toBe("queued");
		expect(first.budget_limits).toEqual({
			max_agent_turns: 5,
			max_repair_attempts: 2,
			max_duration_ms: 600000,
		});
		expect(first.worktree).toBe("task/demo");

		const second = await repo.create(input);
		expect(second.id).toBe(first.id);
		const byKey = await repo.getByIdempotencyKey(
			input.organizationId,
			"idem-1",
		);
		expect(byKey?.id).toBe(first.id);
	});

	test("transition guard: illegal move rejected, legal moves work, stale expectation conflicts", async () => {
		const repo = new InMemoryTaskRepository();
		const task = await repo.create(createInput());
		expect(task.status).toBe("queued");

		// queued -> pull_request_created is not a declared edge (row still
		// queued, expectation matches, so this is INVALID_TRANSITION).
		const illegal = await repo.transition({
			taskId: task.id,
			to: "pull_request_created",
			expectedStatus: "queued",
		});
		expect(illegal.ok).toBe(false);
		if (!illegal.ok) {
			expect(illegal.code).toBe("INVALID_TRANSITION");
		}

		const legal = await repo.transition({
			taskId: task.id,
			to: "planning",
			expectedStatus: "queued",
		});
		expect(legal.ok).toBe(true);

		// Row is now planning; expecting queued conflicts.
		const conflict = await repo.transition({
			taskId: task.id,
			to: "executing",
			expectedStatus: "queued",
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) {
			expect(conflict.code).toBe("CONFLICT");
		}

		expect(
			(
				await repo.transition({
					taskId: asTaskId(crypto.randomUUID()),
					to: "planning",
					expectedStatus: "queued",
				})
			).ok,
		).toBe(false);
	});

	test("listByStatus only surfaces that status", async () => {
		const repo = new InMemoryTaskRepository();
		const a = await repo.create(createInput("a"));
		await repo.create(createInput("b"));
		await repo.transition({
			taskId: a.id,
			to: "planning",
			expectedStatus: "queued",
		});
		const queued = await repo.listByStatus("queued", 10);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.idempotency_key).toBe("idem-b");
	});
});

describe("InMemoryApprovalRepository (ApprovalRepository contract)", () => {
	test("decide requires the exact payload_sha256", async () => {
		const repo = new InMemoryApprovalRepository();
		const approval = await repo.request({
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			workflowRunId: null,
			action: "pr.merge",
			payloadSha256: SHA,
			requestedBy: "agent-1",
			expiresInSeconds: 60,
		});

		const wrongPayload = await repo.decide({
			approvalId: approval.id,
			decide: "approve",
			payloadSha256: OTHER_SHA,
			decidedBy: "user-2",
		});
		expect(wrongPayload.ok).toBe(false);
		if (!wrongPayload.ok) {
			expect(wrongPayload.code).toBe("PAYLOAD_CHANGED");
		}

		const stillPending = await repo.get(approval.id);
		expect(stillPending?.status).toBe("pending");

		const decided = await repo.decide({
			approvalId: approval.id,
			decide: "approve",
			payloadSha256: SHA,
			decidedBy: "user-2",
		});
		expect(decided.ok).toBe(true);
		expect(decided.ok && decided.approval.status).toBe("approved");
	});

	test("double decision is rejected even with the exact hash", async () => {
		const repo = new InMemoryApprovalRepository();
		const approval = await repo.request({
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			workflowRunId: null,
			action: "db.migrate",
			payloadSha256: SHA,
			requestedBy: "agent-1",
			expiresInSeconds: 60,
		});
		await repo.decide({
			approvalId: approval.id,
			decide: "approve",
			payloadSha256: SHA,
			decidedBy: "u",
		});
		const again = await repo.decide({
			approvalId: approval.id,
			decide: "reject",
			payloadSha256: SHA,
			decidedBy: "u",
		});
		expect(again.ok).toBe(false);
		if (!again.ok) {
			expect(again.code).toBe("ALREADY_DECIDED");
		}
	});

	test("expired approvals refuse decisions; expirePending sweeps pending rows", async () => {
		const repo = new InMemoryApprovalRepository();
		const approval = await repo.request({
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			workflowRunId: null,
			action: "deploy.request",
			payloadSha256: SHA,
			requestedBy: "agent-1",
			expiresInSeconds: 1,
		});
		const expired = await repo.expirePending(0);
		expect(expired).toBe(1);
		const refused = await repo.decide({
			approvalId: approval.id,
			decide: "approve",
			payloadSha256: SHA,
			decidedBy: "u",
		});
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.code).toBe("APPROVAL_EXPIRED");
		}
	});
});

describe("InMemoryQueueRepository (QueueRepository contract)", () => {
	test("enqueue is idempotent per (org, enqueue key)", async () => {
		const queue = new InMemoryQueueRepository();
		const input = {
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			type: "run_task" as const,
			payload: { attempt: 1 },
			idempotencyKey: "job-key-1",
			maxAttempts: 3,
		};
		const first = await queue.enqueue(input);
		const second = await queue.enqueue(input);
		expect(second.id).toBe(first.id);
	});

	test("claim -> ackComplete retires the job; foreign owner loses the lease", async () => {
		const queue = new InMemoryQueueRepository();
		const job = await queue.enqueue({
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			type: "run_task",
			payload: {},
			idempotencyKey: "job-key-2",
			maxAttempts: 3,
		});

		const other = await queue.claimNext({
			ownerId: "worker-b",
			leaseSeconds: 5,
		});
		expect(other?.id).toBe(job.id);
		expect(other?.attempts).toBe(1);

		expect((await queue.ackComplete(job.id, "worker-a")).ok).toBe(false);
		const stolen = await queue.ackComplete(job.id, "worker-b");
		expect(stolen.ok).toBe(true);
	});

	test("ackFail requeues with stored counters until maxAttempts dead-letters", async () => {
		const queue = new InMemoryQueueRepository();
		const job = await queue.enqueue({
			organizationId: org(),
			taskId: asTaskId(crypto.randomUUID()),
			type: "validate_attempt",
			payload: {},
			idempotencyKey: "job-key-3",
			maxAttempts: 2,
		});

		let requeued: boolean | null = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			// Second iteration claims past the requeue backoff via the clock
			// hook instead of sleeping.
			const claimed = await queue.claimNext({
				ownerId: "worker-a",
				leaseSeconds: 5,
				nowMs: Date.now() + 60_000 * (attempt + 1),
			});
			expect(claimed?.id).toBe(job.id);
			// attempts increments inside the claim, mirroring the SQL driver.
			const fail = await queue.ackFail({
				jobId: job.id,
				ownerId: "worker-a",
				code: "E_TEST",
				message: "boom",
			});
			expect(fail.ok).toBe(true);
			if (fail.ok) {
				requeued = fail.requeued;
			}
		}
		// attempt 1 below max (2), attempt 2 at max -> dead letter.
		expect(requeued).toBe(false);
		const dead = await queue.claimNext({
			ownerId: "worker-a",
			leaseSeconds: 5,
		});
		expect(dead).toBeNull();
	});
});

function createInput(key = "a") {
	return {
		organizationId: org(),
		repositoryId: crypto.randomUUID(),
		branch: `task/${key}`,
		idempotencyKey: `idem-${key}`,
		budgetLimits: {
			maxAgentTurns: 5,
			maxRepairAttempts: 2,
			maxDurationMs: 3600000,
		},
		createdBy: "user-1",
	} as const;
}
