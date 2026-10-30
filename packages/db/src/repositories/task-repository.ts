import {
	type AcceptanceCheck,
	acceptanceCheckSchema,
	canTransition,
	type OrganizationId,
	TASK_STATE_TRANSITIONS,
	TASK_STATUSES,
	type TaskId,
	type TaskStatus,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { TaskRow, TaskStatusDb } from "../schema";

/**
 * Postgres (Neon) implementation of the task lifecycle store.
 *
 * Safety model:
 * - Statements are static string constants with `$n` placeholders; caller
 *   values are always passed as bound parameters to `sql.unsafe(statement,
 *   params)` and are never interpolated into SQL text.
 * - The state-machine guard is enforced twice: once in TypeScript (fast typed
 *   failure) and once in SQL via a static `(from, to)` VALUES fragment built
 *   from the frozen TASK_STATE_TRANSITIONS map, guarded by the optimistic
 *   `expectedStatus` check. A racing writer can therefore never land an
 *   illegal state.
 */

const STATUS_TOKENS = new Set<string>(TASK_STATUSES);

/**
 * Builds the static SQL fragment encoding every legal (from, to) pair.
 * Tokens come from the frozen shared map only and are validated against
 * TASK_STATUSES, so the fragment can never carry arbitrary SQL.
 */
export function buildTransitionValuesSql(
	transitions: Readonly<
		Record<TaskStatus, readonly TaskStatus[]>
	> = TASK_STATE_TRANSITIONS,
): string {
	for (const [from, tos] of Object.entries(transitions)) {
		if (!STATUS_TOKENS.has(from)) {
			throw new Error(`transition source is not a known status: ${from}`);
		}
		for (const to of tos) {
			if (!STATUS_TOKENS.has(to)) {
				throw new Error(`transition target is not a known status: ${to}`);
			}
		}
	}
	return Object.entries(transitions)
		.flatMap(([from, tos]) => tos.map((to) => `('${from}','${to}')`))
		.join(", ");
}

/** Static `(from, to)` VALUES fragment used by the SQL transition guard. */
export const TASK_TRANSITION_VALUES_SQL = buildTransitionValuesSql();

const TASK_COLUMNS =
	"id, organization_id, repository_id, worktree, branch, status, idempotency_key, budget_limits, goal, acceptance_criteria, acceptance_checks, file_ownership, pull_request_number, pull_request_url, retry_of, retry_depth, created_by, created_at, updated_at";

/** Hard retry ceiling mirrored by the 0006 `retry_depth` CHECK (0..3). */
export const MAX_RETRY_DEPTH = 3;

/** Check-list bound mirrored by the 0007 `tasks_acceptance_checks_array_check`. */
export const MAX_ACCEPTANCE_CHECKS = 32;

/** Practical git ref-name bound; a derived retry branch is clamped to it. */
export const MAX_RETRY_BRANCH_LENGTH = 255;

/**
 * Derives the retry task's idempotency key from the caller's key. The source
 * id is part of the derivation, so replaying the same request returns the same
 * retry row while two different sources can never collide.
 */
export function buildRetryIdempotencyKey(
	failedTaskId: TaskId,
	idempotencyKey: string,
): string {
	return `retry:${failedTaskId}:${idempotencyKey}`;
}

/** Deterministic branch for a retry: `<source branch>-retry-<depth>`, clamped. */
export function deriveRetryBranch(
	sourceBranch: string,
	retryDepth: number,
): string {
	const suffix = `-retry-${retryDepth}`;
	const maxBase = Math.max(1, MAX_RETRY_BRANCH_LENGTH - suffix.length);
	const base =
		sourceBranch.length > maxBase
			? sourceBranch.slice(0, maxBase)
			: sourceBranch;
	return `${base}${suffix}`;
}

/**
 * Statements. Plain string literals — no template interpolation anywhere
 * except frozen numeric constants (`MAX_RETRY_DEPTH`).
 */
const STMT = {
	insert: `INSERT INTO tasks (
		id, organization_id, repository_id, worktree, branch, status,
		idempotency_key, budget_limits, goal, acceptance_criteria,
		acceptance_checks, file_ownership, created_by, created_at, updated_at
	) VALUES (
		gen_random_uuid(), $1, $2, $3, $3, 'queued', $4, $5::text::jsonb,
		$6, $7::text::jsonb, $8::text::jsonb, $9::text::jsonb, $10, now(), now()
	)
	ON CONFLICT (organization_id, idempotency_key) DO NOTHING
	RETURNING ${TASK_COLUMNS}`,
	// One statement expresses the whole retry decision: the source must be in
	// THIS organization, still `failed`, and below the depth ceiling. The new
	// row copies the boundary columns from the source; budget is the original
	// cap, never enlarged. jsonb columns move column-to-column (no re-encoding).
	insertRetry: `INSERT INTO tasks (
		id, organization_id, repository_id, worktree, branch, status,
		idempotency_key, budget_limits, goal, acceptance_criteria,
		acceptance_checks, file_ownership, created_by, retry_of, retry_depth,
		created_at, updated_at
	)
	SELECT gen_random_uuid(), t.organization_id, t.repository_id, $4, $4,
		'queued', $3, t.budget_limits, t.goal, t.acceptance_criteria,
		t.acceptance_checks, t.file_ownership, t.created_by, t.id,
		t.retry_depth + 1, now(), now()
	FROM tasks t
	WHERE t.id = $1 AND t.organization_id = $2
	  AND t.status = 'failed' AND t.retry_depth < ${MAX_RETRY_DEPTH}
	ON CONFLICT (organization_id, idempotency_key) DO NOTHING
	RETURNING ${TASK_COLUMNS}`,
	get: `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
	getByIdempotencyKey: `SELECT ${TASK_COLUMNS} FROM tasks
		WHERE organization_id = $1 AND idempotency_key = $2`,
	recordPullRequest: `UPDATE tasks
		SET pull_request_number = $3, pull_request_url = $4, updated_at = now()
		WHERE id = $1 AND organization_id = $2
		RETURNING ${TASK_COLUMNS}`,
	listByStatus: `SELECT ${TASK_COLUMNS} FROM tasks
		WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
	// Guard is fully server-side: status must equal the caller's expected
	// status AND the pair (current, target) must be a declared transition.
	transition: `UPDATE tasks SET status = $2, updated_at = now()
		WHERE id = $1 AND status = $3
		  AND (status, $2) IN (VALUES ${TASK_TRANSITION_VALUES_SQL})
		RETURNING ${TASK_COLUMNS}`,
	listExpiredOverBudget: `SELECT ${TASK_COLUMNS} FROM tasks
		WHERE status NOT IN ('completed', 'failed', 'cancelled', 'blocked')
		  AND now() > created_at
			  + (budget_limits->>'max_duration_ms')::double precision * interval '1 millisecond'
		ORDER BY created_at ASC
		LIMIT 100`,
} as const;

export type TaskTransitionFailureCode =
	| "NOT_FOUND"
	| "INVALID_TRANSITION"
	| "CONFLICT";

/**
 * Retry refusal codes reuse the platform vocabulary: `NOT_FOUND` for a
 * foreign/absent source, `CONFLICT` for a source that is not `failed`, and
 * `POLICY_DENIED` (a `PlatformError` code) for a source already at depth 3.
 */
export type TaskRetryFailureCode = "NOT_FOUND" | "CONFLICT" | "POLICY_DENIED";

export type TaskRetryInput = {
	organizationId: OrganizationId;
	failedTaskId: TaskId;
	/** Caller-supplied key; the stored key is derived from it (replay-stable). */
	idempotencyKey: string;
	/** Overrides the derived `<source branch>-retry-<depth>` branch. */
	branch?: string;
};

export type TaskRetryResult =
	| {
			ok: true;
			task: TaskRow;
			/** false when the derived idempotency key hit an existing retry. */
			created: boolean;
	  }
	| { ok: false; code: TaskRetryFailureCode };

/**
 * Contract for the task lifecycle store. Declared in this module (not
 * imported from anywhere) so implementations and test fakes share one
 * in-scope symbol.
 */
export interface TaskRepository {
	create(input: {
		organizationId: OrganizationId;
		repositoryId: string;
		branch: string;
		idempotencyKey: string;
		budgetLimits: {
			maxAgentTurns: number;
			maxRepairAttempts: number;
			maxDurationMs: number;
		};
		/** Task intent persisted for the worker's context loader. */
		goal?: string;
		acceptanceCriteria?: string[];
		/**
		 * Machine-checkable completion criteria (wave 9). Validated with
		 * `acceptanceCheckSchema` and bounded to `MAX_ACCEPTANCE_CHECKS`.
		 */
		acceptanceChecks?: AcceptanceCheck[];
		fileOwnership?: string[];
		createdBy: string;
	}): Promise<TaskRow>;
	get(taskId: TaskId): Promise<TaskRow | null>;
	getByIdempotencyKey(
		organizationId: OrganizationId,
		idempotencyKey: string,
	): Promise<TaskRow | null>;
	listByStatus(status: TaskStatus, limit: number): Promise<TaskRow[]>;
	transition(input: {
		taskId: TaskId;
		to: TaskStatus;
		expectedStatus: TaskStatus;
	}): Promise<
		{ ok: true; task: TaskRow } | { ok: false; code: TaskTransitionFailureCode }
	>;
	listExpiredOverBudget(): Promise<TaskRow[]>;
	/**
	 * Creates the rerun task for a `failed` source in the same boundary
	 * (organization, repository, goal, acceptance criteria, file ownership,
	 * budget caps). `failed` stays terminal: this inserts a NEW row.
	 */
	createRetry(input: TaskRetryInput): Promise<TaskRetryResult>;
	/**
	 * Persists the created pull request on the task. Returns null when the task
	 * is absent or belongs to another organization (no cross-tenant write).
	 */
	recordPullRequest(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		pullRequestNumber: number;
		pullRequestUrl: string;
	}): Promise<TaskRow | null>;
}

/** Pure transition guard used by the driver path and by contract-test fakes. */
export function guardTransition(
	expectedStatus: TaskStatus,
	current: TaskStatus,
	to: TaskStatus,
): { ok: true } | { ok: false; code: TaskTransitionFailureCode } {
	if (current !== expectedStatus) {
		return { ok: false, code: "CONFLICT" };
	}
	if (!canTransition(current, to)) {
		return { ok: false, code: "INVALID_TRANSITION" };
	}
	return { ok: true };
}

/**
 * Pure retry eligibility gate shared by the driver and the in-memory fake.
 * Order matters and is stable: NOT_FOUND (foreign/absent) wins over CONFLICT
 * (source not failed), which wins over POLICY_DENIED (depth exhausted).
 */
export function evaluateRetryEligibility(input: {
	sourceFound: boolean;
	sameOrganization: boolean;
	sourceStatus: TaskStatus | null;
	sourceRetryDepth: number | null;
}): { ok: true } | { ok: false; code: TaskRetryFailureCode } {
	if (
		!input.sourceFound ||
		!input.sameOrganization ||
		input.sourceStatus === null
	) {
		return { ok: false, code: "NOT_FOUND" };
	}
	if (input.sourceStatus !== "failed") {
		return { ok: false, code: "CONFLICT" };
	}
	if ((input.sourceRetryDepth ?? 0) >= MAX_RETRY_DEPTH) {
		return { ok: false, code: "POLICY_DENIED" };
	}
	return { ok: true };
}

export class PostgresTaskRepository implements TaskRepository {
	constructor(private readonly sql: PgSql) {}

	async create(input: {
		organizationId: OrganizationId;
		repositoryId: string;
		branch: string;
		idempotencyKey: string;
		budgetLimits: {
			maxAgentTurns: number;
			maxRepairAttempts: number;
			maxDurationMs: number;
		};
		goal?: string;
		acceptanceCriteria?: string[];
		acceptanceChecks?: AcceptanceCheck[];
		fileOwnership?: string[];
		createdBy: string;
	}): Promise<TaskRow> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.repositoryId, "repositoryId");
		requireNonEmpty(input.branch, "branch");
		requireNonEmpty(input.idempotencyKey, "idempotencyKey");
		requireNonEmpty(input.createdBy, "createdBy");
		requirePositiveInt(input.budgetLimits.maxAgentTurns, "maxAgentTurns");
		requireNonNegativeInt(
			input.budgetLimits.maxRepairAttempts,
			"maxRepairAttempts",
		);
		requirePositiveInt(input.budgetLimits.maxDurationMs, "maxDurationMs");
		const goal = input.goal ?? "";
		if (typeof goal !== "string") {
			throw new Error("goal must be a string");
		}
		const acceptanceCriteria = requireStringArray(
			input.acceptanceCriteria ?? [],
			"acceptanceCriteria",
		);
		// Zod boundary + 32-entry cap: the same helper backs the in-memory fake,
		// so driver and fake reject identical inputs.
		const acceptanceChecks = validateAcceptanceChecks(
			input.acceptanceChecks ?? [],
		);
		const fileOwnership = requireStringArray(
			input.fileOwnership ?? [],
			"fileOwnership",
		);

		// Row JSON keys are snake_case (mirrors the DB jsonb contract and the
		// budget->>'max_duration_ms' scan); the TS-facing input is camelCase.
		const budgetLimits = {
			max_agent_turns: input.budgetLimits.maxAgentTurns,
			max_repair_attempts: input.budgetLimits.maxRepairAttempts,
			max_duration_ms: input.budgetLimits.maxDurationMs,
		};

		const inserted = await this.sql.unsafe(STMT.insert, [
			input.organizationId,
			input.repositoryId,
			input.branch,
			input.idempotencyKey,
			JSON.stringify(budgetLimits),
			goal,
			JSON.stringify(acceptanceCriteria),
			JSON.stringify(acceptanceChecks),
			JSON.stringify(fileOwnership),
			input.createdBy,
		]);
		const insertedRows = inserted as unknown as Record<string, unknown>[];
		if (insertedRows.length > 0) {
			return mapTaskRow(insertedRows[0]);
		}
		// Idempotency-key hit: return the pre-existing row.
		const existing = await this.sql.unsafe(STMT.getByIdempotencyKey, [
			input.organizationId,
			input.idempotencyKey,
		]);
		const existingRows = existing as unknown as Record<string, unknown>[];
		if (existingRows.length === 0) {
			throw new Error("task insert returned no row and no idempotency hit");
		}
		return mapTaskRow(existingRows[0]);
	}

	async get(taskId: TaskId): Promise<TaskRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			taskId,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapTaskRow(rows[0]);
	}

	async getByIdempotencyKey(
		organizationId: OrganizationId,
		idempotencyKey: string,
	): Promise<TaskRow | null> {
		const rows = (await this.sql.unsafe(STMT.getByIdempotencyKey, [
			organizationId,
			idempotencyKey,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapTaskRow(rows[0]);
	}

	async listByStatus(status: TaskStatus, limit: number): Promise<TaskRow[]> {
		// Bounded page size; negative/NaN collapse to 1.
		const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
		const rows = (await this.sql.unsafe(STMT.listByStatus, [
			status,
			clamped,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapTaskRow);
	}

	async transition(input: {
		taskId: TaskId;
		to: TaskStatus;
		expectedStatus: TaskStatus;
	}): Promise<
		{ ok: true; task: TaskRow } | { ok: false; code: TaskTransitionFailureCode }
	> {
		const rows = (await this.sql.unsafe(STMT.transition, [
			input.taskId,
			input.to,
			input.expectedStatus,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) {
			return { ok: true, task: mapTaskRow(rows[0]) };
		}
		// Disambiguate the failure using the REAL current status — never the
		// caller's expectedStatus. (A fast guard keyed on expectedStatus alone
		// classified stale-expectation calls as INVALID_TRANSITION, violating the
		// "CONFLICT wins" ordering that guardTransition/fakes encode.)
		const currentRows = (await this.sql.unsafe(STMT.get, [
			input.taskId,
		])) as unknown as Record<string, unknown>[];
		if (currentRows.length === 0) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const guard = guardTransition(
			input.expectedStatus,
			mapTaskRow(currentRows[0]).status,
			input.to,
		);
		if (!guard.ok) {
			return guard;
		}
		// Status changed between the UPDATE and this read (lost race).
		return { ok: false, code: "CONFLICT" };
	}

	async recordPullRequest(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		pullRequestNumber: number;
		pullRequestUrl: string;
	}): Promise<TaskRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requirePositiveInt(input.pullRequestNumber, "pullRequestNumber");
		requireNonEmpty(input.pullRequestUrl, "pullRequestUrl");
		if (input.pullRequestUrl.length > 512) {
			throw new Error("pullRequestUrl must be at most 512 characters");
		}
		const rows = (await this.sql.unsafe(STMT.recordPullRequest, [
			input.taskId,
			input.organizationId,
			input.pullRequestNumber,
			input.pullRequestUrl,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapTaskRow(rows[0]);
	}

	async listExpiredOverBudget(): Promise<TaskRow[]> {
		// "Expired over budget" means wall-clock lifetime: created_at plus the
		// task's max_duration_ms has passed while status is non-terminal.
		const rows = (await this.sql.unsafe(
			STMT.listExpiredOverBudget,
		)) as unknown as Record<string, unknown>[];
		return rows.map(mapTaskRow);
	}

	async createRetry(input: TaskRetryInput): Promise<TaskRetryResult> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.failedTaskId, "failedTaskId");
		requireNonEmpty(input.idempotencyKey, "idempotencyKey");
		if (input.idempotencyKey.length > 200) {
			throw new Error("idempotencyKey must be at most 200 characters");
		}
		if (input.branch !== undefined) {
			requireNonEmpty(input.branch, "branch");
		}
		const idempotencyKey = buildRetryIdempotencyKey(
			input.failedTaskId,
			input.idempotencyKey,
		);

		// Fast refusal path: classify from a tenant-scoped read so the caller
		// gets NOT_FOUND / CONFLICT / POLICY_DENIED instead of a silent no-op.
		const source = await this.get(input.failedTaskId);
		const eligibility = evaluateRetryEligibility({
			sourceFound: source !== null,
			sameOrganization: source?.organization_id === input.organizationId,
			sourceStatus: source?.status ?? null,
			sourceRetryDepth: source?.retry_depth ?? null,
		});
		if (!eligibility.ok) {
			return eligibility;
		}
		if (source === null) {
			return { ok: false, code: "NOT_FOUND" };
		}

		const branch =
			input.branch ?? deriveRetryBranch(source.branch, source.retry_depth + 1);
		// The INSERT ... SELECT re-checks org/failed/depth, so a status change
		// between the read above and this statement can never create a retry
		// of a non-failed task.
		const inserted = (await this.sql.unsafe(STMT.insertRetry, [
			input.failedTaskId,
			input.organizationId,
			idempotencyKey,
			branch,
		])) as unknown as Record<string, unknown>[];
		if (inserted.length > 0) {
			return { ok: true, task: mapTaskRow(inserted[0]), created: true };
		}
		// Replay: the derived key already exists in this organization.
		const replay = (await this.sql.unsafe(STMT.getByIdempotencyKey, [
			input.organizationId,
			idempotencyKey,
		])) as unknown as Record<string, unknown>[];
		if (replay.length > 0) {
			return { ok: true, task: mapTaskRow(replay[0]), created: false };
		}
		// The source changed between the read and the INSERT (lost race).
		return { ok: false, code: "CONFLICT" };
	}
}

type Row = Record<string, unknown>;

function mapTaskRow(row: Row): TaskRow {
	return {
		id: row.id as TaskRow["id"],
		organization_id: row.organization_id as TaskRow["organization_id"],
		repository_id: row.repository_id as TaskRow["repository_id"],
		worktree: row.worktree as string,
		branch: row.branch as string,
		status: row.status as TaskStatusDb,
		idempotency_key: row.idempotency_key as string,
		budget_limits: parseJsonbColumn<TaskRow["budget_limits"]>(
			row.budget_limits,
		) as TaskRow["budget_limits"],
		goal: row.goal as string,
		acceptance_criteria: parseJsonbColumn<TaskRow["acceptance_criteria"]>(
			row.acceptance_criteria,
		) as TaskRow["acceptance_criteria"],
		// Re-validated on read: the DB CHECK only proves "array of <= 32", so a
		// hand-written row with an invalid entry must not cross the row boundary.
		acceptance_checks: validateAcceptanceChecks(
			parseJsonbColumn<unknown>(row.acceptance_checks) ?? [],
		),
		file_ownership: parseJsonbColumn<TaskRow["file_ownership"]>(
			row.file_ownership,
		) as TaskRow["file_ownership"],
		pull_request_number: (row.pull_request_number ??
			null) as TaskRow["pull_request_number"],
		pull_request_url: (row.pull_request_url ??
			null) as TaskRow["pull_request_url"],
		retry_of: (row.retry_of ?? null) as TaskRow["retry_of"],
		retry_depth: Number(row.retry_depth ?? 0),
		created_by: row.created_by as TaskRow["created_by"],
		created_at: row.created_at as Date,
		updated_at: row.updated_at as Date,
	};
}

export function requireNonEmpty(value: string, field: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
}

export function requirePositiveInt(value: number, field: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
}

export function requireNonNegativeInt(value: number, field: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
}

/** Bounded string list; empty entries are a caller bug, not a silent filter. */
export function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array of strings`);
	}
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`${field} must contain non-empty strings`);
		}
	}
	return [...(value as string[])];
}

/**
 * Validates and bounds the machine-checkable acceptance list (wave 9).
 * Shared by the Postgres driver and the in-memory fake so both reject the
 * same inputs: non-arrays, more than `MAX_ACCEPTANCE_CHECKS` entries, and
 * entries that violate `acceptanceCheckSchema` (strict, path-confined).
 * Error messages name the index and the zod issue, never the value.
 */
export function validateAcceptanceChecks(
	value: unknown,
	field = "acceptanceChecks",
): AcceptanceCheck[] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array of acceptance checks`);
	}
	if (value.length > MAX_ACCEPTANCE_CHECKS) {
		throw new Error(
			`${field} must contain at most ${MAX_ACCEPTANCE_CHECKS} checks`,
		);
	}
	return value.map((entry, index) => {
		const parsed = acceptanceCheckSchema.safeParse(entry);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.slice(0, 3)
				.map((issue) => issue.message)
				.join("; ");
			throw new Error(
				`${field}[${index}] is not a valid acceptance check: ${reason}`,
			);
		}
		return parsed.data;
	});
}
