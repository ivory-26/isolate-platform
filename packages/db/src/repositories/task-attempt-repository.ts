import type { TaskAttemptId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { TaskAttemptOutcome, TaskAttemptRow } from "../schema";

/**
 * Bounded attempt bookkeeping over task_attempts.
 *
 * `attemptIndex` is allocated server-side (MAX+1 per task inside the INSERT),
 * so concurrent begin() calls cannot collide and callers can never choose a
 * counter. The repair budget (max_repair_attempts in the task's budget_limits)
 * is enforced against countRepairAttempts, which keeps the repair loop finite.
 */

export interface TaskAttemptRepository {
	begin(taskId: TaskId, workflowRunId: string | null): Promise<TaskAttemptRow>;
	finish(input: {
		attemptId: TaskAttemptId;
		outcome: TaskAttemptOutcome;
	}): Promise<TaskAttemptRow | null>;
	countRepairAttempts(taskId: TaskId): Promise<number>;
	listByTask(taskId: TaskId): Promise<TaskAttemptRow[]>;
}

const ATTEMPT_COLUMNS = `id, task_id, workflow_run_id, attempt_index, started_at, finished_at, outcome`;

const STMT = {
	begin: `INSERT INTO task_attempts (
		task_id, workflow_run_id, attempt_index, started_at, finished_at, outcome
	) VALUES (
		$1,
		$2::uuid,
		(SELECT COALESCE(MAX(attempt_index), 0) + 1 FROM task_attempts WHERE task_id = $1),
		now(), NULL, NULL
	)
	RETURNING ${ATTEMPT_COLUMNS}`,
	finish: `UPDATE task_attempts SET finished_at = now(), outcome = $2::jsonb
		WHERE id = $1 AND finished_at IS NULL
		RETURNING ${ATTEMPT_COLUMNS}`,
	countRepairAttempts: `SELECT COUNT(*)::int AS n FROM task_attempts
		WHERE task_id = $1 AND outcome->>'kind' = 'repair'`,
	listByTask: `SELECT ${ATTEMPT_COLUMNS} FROM task_attempts
		WHERE task_id = $1 ORDER BY attempt_index ASC`,
} as const;

export class PostgresTaskAttemptRepository implements TaskAttemptRepository {
	constructor(private readonly sql: PgSql) {}

	async begin(
		taskId: TaskId,
		workflowRunId: string | null,
	): Promise<TaskAttemptRow> {
		const rows = (await this.sql.unsafe(STMT.begin, [
			taskId,
			workflowRunId,
		])) as unknown as AttemptDbRow[];
		if (rows.length === 0) {
			throw new Error("attempt begin returned no row");
		}
		return mapAttemptRow(rows[0]);
	}

	async finish(input: {
		attemptId: TaskAttemptId;
		outcome: TaskAttemptOutcome;
	}): Promise<TaskAttemptRow | null> {
		const rows = (await this.sql.unsafe(STMT.finish, [
			input.attemptId,
			JSON.stringify(input.outcome),
		])) as unknown as AttemptDbRow[];
		return rows.length === 0 ? null : mapAttemptRow(rows[0]);
	}

	async countRepairAttempts(taskId: TaskId): Promise<number> {
		const rows = (await this.sql.unsafe(STMT.countRepairAttempts, [
			taskId,
		])) as unknown as Array<{ n: number }>;
		return rows.length === 0 ? 0 : rows[0].n;
	}

	async listByTask(taskId: TaskId): Promise<TaskAttemptRow[]> {
		const rows = (await this.sql.unsafe(STMT.listByTask, [
			taskId,
		])) as unknown as AttemptDbRow[];
		return rows.map(mapAttemptRow);
	}
}

type AttemptDbRow = Record<string, unknown>;

function mapAttemptRow(row: AttemptDbRow): TaskAttemptRow {
	return {
		id: row.id as TaskAttemptRow["id"],
		task_id: row.task_id as TaskAttemptRow["task_id"],
		workflow_run_id: row.workflow_run_id as TaskAttemptRow["workflow_run_id"],
		attempt_index: row.attempt_index as number,
		started_at: row.started_at as Date,
		finished_at: row.finished_at as Date | null,
		outcome: parseJsonbColumn<TaskAttemptOutcome>(
			row.outcome,
		) as TaskAttemptOutcome | null,
	};
}
