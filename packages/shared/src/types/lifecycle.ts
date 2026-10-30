import type { EventActor, RunEventType } from "./events";
import type { OrganizationId, TaskId } from "./ids";
import type { TaskStatus } from "./task-state";

/**
 * Execution lifecycle sink (wave 7).
 *
 * The worker owns "what happened"; this interface owns "make it durable". An
 * implementation writes task transitions, append-only run events, task
 * attempts, bounded artifacts and approval requests in the platform database.
 * Fakes implement the same contract for offline acceptance.
 *
 * Invariants every implementation must preserve:
 * - tenant scope: every input carries `organizationId` and rows are filtered by it;
 * - transition legality: `from -> to` must satisfy `TASK_STATE_TRANSITIONS`;
 * - append-only events: no update/delete path is exposed;
 * - bounded artifacts: content is capped by the implementation (never unbounded);
 * - approval binding: `payloadSha256` is stored verbatim, never recomputed.
 */
export type LifecycleArtifactKind =
	| "diff"
	| "log_bundle"
	| "report"
	| "screenshot";

export type LifecycleApprovalStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "expired";

export type LifecycleApprovalState = {
	readonly status: LifecycleApprovalStatus;
	/** Stored verbatim; the worker compares it with the action it is about to take. */
	readonly payloadSha256: string;
};

export type LifecycleTransitionInput = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly from: TaskStatus;
	readonly to: TaskStatus;
	readonly actor: EventActor;
	readonly reason?: string;
};

export type LifecycleEventInput = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly workflowRunId: string | null;
	readonly type: RunEventType;
	readonly actor: EventActor;
	readonly data?: Readonly<Record<string, unknown>>;
};

export type LifecycleArtifactInput = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly kind: LifecycleArtifactKind;
	readonly contentType: string;
	readonly content: string;
	readonly sha256: string;
};

export type LifecycleApprovalInput = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly workflowRunId: string | null;
	/** Bounded action vocabulary, e.g. `git.push_branch`. */
	readonly action: string;
	/** sha256 of the exact canonical payload; a payload change invalidates it. */
	readonly payloadSha256: string;
	readonly requestedBy: string;
	readonly expiresAt: Date;
};

export interface ExecutionLifecycle {
	/** Optimistic transition; a stale `from` is a CONFLICT, an illegal pair is INVALID_TRANSITION. */
	transition(input: LifecycleTransitionInput): Promise<void>;
	event(input: LifecycleEventInput): Promise<void>;
	artifact(
		input: LifecycleArtifactInput,
	): Promise<{ readonly artifactId: string }>;
	attemptStarted(input: {
		readonly organizationId: OrganizationId;
		readonly taskId: TaskId;
		readonly workflowRunId: string | null;
	}): Promise<{ readonly attemptId: string; readonly attemptIndex: number }>;
	attemptFinished(input: {
		readonly organizationId: OrganizationId;
		readonly taskId: TaskId;
		readonly attemptId: string;
		readonly outcome: Readonly<Record<string, unknown>> | null;
	}): Promise<void>;
	approvalRequested(
		input: LifecycleApprovalInput,
	): Promise<{ readonly approvalId: string }>;
	/** Tenant-scoped read of one approval; `null` means absent or foreign. */
	approvalStatus(input: {
		readonly organizationId: OrganizationId;
		readonly taskId: TaskId;
		readonly approvalId: string;
	}): Promise<LifecycleApprovalState | null>;
	/** True when the task has moved to `cancelled`; the worker must stop before the next turn. */
	isCancelled(input: {
		readonly organizationId: OrganizationId;
		readonly taskId: TaskId;
	}): Promise<boolean>;
}
