import "@tanstack/react-start/server-only";
import {
	aggregateUsage,
	buildUsageWindow,
	type SandboxDayRow,
	type UsageDayRow,
} from "../features/usage/aggregate";
import type { UsagePeriod, UsageReadModel } from "../features/usage/contracts";

/**
 * Tenant-scoped usage read model (wave 20).
 *
 * Three bounded aggregate queries, every one binding `organization_id` as $1:
 * - model/sandbox spend per UTC day from `usage_records` joined to `tasks`;
 * - measured `sandboxSeconds` per UTC day from `task_attempts` for tasks
 *   created in the same window;
 * - the distinct task count behind those usage rows.
 *
 * No row-level payload, model id, provider or driver message leaves this
 * module. Aggregation and cost arithmetic live in the pure helper.
 */

const USAGE_DAYS_SQL = `SELECT
		to_char(date_trunc('day', u.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
		COALESCE(SUM(u.prompt_tokens), 0)::bigint AS prompt_tokens,
		COALESCE(SUM(u.completion_tokens), 0)::bigint AS completion_tokens,
		SUM(u.cost_usd) AS cost_usd,
		COUNT(u.cost_usd)::int AS known_cost_rows,
		COUNT(*)::int AS total_rows
	FROM usage_records u
	LEFT JOIN tasks t
		ON t.id = u.task_id AND t.organization_id = u.organization_id
	WHERE u.organization_id = $1
		AND u.created_at >= $2
		AND u.created_at < $3
	GROUP BY 1
	ORDER BY 1 ASC`;

const SANDBOX_DAYS_SQL = `SELECT
		to_char(date_trunc('day', t.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
		COALESCE(SUM(
			CASE
				WHEN a.outcome ->> 'sandboxSeconds' ~ '^[0-9]+(\\.[0-9]+)?$'
					THEN (a.outcome ->> 'sandboxSeconds')::numeric
				ELSE 0
			END
		), 0) AS sandbox_seconds
	FROM task_attempts a
	JOIN tasks t ON t.id = a.task_id
	WHERE t.organization_id = $1
		AND t.created_at >= $2
		AND t.created_at < $3
	GROUP BY 1
	ORDER BY 1 ASC`;

const USAGE_TASKS_SQL = `SELECT COUNT(DISTINCT t.id)::int AS tasks
	FROM usage_records u
	JOIN tasks t
		ON t.id = u.task_id AND t.organization_id = u.organization_id
	WHERE u.organization_id = $1
		AND u.created_at >= $2
		AND u.created_at < $3`;

/** Narrow seam so tests can supply a recording fake without a database. */
export type UsageReadSql = {
	unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
};

function rowsOf(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) {
		throw new Error("usage read returned an unexpected row shape");
	}
	return value as Record<string, unknown>[];
}

export async function readUsage(
	sql: UsageReadSql,
	organizationId: string,
	period: UsagePeriod,
	now: Date = new Date(),
): Promise<UsageReadModel> {
	const window = buildUsageWindow(period, now);
	const usageRows = rowsOf(
		await sql.unsafe(USAGE_DAYS_SQL, [
			organizationId,
			window.since,
			window.until,
		]),
	) as unknown as UsageDayRow[];
	const sandboxRows = rowsOf(
		await sql.unsafe(SANDBOX_DAYS_SQL, [
			organizationId,
			window.since,
			window.until,
		]),
	) as unknown as SandboxDayRow[];
	const taskRows = rowsOf(
		await sql.unsafe(USAGE_TASKS_SQL, [
			organizationId,
			window.since,
			window.until,
		]),
	);
	return aggregateUsage({
		period,
		now,
		usageRows,
		sandboxRows,
		taskCount: taskRows[0]?.tasks,
	});
}
