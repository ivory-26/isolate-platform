import "@tanstack/react-start/server-only";
import {
	type PgSql,
	PostgresQueueRepository,
	PostgresTaskRepository,
} from "@isolate/db";
import { taskSummarySchema } from "../features/tasks/contracts";
import { createRepositoryStore } from "./repository-store.server";
import type { TaskStore } from "./task-service.server";

export const repositoryOwnershipSql =
	"SELECT id FROM repositories WHERE organization_id = $1 AND id = $2 LIMIT 1";
export const latestTasksSql = `SELECT t.id, t.repository_id, t.branch, t.status, t.created_at, t.updated_at,
	r.id AS run_id, r.status AS run_status, r.started_at AS run_started_at, r.finished_at AS run_finished_at
	FROM tasks t
	LEFT JOIN LATERAL (
		SELECT id, status, started_at, finished_at FROM workflow_runs
		WHERE task_id = t.id AND organization_id = $1
		ORDER BY started_at DESC, id DESC LIMIT 1
	) r ON true
	WHERE t.organization_id = $1
	ORDER BY t.created_at DESC, t.id DESC LIMIT $2`;
function iso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return new Date(value).toISOString();
	throw new Error("Invalid stored timestamp");
}
export function createPostgresStore(sql: PgSql): TaskStore {
	const listLatest: TaskStore["listLatest"] = async (scope, limit) => {
		const rows = await sql.unsafe(latestTasksSql, [
			scope.organizationId,
			limit,
		]);
		return rows.map((row) =>
			taskSummarySchema.parse({
				id: row.id,
				repositoryId: row.repository_id,
				branch: row.branch,
				status: row.status,
				createdAt: iso(row.created_at),
				updatedAt: iso(row.updated_at),
				latestRun:
					row.run_id === null
						? null
						: {
								id: row.run_id,
								status: row.run_status,
								startedAt: iso(row.run_started_at),
								finishedAt:
									row.run_finished_at === null
										? null
										: iso(row.run_finished_at),
							},
			}),
		);
	};
	return {
		listLatest,
		async submit(scope, input) {
			// Task and queue writes commit together. Existing repository constructors
			// require PgSql; transactions provide the same bound unsafe API.
			return sql.begin(async (transaction) => {
				const connection = transaction as unknown as PgSql;
				return createRepositoryStore({
					tasks: new PostgresTaskRepository(connection),
					queue: new PostgresQueueRepository(connection),
					repositoryBelongsToOrganization: async (
						organizationId,
						repositoryId,
					) =>
						(
							await connection.unsafe(repositoryOwnershipSql, [
								organizationId,
								repositoryId,
							])
						).length === 1,
					listLatest,
				}).submit(scope, input);
			});
		},
	};
}
