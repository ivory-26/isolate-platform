import type { OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { RunEventRow } from "../schema";
import { clampPageLimit } from "./pagination";
import { requireNonEmpty } from "./task-repository";

/**
 * Tenant-scoped read of the append-only run-event timeline.
 *
 * `run_events` carries no `organization_id` column (0001), so tenancy is
 * proven with a join on `tasks.organization_id`. A foreign task id therefore
 * returns an empty page, never another organization's events. Writes stay
 * owned by the execution lifecycle; this contract is read-only.
 */

export type ListRunEventsInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	/** Page size; defaults to 100 and is clamped to 500. */
	limit?: number;
};

export interface RunEventRepository {
	listByTask(input: ListRunEventsInput): Promise<RunEventRow[]>;
}

const EVENT_COLUMNS = `e.id, e.task_id, e.workflow_run_id, e.type, e.actor, e.data, e.occurred_at`;

const STMT = {
	listByTask: `SELECT ${EVENT_COLUMNS} FROM run_events e
		JOIN tasks t ON t.id = e.task_id AND t.organization_id = $1
		WHERE e.task_id = $2
		ORDER BY e.occurred_at ASC, e.id ASC
		LIMIT $3`,
} as const;

export class PostgresRunEventRepository implements RunEventRepository {
	constructor(private readonly sql: PgSql) {}

	async listByTask(input: ListRunEventsInput): Promise<RunEventRow[]> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		// Oldest-first: a timeline replays in order, and the bound keeps a
		// noisy task from streaming its whole history to a reviewer.
		const rows = (await this.sql.unsafe(STMT.listByTask, [
			input.organizationId,
			input.taskId,
			clampPageLimit(input.limit),
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapRunEventRow);
	}
}

export function mapRunEventRow(row: Record<string, unknown>): RunEventRow {
	return {
		id: row.id as string,
		task_id: row.task_id as RunEventRow["task_id"],
		workflow_run_id: row.workflow_run_id as RunEventRow["workflow_run_id"],
		type: row.type as string,
		actor: row.actor as RunEventRow["actor"],
		data: (parseJsonbColumn(row.data) ?? {}) as Record<string, unknown>,
		occurred_at: row.occurred_at as Date,
	};
}
