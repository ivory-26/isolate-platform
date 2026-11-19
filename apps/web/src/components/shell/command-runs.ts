import type { RunListRow } from "@/features/runs/contracts";

/** Command-palette run search needs a few rows, not a page. */
export const COMMAND_RUN_LIMIT = 6;

/** Below this length a run query would match most of the tenant's history. */
export const COMMAND_RUN_QUERY_MIN_LENGTH = 2;

/** One-line goal preview bound; the full goal stays in `value` for matching. */
export const COMMAND_RUN_DETAIL_MAX = 120;

/**
 * One palette row per run. The value string carries what the palette can
 * match on locally (id, branch, repository) so cmdk's filter and the server
 * query agree about what the row is.
 */
export type CommandRunItem = {
	taskId: string;
	label: string;
	hint: string;
	/** One-line goal, or the repository when the task carries no goal. */
	detail: string;
	value: string;
};

export function commandRunQuery(query: string): string {
	const trimmed = query.trim();
	return trimmed.length >= COMMAND_RUN_QUERY_MIN_LENGTH ? trimmed : "";
}

/**
 * One readable line for the palette. Incident tasks carry a briefing whose
 * first sentence is boilerplate, so the `Title:` line is preferred when the
 * goal has one; anything else is cut to the display bound.
 */
export function goalSummary(goal: string): string {
	const lines = goal
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const title = lines.find((line) => /^title:/i.test(line));
	const raw =
		title === undefined ? (lines[0] ?? "") : title.replace(/^title:\s*/i, "");
	const line = raw.replace(/\s+/g, " ").trim();
	if (line === "") return "";
	return line.length > COMMAND_RUN_DETAIL_MAX
		? `${line.slice(0, COMMAND_RUN_DETAIL_MAX - 1)}…`
		: line;
}

export function commandRunItems(
	rows: readonly RunListRow[],
	limit: number = COMMAND_RUN_LIMIT,
): CommandRunItem[] {
	const bounded = Math.max(1, Math.min(Math.floor(limit), COMMAND_RUN_LIMIT));
	return rows.slice(0, bounded).map((row) => {
		const repository = row.repository.fullName;
		const summary = goalSummary(row.goal);
		return {
			taskId: row.taskId,
			label: `${row.taskId.slice(0, 8)} · ${row.branch}`,
			hint: repository,
			// The goal is what the row search matches on most often, so the row
			// shows it instead of leaving the user to guess why it matched.
			detail: summary === "" ? repository : summary,
			// Carries every field the server matched on, so the local filter
			// never hides a row the query found.
			value: `run ${row.taskId} ${row.branch} ${repository} ${row.goal}`,
		};
	});
}
