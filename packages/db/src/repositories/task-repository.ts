import {
	canTransition,
	type OrganizationId,
	TASK_STATE_TRANSITIONS,
	TASK_STATUSES,
	type TaskId,
	type TaskStatus,
} from "@isolate/shared";
import type { PgSql } from "../client";
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
	"id, organization_id, repository_id, worktree, branch, status, idempotency_key, budget_limits, created_by, created_at, updated_at";

/**
 * Statements. Plain string literals — no template interpolation anywhere.
 * `$n` placeholders map positionally to the parameters bound at call time.
 */
const STMT = {
	insert: `INSERT INTO tasks (
		id, organization_id, repository_id, worktree, branch, status,
		idempotency_key, budget_limits, created_by, created_at, updated_at
	) VALUES (
		gen_random_uuid(), $1, $2, $3, $3, 'queued', $4, $5::jsonb, $6, now(), now()
	)
	ON CONFLICT (organization_id, idempotency_key) DO NOTHING
	RETURNING ${TASK_COLUMNS}`,
	get: `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`,
	getByIdempotencyKey: `SELECT ${TASK_COLUMNS} FROM tasks
		WHERE organization_id = $1 AND idempotency_key = $2`,
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
		// Fast typed rejection before touching the database.
		const guard = guardTransition(
			input.expectedStatus,
			input.expectedStatus,
			input.to,
		);
		if (!guard.ok) {
			return guard;
		}
		const rows = (await this.sql.unsafe(STMT.transition, [
			input.taskId,
			input.to,
			input.expectedStatus,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) {
			return { ok: true, task: mapTaskRow(rows[0]) };
		}
		// Disambiguate the failure for the caller.
		const currentRows = (await this.sql.unsafe(STMT.get, [
			input.taskId,
		])) as unknown as Record<string, unknown>[];
		if (currentRows.length === 0) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const current = mapTaskRow(currentRows[0]);
		if (current.status !== input.expectedStatus) {
			return { ok: false, code: "CONFLICT" };
		}
		return { ok: false, code: "INVALID_TRANSITION" };
	}

	async listExpiredOverBudget(): Promise<TaskRow[]> {
		// "Expired over budget" means wall-clock lifetime: created_at plus the
		// task's max_duration_ms has passed while status is non-terminal.
		const rows = (await this.sql.unsafe(
			STMT.listExpiredOverBudget,
		)) as unknown as Record<string, unknown>[];
		return rows.map(mapTaskRow);
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
		budget_limits: row.budget_limits as TaskRow["budget_limits"],
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
