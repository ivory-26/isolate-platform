import type { ApprovalId, OrganizationId, TaskId } from "@isolate/shared";
import type { ApprovalRow } from "../schema";

/**
 * Approvals pause a workflow on sensitive actions (architecture §8). The
 * approval is bound to the SHA-256 of the exact action payload — if the payload
 * changes after the request, the decision must be invalidated.
 */
export interface ApprovalRepository {
	request(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		workflowRunId: string | null;
		action: string;
		payloadSha256: string;
		requestedBy: string;
		expiresInSeconds: number;
	}): Promise<ApprovalRow>;

	get(approvalId: ApprovalId): Promise<ApprovalRow | null>;

	/** Records a decision; only exact payload hash + pending status accept it. */
	decide(input: {
		approvalId: ApprovalId;
		decide: "approve" | "reject";
		payloadSha256: string;
		decidedBy: string;
	}): Promise<
		| { ok: true; approval: ApprovalRow }
		| {
				ok: false;
				code:
					| "NOT_FOUND"
					| "APPROVAL_EXPIRED"
					| "PAYLOAD_CHANGED"
					| "ALREADY_DECIDED";
		  }
	>;

	/** Pending approvals older than `ms` become expired (worker timer). */
	expirePending(ms: number): Promise<number>;

	/** Marks every lingering pending approval for the task as expired. */
	expirePendingForTask(taskId: TaskId): Promise<number>;

	listPending(organizationId: OrganizationId): Promise<ApprovalRow[]>;
}
