import "@tanstack/react-start/server-only";
import type { RepositoryRow } from "@isolate/db";
import {
	MAX_REPOSITORY_ROWS,
	type RepositoriesQuery,
	type RepositorySummary,
} from "../features/repositories/contracts";
import type { WorkflowSummary } from "../features/workflows/contracts";
import { MAX_WORKFLOW_ROWS } from "../features/workflows/contracts";
import {
	summarizeWorkflowRow,
	type WorkflowReadRow,
} from "../features/workflows/summary";
import { iso, numeric } from "./ui-runtime.server";

/**
 * Tenant-scoped catalog read models (repositories + workflow library).
 *
 * Every statement binds `organization_id` as `$1`, caps its row count and uses
 * parameters for operator-supplied text. Nothing here echoes a driver error:
 * the calling server function maps failures to fixed `UiResult` codes.
 */

const REPOSITORY_COLUMNS = `id, organization_id, provider, external_full_name,
	default_branch, validation_command, validation_timeout_ms, created_at`;

const LIST_REPOSITORIES = `SELECT ${REPOSITORY_COLUMNS}
	FROM repositories
	WHERE organization_id = $1
		AND ($2 = '' OR position(lower($2) in lower(external_full_name)) > 0)
		AND ($3::text IS NULL OR provider = $3)
	ORDER BY external_full_name ASC, id ASC
	LIMIT ${MAX_REPOSITORY_ROWS + 1}`;

const LIST_WORKFLOWS = `SELECT
		d.id,
		d.name,
		d.created_at,
		u.display_name AS created_by_name,
		COALESCE(vc.version_count, 0)::int AS version_count,
		lv.version AS latest_version,
		lv.created_at AS latest_version_at,
		COALESCE(pc.plan_count, 0)::int AS compiled_plan_count,
		pc.latest_plan_version AS latest_plan_version,
		rj.issue_count AS latest_rejection_issue_count,
		rj.workflow_version AS latest_rejection_version,
		rj.created_at AS latest_rejection_at
	FROM workflow_definitions d
	LEFT JOIN users u ON u.id = d.created_by
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS version_count
		FROM workflow_versions v
		WHERE v.definition_id = d.id
	) vc ON true
	LEFT JOIN LATERAL (
		SELECT v.version, v.created_at
		FROM workflow_versions v
		WHERE v.definition_id = d.id
		ORDER BY v.version DESC
		LIMIT 1
	) lv ON true
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS plan_count,
			max(p.workflow_version) AS latest_plan_version
		FROM compiled_plans p
		WHERE p.organization_id = d.organization_id
			AND p.workflow_definition_id = d.id
	) pc ON true
	LEFT JOIN LATERAL (
		SELECT jsonb_array_length(ri.issues) AS issue_count,
			ri.workflow_version,
			ri.created_at
		FROM rejection_issues ri
		WHERE ri.organization_id = d.organization_id
			AND ri.workflow_definition_id = d.id
		ORDER BY ri.created_at DESC, ri.id DESC
		LIMIT 1
	) rj ON true
	WHERE d.organization_id = $1
	ORDER BY d.created_at DESC, d.id ASC
	LIMIT ${MAX_WORKFLOW_ROWS + 1}`;

/** Narrow seam so tests can supply a recording fake without a database. */
export type CatalogReadSql = {
	unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
};

function rowsOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		throw new Error("catalog read returned an unexpected row shape");
	}
	return value as Record<string, unknown>[];
}

/** Maps one driver row to the bounded, client-safe repository projection. */
export function summarizeRepositoryRow(row: RepositoryRow): RepositorySummary {
	return {
		id: String(row.id),
		provider: row.provider,
		externalFullName: String(row.external_full_name),
		defaultBranch: String(row.default_branch),
		validationCommand:
			row.validation_command === null ? null : String(row.validation_command),
		validationTimeoutMs: numeric(row.validation_timeout_ms),
		createdAt: iso(row.created_at),
	};
}

export async function readRepositories(
	sql: CatalogReadSql,
	organizationId: string,
	input: RepositoriesQuery,
): Promise<{ repositories: RepositorySummary[]; truncated: boolean }> {
	const rows = rowsOf(
		await sql.unsafe(LIST_REPOSITORIES, [
			organizationId,
			input.q,
			input.provider ?? null,
		]),
	);
	return {
		repositories: rows
			.slice(0, MAX_REPOSITORY_ROWS)
			.map((row) => summarizeRepositoryRow(row as unknown as RepositoryRow)),
		truncated: rows.length > MAX_REPOSITORY_ROWS,
	};
}

export async function readWorkflows(
	sql: CatalogReadSql,
	organizationId: string,
): Promise<{ workflows: WorkflowSummary[]; truncated: boolean }> {
	const rows = rowsOf(await sql.unsafe(LIST_WORKFLOWS, [organizationId]));
	return {
		workflows: rows
			.slice(0, MAX_WORKFLOW_ROWS)
			.map((row) => summarizeWorkflowRow(row as unknown as WorkflowReadRow)),
		truncated: rows.length > MAX_WORKFLOW_ROWS,
	};
}
