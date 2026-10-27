import type { JobId, OrganizationId, TaskId } from "@isolate/shared";

/**
 * Durable queue contract — database-backed with atomic claiming.
 *
 * Implementation requirements for Sprint A-2 (pgbouncer/Neon safe):
 * - `claimNext` must be a single atomic SQL statement combining row selection
 *   with lease assignment (`FOR UPDATE SKIP LOCKED`) across concurrent workers.
 * - `ackFail` decides retry vs dead-letter by comparing attempts against the
 *   task budget row, never a caller-supplied counter.
 * - `requeueExpiredLeases` runs on a timer in the worker.
 */
export type JobType = "run_task" | "validate_attempt" | "finalize_review";

export type JobRow = {
	id: JobId;
	organizationId: OrganizationId;
	taskId: TaskId;
	type: JobType;
	// Bounded JSON payload; schemas are validated by the consumer per type.
	payload: Record<string, unknown>;
	status: "pending" | "claimed" | "done" | "dead_letter";
	attempts: number;
	maxAttempts: number;
	lease?: { ownerId: string; leaseExpiresAt: string } | null;
	notBefore: string; // redelivery backoff floor (ISO string)
	enqueueUuidKey: string; // unique idempotency key per enqueue call
	lastError?: { code: string; message: string } | null;
	createdAt: string;
};

export interface QueueRepository {
	enqueue(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		type: JobType;
		payload: Record<string, unknown>;
		idempotencyKey: string;
		maxAttempts: number;
		notBefore?: string;
	}): Promise<JobRow>;

	/** Atomically claims the oldest visible pending/unexpired-lease job. */
	claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
	}): Promise<JobRow | null>;

	/** Extends the lease while a job is still owned by `ownerId`. */
	heartbeat(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean>;

	/** Returns true when the job did not belong to this owner (LEASE_LOST). */
	heartbeatResult(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }>;

	ackComplete(
		jobId: JobId,
		ownerId: string,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }>;

	/** Marks failure; retryable jobs go back to pending with backoff. */
	ackFail(input: {
		jobId: JobId;
		ownerId: string;
		code: string;
		message: string; // must be sanitised upstream
	}): Promise<
		| { ok: true; requeued: boolean }
		| { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }
	>;

	requeueExpiredLeases(nowMs: number): Promise<number>;
}
