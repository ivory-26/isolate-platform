import type { JobId, OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Postgres (Neon) durable queue with atomic claiming.
 *
 * Safety model:
 * - `claimNext` is ONE statement: it selects the oldest claimable job row with
 *   `FOR UPDATE SKIP LOCKED` and flips it to `claimed` in the same UPDATE, so
 *   concurrent workers can never receive the same job twice. Counters are
 *   owned by the database (attempts increments inside the claim).
 * - `ackFail` decides retry vs dead-letter from the DB-side `attempts` vs
 *   `max_attempts`; callers can never influence the counter or the decision.
 * - Statements are static strings; every value is a bound `$n` parameter.
 */

/** Bounded job vocabulary; mirrors the jobs_type_check SQL constraint. */
export type JobType = "run_task" | "validate_attempt" | "finalize_review";

/** Bounded lifecycle status; mirrors the jobs_status_check SQL constraint. */
export type JobStatus = "pending" | "claimed" | "done" | "dead_letter";

/**
 * Queue row as surfaced to callers (camelCase). Timestamps are ISO strings;
 * `lease` is set only while a worker owns the row.
 */
export type JobRow = {
	id: JobId;
	organizationId: OrganizationId;
	taskId: TaskId;
	type: JobType;
	payload: Record<string, unknown>;
	status: JobStatus;
	attempts: number;
	maxAttempts: number;
	lease: { ownerId: string; leaseExpiresAt: string } | null;
	notBefore: string;
	enqueueUuidKey: string;
	lastError: { code: string; message: string } | null;
	createdAt: string;
};

/**
 * Contract for the durable queue. Declared in this module so the driver,
 * the Postgres implementation, and test fakes share one in-scope symbol.
 */
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
	claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
	}): Promise<JobRow | null>;
	heartbeat(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean>;
	heartbeatResult(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }>;
	ackComplete(
		jobId: JobId,
		ownerId: string,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }>;
	ackFail(input: {
		jobId: JobId;
		ownerId: string;
		code: string;
		message: string;
	}): Promise<
		| { ok: true; requeued: boolean }
		| { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }
	>;
	requeueExpiredLeases(nowMs: number): Promise<number>;
}

/** Backoff cap for redelivery: min(2^attempts, 300) seconds. */
export const ACK_FAIL_BACKOFF_CAP_SECONDS = 300;

export type AckFailOutcome = {
	requeued: boolean;
	status: "pending" | "dead_letter";
	backoffSeconds: number | null;
};

/** Pure dead-letter/decision math used by the SQL authoring and test fakes. */
export function ackFailOutcome(
	attempts: number,
	maxAttempts: number,
): AckFailOutcome {
	const safeMax = Math.max(1, Math.floor(maxAttempts));
	if (attempts >= safeMax) {
		return { requeued: false, status: "dead_letter", backoffSeconds: null };
	}
	const backoff = Math.min(2 ** attempts, ACK_FAIL_BACKOFF_CAP_SECONDS);
	return { requeued: true, status: "pending", backoffSeconds: backoff };
}

const JOB_COLUMNS = `id, organization_id, task_id, type, payload, status, attempts, max_attempts, lease_owner_id, lease_expires_at, not_before, enqueue_uuid_key, last_error_code, last_error_message, created_at`;

const STMT = {
	enqueue: `INSERT INTO jobs (
		organization_id, task_id, type, payload, status, attempts,
		max_attempts, not_before, enqueue_uuid_key, created_at
	) VALUES (
		$1, $2, $3, $4::jsonb, 'pending', 0, $5, COALESCE($6::timestamptz, now()), $7, now()
	)
	ON CONFLICT (organization_id, enqueue_uuid_key) DO NOTHING
	RETURNING ${JOB_COLUMNS}`,
	selectByEnqueueKey: `SELECT ${JOB_COLUMNS} FROM jobs
		WHERE organization_id = $1 AND enqueue_uuid_key = $2`,
	// Atomic claim: SKIP LOCKED so concurrent workers never collide, counters
	// owned by the DB, lease assigned in the same statement as the claim.
	claimNext: `UPDATE jobs SET
			status = 'claimed',
			lease_owner_id = $1,
			lease_expires_at = now() + make_interval(secs => $2::int),
			attempts = attempts + 1
		WHERE id = (
			SELECT id FROM jobs
			WHERE (status = 'pending' AND not_before <= now())
			   OR (status = 'claimed' AND lease_expires_at < now())
			ORDER BY created_at ASC
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING ${JOB_COLUMNS}`,
	heartbeat: `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3::int)
		WHERE id = $1 AND status = 'claimed' AND lease_owner_id = $2
		RETURNING id, status`,
	ackComplete: `UPDATE jobs SET
			status = 'done',
			lease_owner_id = NULL,
			lease_expires_at = NULL
		WHERE id = $1 AND status = 'claimed' AND lease_owner_id = $2
		RETURNING id`,
	// Retry/dead-letter decided by the DB-side counters; no caller input.
	ackFail: `UPDATE jobs SET
			status = CASE WHEN attempts >= max_attempts
				THEN 'dead_letter' ELSE 'pending' END,
			last_error_code = $3,
			last_error_message = $4,
			lease_owner_id = NULL,
			lease_expires_at = NULL,
			not_before = CASE WHEN attempts >= max_attempts
				THEN not_before
				ELSE now() + make_interval(secs => LEAST(2 ^ attempts, 300)::int) END
		WHERE id = $1 AND status = 'claimed' AND lease_owner_id = $2
		RETURNING attempts, max_attempts, (status <> 'dead_letter') AS requeued`,
	requeueExpiredLeases: `UPDATE jobs SET
			status = 'pending',
			lease_owner_id = NULL,
			lease_expires_at = NULL
		WHERE status = 'claimed'
		  AND lease_expires_at <= to_timestamp($1::double precision / 1000.0)
		RETURNING id`,
} as const;

export class PostgresQueueRepository implements QueueRepository {
	constructor(private readonly sql: PgSql) {}

	async enqueue(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		type: JobType;
		payload: Record<string, unknown>;
		idempotencyKey: string;
		maxAttempts: number;
		notBefore?: string;
	}): Promise<JobRow> {
		if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer");
		}
		const inserted = (await this.sql.unsafe(STMT.enqueue, [
			input.organizationId,
			input.taskId,
			input.type,
			JSON.stringify(input.payload),
			input.maxAttempts,
			input.notBefore ?? null,
			input.idempotencyKey,
		])) as unknown as Record<string, unknown>[];
		if (inserted.length > 0) {
			return mapJobRow(inserted[0]);
		}
		// Enqueue-key conflict: idempotent enqueue returns the existing job.
		const existing = (await this.sql.unsafe(STMT.selectByEnqueueKey, [
			input.organizationId,
			input.idempotencyKey,
		])) as unknown as Record<string, unknown>[];
		if (existing.length === 0) {
			throw new Error("enqueue returned no row and no enqueue-key hit");
		}
		return mapJobRow(existing[0]);
	}

	async claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
	}): Promise<JobRow | null> {
		if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
			throw new Error("ownerId must be a non-empty string");
		}
		if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
			throw new Error("leaseSeconds must be a positive integer");
		}
		const rows = (await this.sql.unsafe(STMT.claimNext, [
			input.ownerId,
			input.leaseSeconds,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapJobRow(rows[0]);
	}

	async heartbeat(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean> {
		const result = await this.heartbeatResult(jobId, ownerId, extendSeconds);
		return result.ok;
	}

	async heartbeatResult(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
		if (!Number.isInteger(extendSeconds) || extendSeconds < 1) {
			throw new Error("extendSeconds must be a positive integer");
		}
		const rows = (await this.sql.unsafe(STMT.heartbeat, [
			jobId,
			ownerId,
			extendSeconds,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			return classifyOwnershipFailure(this.sql, jobId, ownerId);
		}
		return { ok: true };
	}

	async ackComplete(
		jobId: JobId,
		ownerId: string,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
		const rows = (await this.sql.unsafe(STMT.ackComplete, [
			jobId,
			ownerId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			return classifyOwnershipFailure(this.sql, jobId, ownerId);
		}
		return { ok: true };
	}

	async ackFail(input: {
		jobId: JobId;
		ownerId: string;
		code: string;
		message: string;
	}): Promise<
		| { ok: true; requeued: boolean }
		| { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }
	> {
		// The message must be sanitised upstream; this layer only truncates to
		// the column's CHECK bound so the write cannot fail on length.
		const message =
			input.message.length > 4000
				? input.message.slice(0, 4000)
				: input.message;
		const rows = (await this.sql.unsafe(STMT.ackFail, [
			input.jobId,
			input.ownerId,
			input.code,
			message,
		])) as unknown as Array<Record<string, unknown>>;
		if (rows.length === 0) {
			return classifyOwnershipFailure(this.sql, input.jobId, input.ownerId);
		}
		return { ok: true, requeued: rows[0].requeued === true };
	}

	async requeueExpiredLeases(nowMs: number): Promise<number> {
		if (!Number.isFinite(nowMs)) {
			throw new Error("nowMs must be a finite epoch-milliseconds value");
		}
		const rows = (await this.sql.unsafe(STMT.requeueExpiredLeases, [
			nowMs,
		])) as unknown as Record<string, unknown>[];
		return rows.length;
	}
}

/**
 * Distinguishes NOT_FOUND (no such job, or job no longer in a claimable
 * lifecycle state) from LEASE_LOST (job exists but a different worker holds
 * the lease). Two statement paths; the failure path is not hot.
 */
async function classifyOwnershipFailure(
	sql: PgSql,
	jobId: JobId,
	ownerId: string,
): Promise<{ ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
	const rows = (await sql.unsafe(
		`SELECT lease_owner_id, status FROM jobs WHERE id = $1`,
		[jobId],
	)) as unknown as Array<Record<string, unknown>>;
	if (
		rows.length === 0 ||
		rows[0].status !== "claimed" ||
		rows[0].lease_owner_id === null
	) {
		return { ok: false, code: "NOT_FOUND" };
	}
	if (rows[0].lease_owner_id !== ownerId) {
		return { ok: false, code: "LEASE_LOST" };
	}
	// Job is claimed but still (momentarily) owned by us: the mutating UPDATE
	// lost the race — treat as lease lost.
	return { ok: false, code: "LEASE_LOST" };
}

type JobDbRow = {
	id: string;
	organization_id: string;
	task_id: string;
	type: string;
	payload: Record<string, unknown> | string;
	status: string;
	attempts: number;
	max_attempts: number;
	lease_owner_id: string | null;
	lease_expires_at: Date | string | null;
	not_before: Date | string;
	enqueue_uuid_key: string;
	last_error_code: string | null;
	last_error_message: string | null;
	created_at: Date | string;
};

function mapJobRow(row: Record<string, unknown>): JobRow {
	const job = row as unknown as JobDbRow;
	return {
		id: job.id as JobRow["id"],
		organizationId: job.organization_id as JobRow["organizationId"],
		taskId: job.task_id as JobRow["taskId"],
		type: job.type as JobType,
		payload: job.payload as Record<string, unknown>,
		status: job.status as JobRow["status"],
		attempts: job.attempts,
		maxAttempts: job.max_attempts,
		lease:
			job.lease_owner_id !== null && job.lease_expires_at !== null
				? {
						ownerId: job.lease_owner_id,
						leaseExpiresAt: toIso(job.lease_expires_at),
					}
				: null,
		notBefore: toIso(job.not_before),
		enqueueUuidKey: job.enqueue_uuid_key,
		lastError:
			job.last_error_code !== null
				? {
						code: job.last_error_code,
						message: job.last_error_message ?? "",
					}
				: null,
		createdAt: toIso(job.created_at),
	};
}

function toIso(value: Date | string): string {
	return typeof value === "string" ? value : value.toISOString();
}
