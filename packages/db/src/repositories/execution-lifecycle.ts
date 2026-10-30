import {
	type ExecutionLifecycle,
	type LifecycleApprovalInput,
	type LifecycleApprovalState,
	type LifecycleApprovalStatus,
	type LifecycleArtifactInput,
	type LifecycleEventInput,
	type LifecycleTransitionInput,
	type OrganizationId,
	TASK_STATUSES,
	type TaskId,
	type TaskStatus,
} from "@isolate/shared";
import type { PgSql } from "../client";
import type { ApprovalStatus } from "../schema";
import {
	type ArtifactRepository,
	isSha256Hex,
	MAX_INLINE_ARTIFACT_BYTES,
	PostgresArtifactRepository,
} from "./artifact-repository";
import {
	PostgresTaskAttemptRepository,
	type TaskAttemptRepository,
} from "./task-attempt-repository";
import {
	guardTransition,
	requireNonEmpty,
	TASK_TRANSITION_VALUES_SQL,
} from "./task-repository";

/**
 * Postgres implementation of the wave-7 execution lifecycle.
 *
 * This is the durable sink for "what the worker did": transitions, append-only
 * events, attempts, bounded artifacts and the approval gate. It deliberately
 * does NOT re-implement the state machine: legality comes from
 * `guardTransition` / `TASK_TRANSITION_VALUES_SQL` (the same helpers the task
 * repository and its fake use).
 *
 * Tenant model: every method carries `organizationId`; transition/event/
 * artifact/attempt/approval writes are single statements that select from or
 * join `tasks` under that organization, so a foreign task can never be
 * mutated even if its id leaks into a job payload.
 */

export type LifecycleErrorCode =
	| "NOT_FOUND"
	| "CONFLICT"
	| "INVALID_TRANSITION"
	| "INVALID_INPUT";

export class LifecycleError extends Error {
	override readonly name = "LifecycleError";
	readonly code: LifecycleErrorCode;

	constructor(code: LifecycleErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function isLifecycleError(value: unknown): value is LifecycleError {
	return value instanceof LifecycleError;
}

const STATUS_TOKENS = new Set<string>(TASK_STATUSES);

const STMT = {
	// Optimistic, tenant-scoped, and state-machine guarded in one statement.
	transition: `UPDATE tasks SET status = $2, updated_at = now()
		WHERE id = $1 AND organization_id = $3 AND status = $4
		  AND (status, $2) IN (VALUES ${TASK_TRANSITION_VALUES_SQL})
		RETURNING id`,
	taskStatus: `SELECT status FROM tasks
		WHERE id = $1 AND organization_id = $2
		LIMIT 1`,
	insertEvent: `INSERT INTO run_events (
		task_id, workflow_run_id, type, actor, data, occurred_at
	)
	SELECT t.id, $3::uuid, $4, $5, $6::text::jsonb, now()
	FROM tasks t
	WHERE t.id = $2 AND t.organization_id = $1
	RETURNING id`,
	finishAttempt: `UPDATE task_attempts a
		SET finished_at = now(), outcome = $3::text::jsonb
		FROM tasks t
		WHERE a.id = $1 AND a.task_id = $4
		  AND a.task_id = t.id AND t.organization_id = $2
		RETURNING a.id`,
	// Partial unique index `(task_id, action) WHERE status = 'pending'` makes a
	// duplicate pending request a no-op; the caller then reads the existing id.
	insertApproval: `INSERT INTO approvals (
		organization_id, task_id, workflow_run_id, action, payload_sha256,
		status, requested_by, expires_at
	)
	SELECT $1, t.id, $3::uuid, $4, $5, 'pending', $6, $7::timestamptz
	FROM tasks t
	WHERE t.id = $2 AND t.organization_id = $1
	ON CONFLICT (task_id, action) WHERE status = 'pending' DO NOTHING
	RETURNING id`,
	getPendingApproval: `SELECT a.id FROM approvals a
		JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
		WHERE a.organization_id = $1 AND a.task_id = $2 AND a.action = $3
		  AND a.status = 'pending'
		LIMIT 1`,
	// Read path is tenant-scoped twice: the row carries the organization and the
	// task must still belong to it.
	getApproval: `SELECT a.status, a.payload_sha256, a.expires_at
		FROM approvals a
		JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
		WHERE a.id = $1 AND a.organization_id = $2 AND a.task_id = $3
		LIMIT 1`,
} as const;

/**
 * Pure approval status projection shared by the Postgres read path and the
 * in-memory fake. A pending/approved row whose `expires_at` has passed is
 * reported as `expired`, so the worker's resume check cannot accept a stale
 * approval merely because nobody ran the expiry sweeper.
 */
export function evaluateLifecycleApprovalStatus(input: {
	readonly status: ApprovalStatus;
	readonly expiresAtMs: number;
	readonly nowMs: number;
}): LifecycleApprovalStatus {
	if (
		(input.status === "pending" || input.status === "approved") &&
		input.expiresAtMs <= input.nowMs
	) {
		return "expired";
	}
	return input.status;
}

export type PostgresExecutionLifecycleOptions = {
	/** Optional overrides for tests/composition; defaults bind to `sql`. */
	readonly artifacts?: ArtifactRepository;
	readonly attempts?: TaskAttemptRepository;
	readonly clock?: () => Date;
};

export class PostgresExecutionLifecycle implements ExecutionLifecycle {
	private readonly artifacts: ArtifactRepository;
	private readonly attempts: TaskAttemptRepository;
	private readonly clock: () => Date;

	constructor(
		private readonly sql: PgSql,
		options: PostgresExecutionLifecycleOptions = {},
	) {
		this.artifacts = options.artifacts ?? new PostgresArtifactRepository(sql);
		this.attempts = options.attempts ?? new PostgresTaskAttemptRepository(sql);
		this.clock = options.clock ?? (() => new Date());
	}

	async transition(input: LifecycleTransitionInput): Promise<void> {
		validateTransitionInput(input);
		const rows = (await this.sql.unsafe(STMT.transition, [
			input.taskId,
			input.to,
			input.organizationId,
			input.from,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) return;

		// Disambiguate against the REAL current status, never the caller's
		// expectation: a stale `from` is CONFLICT even if the pair is also illegal.
		const current = (await this.sql.unsafe(STMT.taskStatus, [
			input.taskId,
			input.organizationId,
		])) as unknown as Record<string, unknown>[];
		if (current.length === 0) {
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
		const guard = guardTransition(
			input.from,
			current[0].status as TaskStatus,
			input.to,
		);
		if (!guard.ok) {
			throw new LifecycleError(
				guard.code,
				guard.code === "CONFLICT"
					? "task status changed since it was read"
					: "transition is not allowed by TASK_STATE_TRANSITIONS",
			);
		}
		// The row passed the guard but the UPDATE saw no match: lost race.
		throw new LifecycleError("CONFLICT", "task status changed concurrently");
	}

	async event(input: LifecycleEventInput): Promise<void> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.type, "type");
		requireNonEmpty(input.actor, "actor");
		const rows = (await this.sql.unsafe(STMT.insertEvent, [
			input.organizationId,
			input.taskId,
			input.workflowRunId,
			input.type,
			input.actor,
			JSON.stringify(input.data ?? {}),
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
	}

	async artifact(
		input: LifecycleArtifactInput,
	): Promise<{ readonly artifactId: string }> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.kind, "kind");
		requireNonEmpty(input.contentType, "contentType");
		if (!isSha256Hex(input.sha256)) {
			throw new LifecycleError(
				"INVALID_INPUT",
				"sha256 must be a 64-char lowercase hex digest",
			);
		}
		// The repository rejects oversize content BEFORE the INSERT (256 KiB of
		// UTF-8 bytes); this method maps that typed outcome to a lifecycle error.
		const result = await this.artifacts.create({
			organizationId: input.organizationId,
			taskId: input.taskId,
			kind: input.kind,
			contentType: input.contentType,
			content: input.content,
			sha256: input.sha256,
		});
		if (!result.ok) {
			if (result.code === "CONTENT_TOO_LARGE") {
				throw new LifecycleError(
					"INVALID_INPUT",
					`artifact content exceeds ${MAX_INLINE_ARTIFACT_BYTES} UTF-8 bytes`,
				);
			}
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
		return { artifactId: result.artifact.id };
	}

	async attemptStarted(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		workflowRunId: string | null;
	}): Promise<{ readonly attemptId: string; readonly attemptIndex: number }> {
		await this.requireTask(input.organizationId, input.taskId);
		// `begin` allocates MAX(attempt_index)+1 in one statement; the unique index
		// added by 0005 turns a concurrent allocation into one bounded retry.
		for (let tryIndex = 1; tryIndex <= 2; tryIndex += 1) {
			try {
				const row = await this.attempts.begin(
					input.taskId,
					input.workflowRunId,
				);
				return { attemptId: row.id, attemptIndex: row.attempt_index };
			} catch (error) {
				if (tryIndex === 1 && isUniqueViolation(error)) continue;
				throw error;
			}
		}
		throw new Error("unreachable attempt retry state");
	}

	async attemptFinished(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		attemptId: string;
		outcome: Readonly<Record<string, unknown>> | null;
	}): Promise<void> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.attemptId, "attemptId");
		const outcome =
			input.outcome === null ? null : JSON.stringify(input.outcome);
		const rows = (await this.sql.unsafe(STMT.finishAttempt, [
			input.attemptId,
			input.organizationId,
			outcome,
			input.taskId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new LifecycleError(
				"NOT_FOUND",
				"attempt not found for this task in this organization",
			);
		}
	}

	async approvalRequested(
		input: LifecycleApprovalInput,
	): Promise<{ readonly approvalId: string }> {
		const validated = validateLifecycleApprovalInput(input);
		const rows = (await this.sql.unsafe(STMT.insertApproval, [
			validated.organizationId,
			validated.taskId,
			validated.workflowRunId,
			validated.action,
			validated.payloadSha256,
			validated.requestedBy,
			validated.expiresAt,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) {
			return { approvalId: rows[0].id as string };
		}
		// Either the task is foreign/missing or a pending (taskId, action) row
		// already exists (the partial unique index suppressed the insert).
		const existing = (await this.sql.unsafe(STMT.getPendingApproval, [
			validated.organizationId,
			validated.taskId,
			validated.action,
		])) as unknown as Record<string, unknown>[];
		if (existing.length > 0) {
			return { approvalId: existing[0].id as string };
		}
		throw new LifecycleError(
			"NOT_FOUND",
			"task not found in this organization",
		);
	}

	async approvalStatus(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		approvalId: string;
	}): Promise<LifecycleApprovalState | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.approvalId, "approvalId");
		const rows = (await this.sql.unsafe(STMT.getApproval, [
			input.approvalId,
			input.organizationId,
			input.taskId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return null;
		const row = rows[0];
		return {
			status: evaluateLifecycleApprovalStatus({
				status: row.status as ApprovalStatus,
				expiresAtMs: toDate(row.expires_at).getTime(),
				nowMs: this.clock().getTime(),
			}),
			payloadSha256: row.payload_sha256 as string,
		};
	}

	async isCancelled(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<boolean> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		const rows = (await this.sql.unsafe(STMT.taskStatus, [
			input.taskId,
			input.organizationId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
		return rows[0].status === "cancelled";
	}

	private async requireTask(
		organizationId: OrganizationId,
		taskId: TaskId,
	): Promise<void> {
		requireNonEmpty(organizationId, "organizationId");
		requireNonEmpty(taskId, "taskId");
		const rows = (await this.sql.unsafe(STMT.taskStatus, [
			taskId,
			organizationId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new LifecycleError(
				"NOT_FOUND",
				"task not found in this organization",
			);
		}
	}
}

export function validateTransitionInput(input: LifecycleTransitionInput): void {
	requireNonEmpty(input.organizationId, "organizationId");
	requireNonEmpty(input.taskId, "taskId");
	if (!STATUS_TOKENS.has(input.from) || !STATUS_TOKENS.has(input.to)) {
		throw new LifecycleError("INVALID_INPUT", "unknown task status");
	}
}

export function validateLifecycleApprovalInput(input: LifecycleApprovalInput): {
	organizationId: OrganizationId;
	taskId: TaskId;
	workflowRunId: string | null;
	action: string;
	payloadSha256: string;
	requestedBy: string;
	expiresAt: Date;
} {
	requireNonEmpty(input.organizationId, "organizationId");
	requireNonEmpty(input.taskId, "taskId");
	requireNonEmpty(input.action, "action");
	requireNonEmpty(input.requestedBy, "requestedBy");
	if (input.action.length > 200) {
		throw new LifecycleError(
			"INVALID_INPUT",
			"action must be at most 200 characters",
		);
	}
	if (!isSha256Hex(input.payloadSha256)) {
		throw new LifecycleError(
			"INVALID_INPUT",
			"payloadSha256 must be a 64-char lowercase hex digest",
		);
	}
	if (
		!(input.expiresAt instanceof Date) ||
		Number.isNaN(input.expiresAt.getTime())
	) {
		throw new LifecycleError("INVALID_INPUT", "expiresAt must be a valid Date");
	}
	return {
		organizationId: input.organizationId,
		taskId: input.taskId,
		workflowRunId: input.workflowRunId,
		action: input.action,
		payloadSha256: input.payloadSha256,
		requestedBy: input.requestedBy,
		expiresAt: input.expiresAt,
	};
}

function toDate(value: unknown): Date {
	if (value instanceof Date) return value;
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	throw new Error("approval expires_at is not a valid timestamp");
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "23505"
	);
}
