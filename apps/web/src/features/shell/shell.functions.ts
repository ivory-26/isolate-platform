import { createServerFn } from "@tanstack/react-start";
import { numeric, uiRead } from "../../server/ui-runtime.server";
import type { ShellSummary } from "./contracts";

const summarySql = `SELECT
	(SELECT count(*)::int FROM approvals
		WHERE organization_id = $1 AND status = 'pending'
			AND (expires_at IS NULL OR expires_at > now())) AS pending_approvals,
	(SELECT count(*)::int FROM tasks
		WHERE organization_id = $1
			AND status IN ('planning', 'executing', 'validating', 'repairing', 'awaiting_approval')) AS active_tasks`;

/**
 * Two tenant-scoped counters for the shell. No rows, payloads or identifiers
 * leave this read; a missing database is a bounded unavailable result.
 */
export const getShellSummary = createServerFn({ method: "GET" }).handler(
	async () =>
		uiRead<ShellSummary>("task:read", async (scope, sql) => {
			const rows = (await sql.unsafe(summarySql, [
				scope.organizationId,
			])) as unknown as Record<string, unknown>[];
			const row = rows[0] ?? {};
			return {
				pendingApprovals: numeric(row.pending_approvals),
				activeTasks: numeric(row.active_tasks),
			};
		}),
);
