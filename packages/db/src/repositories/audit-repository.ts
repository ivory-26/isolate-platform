import type { OrganizationId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { AuditAction, AuditEventRow, ToolInvocationRow } from "../schema";

/**
 * Append-only audit trail and tool-invocation records.
 * Redaction and sanitisation are the caller's responsibility (fail-quiet,
 * typed persistence layer); this layer never mutates supplied payloads.
 */

export interface AuditRepository {
	append(input: {
		organizationId: OrganizationId;
		actorId: string | null;
		actorKind: AuditEventRow["actor_kind"];
		action: AuditAction;
		target: string;
		details: Record<string, unknown>;
	}): Promise<AuditEventRow>;
}

export interface ToolInvocationRepository {
	record(input: {
		organizationId: OrganizationId;
		taskId: string;
		workflowRunId: string | null;
		toolName: string;
		argumentsRedacted: Record<string, unknown>;
		decision: ToolInvocationRow["decision"];
		denialReason: string | null;
		durationMs: number | null;
	}): Promise<ToolInvocationRow>;
}

const AUDIT_COLUMNS = `id, organization_id, actor_id, actor_kind, action, target, details, created_at`;
const TOOL_COLUMNS = `id, organization_id, task_id, workflow_run_id, tool_name, arguments_redacted, decision, denial_reason, duration_ms, created_at`;

const STMT = {
	appendAudit: `INSERT INTO audit_events (
		organization_id, actor_id, actor_kind, action, target, details, created_at
	) VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
	RETURNING ${AUDIT_COLUMNS}`,
	insertToolInvocation: `INSERT INTO tool_invocations (
		organization_id, task_id, workflow_run_id, tool_name,
		arguments_redacted, decision, denial_reason, duration_ms, created_at
	) VALUES ($1, $2, $3::uuid, $4, $5::jsonb, $6, $7, $8, now())
	RETURNING ${TOOL_COLUMNS}`,
} as const;

export class PostgresAuditRepository implements AuditRepository {
	constructor(private readonly sql: PgSql) {}

	async append(input: {
		organizationId: OrganizationId;
		actorId: string | null;
		actorKind: AuditEventRow["actor_kind"];
		action: AuditAction;
		target: string;
		details: Record<string, unknown>;
	}): Promise<AuditEventRow> {
		const rows = (await this.sql.unsafe(STMT.appendAudit, [
			input.organizationId,
			input.actorId,
			input.actorKind,
			input.action,
			input.target,
			JSON.stringify(input.details),
		])) as unknown as AuditDbRow[];
		if (rows.length === 0) {
			throw new Error("audit insert returned no row");
		}
		return mapAuditRow(rows[0]);
	}
}

export class PostgresToolInvocationRepository
	implements ToolInvocationRepository
{
	constructor(private readonly sql: PgSql) {}

	async record(input: {
		organizationId: OrganizationId;
		taskId: string;
		workflowRunId: string | null;
		toolName: string;
		argumentsRedacted: Record<string, unknown>;
		decision: ToolInvocationRow["decision"];
		denialReason: string | null;
		durationMs: number | null;
	}): Promise<ToolInvocationRow> {
		// denial_reason/duration_ms are nullable columns; bind explicit NULLs.
		const denialReason = input.denialReason ?? null;
		const durationMs =
			input.durationMs !== null && Number.isFinite(input.durationMs)
				? Math.max(0, Math.round(input.durationMs))
				: null;
		const rows = (await this.sql.unsafe(STMT.insertToolInvocation, [
			input.organizationId,
			input.taskId,
			input.workflowRunId,
			input.toolName,
			JSON.stringify(input.argumentsRedacted),
			input.decision,
			denialReason,
			durationMs,
		])) as unknown as ToolDbRow[];
		if (rows.length === 0) {
			throw new Error("tool invocation insert returned no row");
		}
		return mapToolRow(rows[0]);
	}
}

type AuditDbRow = Record<string, unknown>;
type ToolDbRow = Record<string, unknown>;

function mapAuditRow(row: AuditDbRow): AuditEventRow {
	return {
		id: row.id as AuditEventRow["id"],
		organization_id: row.organization_id as AuditEventRow["organization_id"],
		actor_id: row.actor_id as string | null,
		actor_kind: row.actor_kind as AuditEventRow["actor_kind"],
		action: row.action as AuditAction,
		target: row.target as string,
		details: row.details as Record<string, unknown>,
		created_at: row.created_at as Date,
	};
}

function mapToolRow(row: ToolDbRow): ToolInvocationRow {
	return {
		id: row.id as string,
		organization_id:
			row.organization_id as ToolInvocationRow["organization_id"],
		task_id: row.task_id as ToolInvocationRow["task_id"],
		workflow_run_id:
			row.workflow_run_id as ToolInvocationRow["workflow_run_id"],
		tool_name: row.tool_name as string,
		arguments_redacted: row.arguments_redacted as Record<string, unknown>,
		decision: row.decision as ToolInvocationRow["decision"],
		denial_reason: row.denial_reason as string | null,
		duration_ms: row.duration_ms as number | null,
		created_at: row.created_at as Date,
	};
}
