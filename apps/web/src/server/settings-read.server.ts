import "@tanstack/react-start/server-only";
import type { PgSql } from "@isolate/db";
import {
	isSettingsRole,
	type WorkspaceMember,
	type WorkspaceSummary,
} from "../features/settings/contracts";
import { UiNotFoundError } from "../features/ui/contracts";
import type { CallerScope } from "./task-service.server";
import { numeric } from "./ui-runtime.server";

/**
 * Tenant-scoped reads behind the Settings page (W20).
 *
 * Both queries bind `scope.organizationId` as the only tenancy input and cap
 * the rows they return. The caller's role is never read from a request; the
 * ui-runtime capability gate runs before these functions.
 */

/** Hard row cap for the member list; the page never renders an unbounded table. */
export const MAX_SETTINGS_MEMBERS = 200;

const SUMMARY_SQL = `SELECT
	o.name,
	o.slug,
	(SELECT count(*)::int FROM memberships m
		WHERE m.organization_id = o.id) AS member_count
	FROM organizations o
	WHERE o.id = $1
	LIMIT 1`;

const MEMBERS_SQL = `SELECT
	u.email,
	u.display_name,
	m.role
	FROM memberships m
	JOIN users u ON u.id = m.user_id
	WHERE m.organization_id = $1
	ORDER BY
		CASE m.role
			WHEN 'owner' THEN 0
			WHEN 'admin' THEN 1
			WHEN 'member' THEN 2
			ELSE 3
		END,
		lower(u.email)
	LIMIT ${MAX_SETTINGS_MEMBERS}`;

function requiredText(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("Stored settings record is incomplete");
	}
	return value;
}

export async function readWorkspaceSummary(
	scope: CallerScope,
	sql: PgSql,
): Promise<WorkspaceSummary> {
	const rows = (await sql.unsafe(SUMMARY_SQL, [
		scope.organizationId,
	])) as unknown as Record<string, unknown>[];
	const row = rows[0];
	if (row === undefined) throw new UiNotFoundError();
	const role = scope.role;
	if (!isSettingsRole(role)) {
		throw new Error("Stored membership has an unknown role");
	}
	return {
		name: requiredText(row, "name"),
		slug: requiredText(row, "slug"),
		role,
		memberCount: numeric(row.member_count),
	};
}

export async function readWorkspaceMembers(
	scope: CallerScope,
	sql: PgSql,
): Promise<WorkspaceMember[]> {
	const rows = (await sql.unsafe(MEMBERS_SQL, [
		scope.organizationId,
	])) as unknown as Record<string, unknown>[];
	return rows.map((row) => {
		const role = row.role;
		if (!isSettingsRole(role)) {
			throw new Error("Stored membership has an unknown role");
		}
		return {
			email: requiredText(row, "email"),
			displayName: requiredText(row, "display_name"),
			role,
		};
	});
}
