import type { RunListRow } from "@/features/runs/contracts";

/** Command-palette run search needs a few rows, not a page. */
export const COMMAND_RUN_LIMIT = 6;

/** Below this length a run query would match most of the tenant's history. */
export const COMMAND_RUN_QUERY_MIN_LENGTH = 2;

/**
 * One palette row per run. The value string carries what the palette can
 * match on locally (id, branch, repository) so cmdk's filter and the server
 * query agree about what the row is.
 */
export type CommandRunItem = {
	taskId: string;
	label: string;
	hint: string;
	value: string;
};

export function commandRunQuery(query: string): string {
	const trimmed = query.trim();
	return trimmed.length >= COMMAND_RUN_QUERY_MIN_LENGTH ? trimmed : "";
}

export function commandRunItems(
	rows: readonly RunListRow[],
	limit: number = COMMAND_RUN_LIMIT,
): CommandRunItem[] {
	const bounded = Math.max(1, Math.min(Math.floor(limit), COMMAND_RUN_LIMIT));
	return rows.slice(0, bounded).map((row) => {
		const repository = row.repository.fullName;
		return {
			taskId: row.taskId,
			label: `${row.taskId.slice(0, 8)} · ${row.branch}`,
			hint: repository,
			// Carries every field the server matched on, so the local filter
			// never hides a row the query found.
			value: `run ${row.taskId} ${row.branch} ${repository} ${row.goal}`,
		};
	});
}
