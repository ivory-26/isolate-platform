import type { OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { TaskStatusDb } from "../schema";

/**
 * Tenant-scoped read model for the worker's `loadTaskContext`.
 *
 * Deliberately a neutral row (no `@isolate/mastra` import): the worker maps it
 * to `TaskContext`, so this package stays independent of the orchestration
 * layer. One read joins the task with its repository, and both sides are
 * constrained by `organization_id`, so a job can never load another tenant's
 * task or repository.
 */
export type TaskContextSourceRow = {
	taskId: TaskId;
	organizationId: OrganizationId;
	/** Optional so fakes/older rows can omit it; the DB read always supplies it. */
	repositoryId?: string;
	status: TaskStatusDb;
	goal: string;
	acceptanceCriteria: string[];
	fileOwnership: string[];
	branch: string;
	repositoryProvider: string;
	repositoryFullName: string;
	repositoryDefaultBranch: string;
	budgetLimits: {
		max_agent_turns: number;
		max_repair_attempts: number;
		max_duration_ms: number;
	};
};

export interface TaskContextRepository {
	get(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<TaskContextSourceRow | null>;
}

const STMT = {
	get: `SELECT t.id, t.organization_id, t.repository_id, t.status, t.goal, t.acceptance_criteria,
			t.file_ownership, t.branch, t.budget_limits,
			r.provider AS repository_provider,
			r.external_full_name AS repository_full_name,
			r.default_branch AS repository_default_branch
		FROM tasks t
		INNER JOIN repositories r
			ON r.id = t.repository_id
			AND r.organization_id = t.organization_id
		WHERE t.id = $1 AND t.organization_id = $2
		LIMIT 1`,
} as const;

export class PostgresTaskContextRepository implements TaskContextRepository {
	constructor(private readonly sql: PgSql) {}

	async get(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<TaskContextSourceRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			input.taskId,
			input.organizationId,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapTaskContextRow(rows[0]);
	}
}

function stringArray(value: unknown, field: string): string[] {
	const parsed = parseJsonbColumn<unknown>(value);
	if (
		!Array.isArray(parsed) ||
		parsed.some((entry) => typeof entry !== "string")
	) {
		throw new Error(`task context ${field} is not a string array`);
	}
	return parsed as string[];
}

function positiveInt(value: unknown, field: string): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`task context ${field} is not a non-negative integer`);
	}
	return parsed;
}

function mapTaskContextRow(row: Record<string, unknown>): TaskContextSourceRow {
	const budget = parseJsonbColumn<Record<string, unknown>>(row.budget_limits);
	return {
		taskId: row.id as TaskContextSourceRow["taskId"],
		organizationId:
			row.organization_id as TaskContextSourceRow["organizationId"],
		repositoryId: row.repository_id as string,
		status: row.status as TaskContextSourceRow["status"],
		goal: typeof row.goal === "string" ? row.goal : "",
		acceptanceCriteria: stringArray(
			row.acceptance_criteria,
			"acceptance_criteria",
		),
		fileOwnership: stringArray(row.file_ownership, "file_ownership"),
		branch: row.branch as string,
		repositoryProvider: row.repository_provider as string,
		repositoryFullName: row.repository_full_name as string,
		repositoryDefaultBranch: row.repository_default_branch as string,
		budgetLimits: {
			max_agent_turns: positiveInt(
				budget?.max_agent_turns,
				"budget_limits.max_agent_turns",
			),
			max_repair_attempts: positiveInt(
				budget?.max_repair_attempts,
				"budget_limits.max_repair_attempts",
			),
			max_duration_ms: positiveInt(
				budget?.max_duration_ms,
				"budget_limits.max_duration_ms",
			),
		},
	};
}
