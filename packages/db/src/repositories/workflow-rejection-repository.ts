import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { WorkflowRejectionIssue, WorkflowRejectionRow } from "../schema";
import {
	evaluateWorkflowVersion,
	validateRejectionIssues,
	validateRejectionLimit,
	validateWorkflowPin,
	type WorkflowVersionPin,
} from "./workflow-compilation";

const COLUMNS =
	"id, organization_id, workflow_definition_id, workflow_version, issues, created_at";
const STMT = {
	record: `INSERT INTO rejection_issues (
		organization_id, workflow_definition_id, workflow_version, issues
	) SELECT $1, $2, $3, $4::jsonb FROM workflow_definitions d
		JOIN workflow_versions v ON v.definition_id = d.id
		WHERE d.organization_id = $1 AND d.id = $2 AND v.version = $3
	RETURNING ${COLUMNS}`,
	listLatest: `SELECT ${COLUMNS} FROM rejection_issues
		WHERE organization_id = $1 AND workflow_definition_id = $2 AND workflow_version = $3
		ORDER BY created_at DESC, id DESC LIMIT $4`,
} as const;

export type RecordWorkflowRejectionInput = WorkflowVersionPin & {
	issues: WorkflowRejectionIssue[];
};
export type RecordWorkflowRejectionResult =
	| { ok: true; rejection: WorkflowRejectionRow }
	| { ok: false; code: "NOT_FOUND" };

/** Append-only history for an existing authored version, newest first. */
export interface WorkflowRejectionRepository {
	record(
		input: RecordWorkflowRejectionInput,
	): Promise<RecordWorkflowRejectionResult>;
	listLatest(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
		limit?: number,
	): Promise<WorkflowRejectionRow[]>;
}

export class PostgresWorkflowRejectionRepository
	implements WorkflowRejectionRepository
{
	constructor(private readonly sql: PgSql) {}

	async record(
		input: RecordWorkflowRejectionInput,
	): Promise<RecordWorkflowRejectionResult> {
		const issuesJson = validateRejectionIssues(input);
		const rows = await this.sql.unsafe(STMT.record, [
			input.organizationId,
			input.workflowDefinitionId,
			input.workflowVersion,
			issuesJson,
		]);
		const outcome = evaluateWorkflowVersion(rows.length > 0);
		if (!outcome.ok) return outcome;
		return { ok: true, rejection: mapRejectionRow(rows[0]) };
	}

	async listLatest(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
		limit = 50,
	): Promise<WorkflowRejectionRow[]> {
		validateWorkflowPin({
			organizationId,
			workflowDefinitionId,
			workflowVersion,
		});
		validateRejectionLimit(limit);
		const rows = await this.sql.unsafe(STMT.listLatest, [
			organizationId,
			workflowDefinitionId,
			workflowVersion,
			limit,
		]);
		return rows.map(mapRejectionRow);
	}
}

function mapRejectionRow(row: Record<string, unknown>): WorkflowRejectionRow {
	return {
		id: row.id as string,
		organization_id: row.organization_id as OrganizationId,
		workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId,
		workflow_version: row.workflow_version as number,
		issues: parseJsonbColumn<WorkflowRejectionIssue[]>(
			row.issues,
		) as WorkflowRejectionIssue[],
		created_at: row.created_at as Date,
	};
}
