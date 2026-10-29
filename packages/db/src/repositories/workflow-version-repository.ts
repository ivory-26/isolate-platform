import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { WorkflowVersionRow } from "../schema";
import { validateWorkflowPin } from "./workflow-compilation";

const GET_AUTHORED_VERSION = `SELECT
	v.id, v.definition_id, v.version, v.graph, v.compiled, v.created_by, v.created_at
	FROM workflow_versions v
	JOIN workflow_definitions d ON d.id = v.definition_id
	WHERE d.organization_id = $1 AND v.definition_id = $2 AND v.version = $3`;

/** Read only an existing authored pin; absent, foreign and invalid pins are null. */
export interface WorkflowVersionRepository {
	getAuthoredVersion(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
	): Promise<WorkflowVersionRow | null>;
}

export class PostgresWorkflowVersionRepository
	implements WorkflowVersionRepository
{
	constructor(private readonly sql: PgSql) {}

	async getAuthoredVersion(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
	): Promise<WorkflowVersionRow | null> {
		try {
			validateWorkflowPin({
				organizationId,
				workflowDefinitionId,
				workflowVersion,
			});
		} catch {
			return null;
		}
		const rows = await this.sql.unsafe(GET_AUTHORED_VERSION, [
			organizationId,
			workflowDefinitionId,
			workflowVersion,
		]);
		if (rows.length === 0) return null;
		const row = rows[0];
		return {
			id: row.id as WorkflowVersionRow["id"],
			definition_id: row.definition_id as WorkflowDefinitionId,
			version: row.version as number,
			graph: parseJsonbColumn<unknown>(row.graph),
			compiled: parseJsonbColumn<unknown>(row.compiled),
			created_by: row.created_by as WorkflowVersionRow["created_by"],
			created_at: row.created_at as Date,
		};
	}
}
