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
 * - blob binding: `storageRef` (when present) is `blob:<sha256>`, `sha256`
 *   covers the full bytes and `byteSize` covers the inline preview;
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
	/**
	 * Inline preview of the artifact. Always bounded by the implementation
	 * (256 KiB UTF-8 bytes in Postgres); when `storageRef` is set this is only
	 * the leading slice of the full bytes.
	 */
	readonly content: string;
	/**
	 * SHA-256 of the FULL stored bytes. For an inline-only artifact that is the
	 * digest of `content`; with a blob it is the digest the blob was stored
	 * under, so `storageRef` must equal `blob:<sha256>`.
	 */
	readonly sha256: string;
	/**
	 * Wave 11: `blob:<sha256>` when the full bytes live in a `BlobStore`.
	 * Absent means the artifact is stored inline as `inline:<sha256>`.
	 */
	readonly storageRef?: string;
	/**
	 * Full byte size of the stored payload. Defaults to the inline content
	 * length; with a blob it must be at least the preview size and at most
	 * 2 MiB (the store ceiling).
	 */
	readonly byteSize?: number;
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
