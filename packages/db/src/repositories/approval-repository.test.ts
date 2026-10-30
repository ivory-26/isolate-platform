import { expect, test } from "bun:test";
import { asOrganizationId, asTaskId } from "@isolate/shared";
import { InMemoryApprovalRepository } from "../testing/fakes";
import {
	evaluateApprovalDecision,
	evaluateDecisionOutcome,
} from "./approval-repository";

const orgA = asOrganizationId("10000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("10000000-0000-4000-8000-000000000002");
const SHA = "a".repeat(64);

/** Deterministic clock: every call advances one second. */
function tickingClock(startIso = "2026-10-31T12:00:00.000Z"): () => Date {
	let ms = new Date(startIso).getTime();
	return () => {
		ms += 1000;
		return new Date(ms);
	};
}

test("decide on a missing approval is NOT_FOUND", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: null,
			expiresAtMs: null,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
});

test("decide on an already-expired row is APPROVAL_EXPIRED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "expired",
			expiresAtMs: null,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
});

test("decide on a decided row is ALREADY_DECIDED", () => {
	for (const status of ["approved", "rejected"] as const) {
		expect(
			evaluateDecisionOutcome({
				currentStatus: status,
				expiresAtMs: null,
				nowMs: 1000,
				payloadSha256Match: true,
			}),
		).toEqual({ ok: false, code: "ALREADY_DECIDED" });
	}
});

test("decide with a mismatched payload hash is PAYLOAD_CHANGED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 2000,
			nowMs: 1000,
			payloadSha256Match: false,
		}),
	).toEqual({ ok: false, code: "PAYLOAD_CHANGED" });
});

test("decide on a pending-but-past-expiry row is APPROVAL_EXPIRED", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 1000,
			nowMs: 1001,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: false, code: "APPROVAL_EXPIRED" });
});

test("expiry boundary is inclusive: expires_at == now is expired", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 1000,
			nowMs: 1000,
			payloadSha256Match: true,
		}).ok,
	).toBe(false);
});

test("happy path: pending, exact hash, not expired => ok", () => {
	expect(
		evaluateDecisionOutcome({
			currentStatus: "pending",
			expiresAtMs: 2000,
			nowMs: 1000,
			payloadSha256Match: true,
		}),
	).toEqual({ ok: true });
});

test("pending decision helper: absent is NOT_FOUND, decided/expired is CONFLICT", () => {
	expect(
		evaluateApprovalDecision({
			found: false,
			currentStatus: null,
			expiresAtMs: null,
			nowMs: 1000,
			expectedStatus: "pending",
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	for (const status of ["approved", "rejected", "expired"] as const) {
		expect(
			evaluateApprovalDecision({
				found: true,
				currentStatus: status,
				expiresAtMs: 9000,
				nowMs: 1000,
				expectedStatus: "pending",
			}),
		).toEqual({ ok: false, code: "CONFLICT" });
	}
	// A pending row past expires_at is treated as expired => CONFLICT.
	expect(
		evaluateApprovalDecision({
			found: true,
			currentStatus: "pending",
			expiresAtMs: 1000,
			nowMs: 1000,
			expectedStatus: "pending",
		}),
	).toEqual({ ok: false, code: "CONFLICT" });
	expect(
		evaluateApprovalDecision({
			found: true,
			currentStatus: "pending",
			expiresAtMs: 2000,
			nowMs: 1000,
			expectedStatus: "pending",
		}),
	).toEqual({ ok: true });
});

async function requestApproval(
	repo: InMemoryApprovalRepository,
	taskId: ReturnType<typeof asTaskId>,
	organizationId = orgA,
) {
	return repo.request({
		organizationId,
		taskId,
		workflowRunId: null,
		action: "github.create_pull_request",
		payloadSha256: SHA,
		requestedBy: "worker",
		expiresInSeconds: 300,
	});
}

test("listByTask is newest first, tenant-scoped and bounded", async () => {
	const repo = new InMemoryApprovalRepository(tickingClock());
	const taskId = asTaskId("50000000-0000-4000-8000-000000000001");
	const first = await requestApproval(repo, taskId);
	const second = await requestApproval(repo, taskId);
	const third = await requestApproval(repo, taskId);
	const listed = await repo.listByTask({ organizationId: orgA, taskId });
	expect(listed.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
	expect(
		(await repo.listByTask({ organizationId: orgA, taskId, limit: 2 })).map(
			(row) => row.id,
		),
	).toEqual([third.id, second.id]);
	// A foreign organization sees nothing, even with the right task id.
	expect(await repo.listByTask({ organizationId: orgB, taskId })).toEqual([]);
	expect(
		await repo.listByTask({
			organizationId: orgA,
			taskId: asTaskId("50000000-0000-4000-8000-0000000000ff"),
		}),
	).toEqual([]);
});

test("pending decide approves once and records the audit row", async () => {
	const repo = new InMemoryApprovalRepository(tickingClock());
	const taskId = asTaskId("50000000-0000-4000-8000-000000000002");
	const approval = await requestApproval(repo, taskId);
	const decided = await repo.decide({
		organizationId: orgA,
		taskId,
		approvalId: approval.id,
		expectedStatus: "pending",
		decision: "approved",
		decidedBy: "user-1",
	});
	expect(decided.ok).toBe(true);
	if (decided.ok) {
		expect(decided.approval.status).toBe("approved");
		expect(decided.approval.decided_by).toBe("user-1");
		expect(decided.approval.decided_at).toBeInstanceOf(Date);
	}
	const audits = repo.listAuditEvents();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({
		organization_id: orgA,
		actor_id: "user-1",
		actor_kind: "user",
		action: "approval.decide",
		target: `approval:${approval.id}`,
	});
	// A second decision on the decided row is CONFLICT, not an overwrite.
	expect(
		await repo.decide({
			organizationId: orgA,
			taskId,
			approvalId: approval.id,
			expectedStatus: "pending",
			decision: "rejected",
			decidedBy: "user-2",
		}),
	).toEqual({ ok: false, code: "CONFLICT" });
	expect(repo.listAuditEvents()).toHaveLength(1);
});

test("pending decide on an expired approval is CONFLICT", async () => {
	const repo = new InMemoryApprovalRepository(tickingClock());
	const taskId = asTaskId("50000000-0000-4000-8000-000000000003");
	const approval = await requestApproval(repo, taskId);
	await repo.expirePending(0);
	expect(
		await repo.decide({
			organizationId: orgA,
			taskId,
			approvalId: approval.id,
			expectedStatus: "pending",
			decision: "approved",
			decidedBy: "user-1",
		}),
	).toEqual({ ok: false, code: "CONFLICT" });
	expect(repo.listAuditEvents()).toHaveLength(0);
});

test("pending decide is tenant-scoped: a foreign org or task is NOT_FOUND", async () => {
	const repo = new InMemoryApprovalRepository(tickingClock());
	const taskId = asTaskId("50000000-0000-4000-8000-000000000004");
	const approval = await requestApproval(repo, taskId);
	const otherTask = asTaskId("50000000-0000-4000-8000-0000000000ff");
	expect(
		await repo.decide({
			organizationId: orgB,
			taskId,
			approvalId: approval.id,
			expectedStatus: "pending",
			decision: "approved",
			decidedBy: "user-1",
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	expect(
		await repo.decide({
			organizationId: orgA,
			taskId: otherTask,
			approvalId: approval.id,
			expectedStatus: "pending",
			decision: "approved",
			decidedBy: "user-1",
		}),
	).toEqual({ ok: false, code: "NOT_FOUND" });
	expect((await repo.get(approval.id))?.status).toBe("pending");
});

test("the legacy payload-bound decide shape still routes correctly", async () => {
	const repo = new InMemoryApprovalRepository(tickingClock());
	const taskId = asTaskId("50000000-0000-4000-8000-000000000005");
	const approval = await requestApproval(repo, taskId);
	const wrongHash = await repo.decide({
		approvalId: approval.id,
		decide: "approve",
		payloadSha256: "b".repeat(64),
		decidedBy: "worker",
	});
	expect(wrongHash).toEqual({ ok: false, code: "PAYLOAD_CHANGED" });
	const decided = await repo.decide({
		approvalId: approval.id,
		decide: "approve",
		payloadSha256: SHA,
		decidedBy: "worker",
	});
	expect(decided.ok).toBe(true);
	// The payload-bound path records no human audit row.
	expect(repo.listAuditEvents()).toHaveLength(0);
});
