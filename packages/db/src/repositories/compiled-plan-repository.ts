import type { OrganizationId, WorkflowDefinitionId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { CompiledPlanRow, CompiledWorkflowPlan } from "../schema";
import {
	evaluateWorkflowVersion,
	validateCompiledPlan,
	validateWorkflowPin,
	validateWorkflowScope,
	WORKFLOW_VERSION_EXISTS_SQL,
	type WorkflowVersionPin,
} from "./workflow-compilation";

const PLAN_COLUMNS =
	"id, organization_id, workflow_definition_id, workflow_version, plan, created_at";
const STMT = {
	save: `INSERT INTO compiled_plans (
		organization_id, workflow_definition_id, workflow_version, plan
	) SELECT $1, $2, $3, $4::text::jsonb FROM workflow_definitions d
		JOIN workflow_versions v ON v.definition_id = d.id
		WHERE d.organization_id = $1 AND d.id = $2 AND v.version = $3
	ON CONFLICT (organization_id, workflow_definition_id, workflow_version) DO NOTHING
	RETURNING ${PLAN_COLUMNS}`,
	get: `SELECT ${PLAN_COLUMNS} FROM compiled_plans
		WHERE organization_id = $1 AND workflow_definition_id = $2 AND workflow_version = $3`,
	list: `SELECT ${PLAN_COLUMNS} FROM compiled_plans
		WHERE organization_id = $1 AND workflow_definition_id = $2
		ORDER BY workflow_version DESC`,
	listVersions: `SELECT id, workflow_version, created_at FROM compiled_plans
		WHERE organization_id = $1 AND workflow_definition_id = $2
		ORDER BY workflow_version DESC`,
} as const;

export type SavePlanFailCode = "NOT_FOUND" | "CONFLICT";
export type SavePlanInput = WorkflowVersionPin & { plan: CompiledWorkflowPlan };
export type SavePlanResult =
	| { ok: true; plan: CompiledPlanRow }
	| { ok: false; code: SavePlanFailCode };
export type CompiledPlanVersionSummary = Pick<
	CompiledPlanRow,
	"id" | "workflow_version" | "created_at"
>;

/** Insert-only: even an identical save conflicts; callers must create a new version. */
export interface CompiledPlanRepository {
	save(input: SavePlanInput): Promise<SavePlanResult>;
	get(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
	): Promise<CompiledPlanRow | null>;
	list(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanRow[]>;
	listVersions(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanVersionSummary[]>;
}

/** Shared classification; unknown/foreign versions are never reported as conflicts. */
export function evaluatePlanSaveOutcome(input: {
	versionExists: boolean;
	alreadySaved: boolean;
}): { ok: true } | { ok: false; code: SavePlanFailCode } {
	const version = evaluateWorkflowVersion(input.versionExists);
	if (!version.ok) return version;
	return input.alreadySaved ? { ok: false, code: "CONFLICT" } : { ok: true };
}

export class PostgresCompiledPlanRepository implements CompiledPlanRepository {
	constructor(private readonly sql: PgSql) {}

	async save(input: SavePlanInput): Promise<SavePlanResult> {
		const planJson = validateCompiledPlan(input);
		const params = [
			input.organizationId,
			input.workflowDefinitionId,
			input.workflowVersion,
		];
		const rows = await this.sql.unsafe(STMT.save, [...params, planJson]);
		if (rows.length > 0) return { ok: true, plan: mapPlanRow(rows[0]) };
		// INSERT's tenant/version predicate or its atomic uniqueness check failed.
		const versions = await this.sql.unsafe(WORKFLOW_VERSION_EXISTS_SQL, params);
		const outcome = evaluatePlanSaveOutcome({
			versionExists: versions.length > 0,
			alreadySaved: true,
		});
		if (!outcome.ok) return outcome;
		throw new Error("unreachable compiled plan save outcome");
	}

	async get(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
		workflowVersion: number,
	): Promise<CompiledPlanRow | null> {
		validateWorkflowPin({
			organizationId,
			workflowDefinitionId,
			workflowVersion,
		});
		const rows = await this.sql.unsafe(STMT.get, [
			organizationId,
			workflowDefinitionId,
			workflowVersion,
		]);
		return rows.length === 0 ? null : mapPlanRow(rows[0]);
	}

	async list(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanRow[]> {
		validateWorkflowScope(organizationId, workflowDefinitionId);
		const rows = await this.sql.unsafe(STMT.list, [
			organizationId,
			workflowDefinitionId,
		]);
		return rows.map(mapPlanRow);
	}

	async listVersions(
		organizationId: OrganizationId,
		workflowDefinitionId: WorkflowDefinitionId,
	): Promise<CompiledPlanVersionSummary[]> {
		validateWorkflowScope(organizationId, workflowDefinitionId);
		const rows = await this.sql.unsafe(STMT.listVersions, [
			organizationId,
			workflowDefinitionId,
		]);
		return rows.map((row) => ({
			id: row.id as string,
			workflow_version: row.workflow_version as number,
			created_at: row.created_at as Date,
		}));
	}
}

function mapPlanRow(row: Record<string, unknown>): CompiledPlanRow {
	return {
		id: row.id as string,
		organization_id: row.organization_id as OrganizationId,
		workflow_definition_id: row.workflow_definition_id as WorkflowDefinitionId,
		workflow_version: row.workflow_version as number,
		plan: parseJsonbColumn<CompiledWorkflowPlan>(
			row.plan,
		) as CompiledWorkflowPlan,
		created_at: row.created_at as Date,
	};
}
