import type {
	OrganizationId,
	RunEventType,
	TaskId,
	WorkflowRunId,
	WorkflowVersionId,
} from "@isolate/shared";
import type { PgSql } from "../client";
import type {
	RunEventRow,
	WorkflowRunRow,
	WorkflowVersionRow,
} from "../schema";

/**
 * Workflow runs plus the append-only event timeline.
 *
 * Runs are immutable in their version pin: any resumption (approval
 * resolution) reads the pinned version via getVersionPin, never the latest
 * authored graph. Events are insert-only.
 */

export interface WorkflowRunRepository {
	startRun(input: {
		taskId: TaskId;
		organizationId: OrganizationId;
		workflowVersionId: WorkflowVersionId;
	}): Promise<WorkflowRunRow>;
	get(runId: WorkflowRunId): Promise<WorkflowRunRow | null>;
	finish(
		runId: WorkflowRunId,
		status: "succeeded" | "failed",
	): Promise<WorkflowRunRow | null>;
	suspend(runId: WorkflowRunId): Promise<WorkflowRunRow | null>;
	getVersionPin(runId: WorkflowRunId): Promise<WorkflowVersionRow | null>;
	appendEvent(input: {
		taskId: TaskId;
		workflowRunId: WorkflowRunId | null;
		type: RunEventType;
		actor: RunEventRow["actor"];
		data: Record<string, unknown>;
	}): Promise<RunEventRow>;
	listEvents(taskId: TaskId, limit: number): Promise<RunEventRow[]>;
}

const RUN_COLUMNS = `id, task_id, organization_id, workflow_version_id, status, started_at, finished_at`;
const EVENT_COLUMNS = `id, task_id, workflow_run_id, type, actor, data, occurred_at`;
const VERSION_COLUMNS = `id, definition_id, version, graph, compiled, created_by, created_at`;

const STMT = {
	startRun: `INSERT INTO workflow_runs (
		task_id, organization_id, workflow_version_id, status, started_at, finished_at
	) VALUES ($1, $2, $3, 'running', now(), NULL)
	RETURNING ${RUN_COLUMNS}`,
	get: `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = $1`,
	finish: `UPDATE workflow_runs SET status = $2, finished_at = now()
		WHERE id = $1 AND status IN ('running', 'suspended')
		RETURNING ${RUN_COLUMNS}`,
	suspend: `UPDATE workflow_runs SET status = 'suspended'
		WHERE id = $1 AND status = 'running'
		RETURNING ${RUN_COLUMNS}`,
	getVersionPin: `SELECT ${VERSION_COLUMNS}
		FROM workflow_versions v
		JOIN workflow_runs r ON r.workflow_version_id = v.id
		WHERE r.id = $1`,
	appendEvent: `INSERT INTO run_events (
		task_id, workflow_run_id, type, actor, data, occurred_at
	) VALUES ($1, $2::uuid, $3, $4, $5::text::jsonb, now())
	RETURNING ${EVENT_COLUMNS}`,
	listEvents: `SELECT ${EVENT_COLUMNS} FROM run_events
		WHERE task_id = $1 ORDER BY occurred_at ASC LIMIT $2`,
} as const;

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
	constructor(private readonly sql: PgSql) {}

	async startRun(input: {
		taskId: TaskId;
		organizationId: OrganizationId;
		workflowVersionId: WorkflowVersionId;
	}): Promise<WorkflowRunRow> {
		const rows = (await this.sql.unsafe(STMT.startRun, [
			input.taskId,
			input.organizationId,
			input.workflowVersionId,
		])) as unknown as RunDbRow[];
		if (rows.length === 0) {
			throw new Error("workflow run insert returned no row");
		}
		return mapRunRow(rows[0]);
	}

	async get(runId: WorkflowRunId): Promise<WorkflowRunRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			runId,
		])) as unknown as RunDbRow[];
		return rows.length === 0 ? null : mapRunRow(rows[0]);
	}

	async finish(
		runId: WorkflowRunId,
		status: "succeeded" | "failed",
	): Promise<WorkflowRunRow | null> {
		const rows = (await this.sql.unsafe(STMT.finish, [
			runId,
			status,
		])) as unknown as RunDbRow[];
		return rows.length === 0 ? null : mapRunRow(rows[0]);
	}

	async suspend(runId: WorkflowRunId): Promise<WorkflowRunRow | null> {
		const rows = (await this.sql.unsafe(STMT.suspend, [
			runId,
		])) as unknown as RunDbRow[];
		return rows.length === 0 ? null : mapRunRow(rows[0]);
	}

	async getVersionPin(
		runId: WorkflowRunId,
	): Promise<WorkflowVersionRow | null> {
		const rows = (await this.sql.unsafe(STMT.getVersionPin, [
			runId,
		])) as unknown as VersionDbRow[];
		if (rows.length === 0) {
			return null;
		}
		const row = rows[0];
		return {
			id: row.id as WorkflowVersionRow["id"],
			definition_id: row.definition_id as WorkflowVersionRow["definition_id"],
			version: row.version as number,
			graph: row.graph,
			compiled: row.compiled,
			created_by: row.created_by as WorkflowVersionRow["created_by"],
			created_at: row.created_at as Date,
		};
	}

	async appendEvent(input: {
		taskId: TaskId;
		workflowRunId: WorkflowRunId | null;
		type: RunEventType;
		actor: RunEventRow["actor"];
		data: Record<string, unknown>;
	}): Promise<RunEventRow> {
		const rows = (await this.sql.unsafe(STMT.appendEvent, [
			input.taskId,
			input.workflowRunId,
			input.type,
			input.actor,
			JSON.stringify(input.data),
		])) as unknown as EventDbRow[];
		if (rows.length === 0) {
			throw new Error("run event insert returned no row");
		}
		return mapEventRow(rows[0]);
	}

	async listEvents(taskId: TaskId, limit: number): Promise<RunEventRow[]> {
		// Bounded page size.
		const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
		const rows = (await this.sql.unsafe(STMT.listEvents, [
			taskId,
			clamped,
		])) as unknown as EventDbRow[];
		return rows.map(mapEventRow);
	}
}

type RunDbRow = Record<string, unknown>;
type EventDbRow = Record<string, unknown>;
type VersionDbRow = Record<string, unknown>;

function mapRunRow(row: RunDbRow): WorkflowRunRow {
	return {
		id: row.id as WorkflowRunRow["id"],
		task_id: row.task_id as WorkflowRunRow["task_id"],
		organization_id: row.organization_id as OrganizationId,
		workflow_version_id: row.workflow_version_id as WorkflowVersionId,
		status: row.status as WorkflowRunRow["status"],
		started_at: row.started_at as Date,
		finished_at: row.finished_at as Date | null,
	};
}

function mapEventRow(row: EventDbRow): RunEventRow {
	return {
		id: row.id as string,
		task_id: row.task_id as WorkflowRunRow["task_id"],
		workflow_run_id: row.workflow_run_id as WorkflowRunId | null,
		type: row.type as string,
		actor: row.actor as RunEventRow["actor"],
		data: row.data as Record<string, unknown>,
		occurred_at: row.occurred_at as Date,
	};
}
