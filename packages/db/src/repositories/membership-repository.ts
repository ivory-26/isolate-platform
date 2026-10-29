import type { OrganizationId, UserId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { MembershipRow, UserRole } from "../schema";
import { requireNonEmpty } from "./task-repository";

/** The platform's tenant roles (ARCHITECTURE.md §5). */
export const USER_ROLES = [
	"owner",
	"admin",
	"member",
	"viewer",
] as const satisfies readonly UserRole[];

const ROLE_SET: ReadonlySet<string> = new Set(USER_ROLES);

export function isUserRole(value: unknown): value is UserRole {
	return typeof value === "string" && ROLE_SET.has(value);
}

/**
 * Organization membership: the only record that grants a caller access to an
 * organization's rows. A membership is created by an organization owner and
 * is never derived from request data.
 */
export interface MembershipRepository {
	listForUser(userId: UserId): Promise<MembershipRow[]>;
	getForUser(
		userId: UserId,
		organizationId: OrganizationId,
	): Promise<MembershipRow | null>;
	add(input: {
		organizationId: OrganizationId;
		userId: UserId;
		role: UserRole;
	}): Promise<MembershipRow>;
	remove(input: {
		organizationId: OrganizationId;
		userId: UserId;
	}): Promise<boolean>;
	countForUser(userId: UserId): Promise<number>;
}

const MEMBERSHIP_COLUMNS = "organization_id, user_id, role, created_at";

const STMT = {
	listForUser: `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
		WHERE user_id = $1 ORDER BY organization_id`,
	getForUser: `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
		WHERE user_id = $1 AND organization_id = $2`,
	add: `INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, $3)
		ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role
		RETURNING ${MEMBERSHIP_COLUMNS}`,
	remove: `DELETE FROM memberships
		WHERE organization_id = $1 AND user_id = $2 RETURNING organization_id`,
	countForUser: `SELECT count(*)::int AS total FROM memberships WHERE user_id = $1`,
} as const;

export class PostgresMembershipRepository implements MembershipRepository {
	constructor(private readonly sql: PgSql) {}

	async listForUser(userId: UserId): Promise<MembershipRow[]> {
		const rows = (await this.sql.unsafe(STMT.listForUser, [
			userId,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapMembershipRow);
	}

	async getForUser(
		userId: UserId,
		organizationId: OrganizationId,
	): Promise<MembershipRow | null> {
		const rows = (await this.sql.unsafe(STMT.getForUser, [
			userId,
			organizationId,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapMembershipRow(rows[0]);
	}

	async add(input: {
		organizationId: OrganizationId;
		userId: UserId;
		role: UserRole;
	}): Promise<MembershipRow> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.userId, "userId");
		if (!isUserRole(input.role)) throw new Error("unknown membership role");
		const rows = (await this.sql.unsafe(STMT.add, [
			input.organizationId,
			input.userId,
			input.role,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) throw new Error("membership insert returned no row");
		return mapMembershipRow(rows[0]);
	}

	async remove(input: {
		organizationId: OrganizationId;
		userId: UserId;
	}): Promise<boolean> {
		const rows = (await this.sql.unsafe(STMT.remove, [
			input.organizationId,
			input.userId,
		])) as unknown as Record<string, unknown>[];
		return rows.length > 0;
	}

	async countForUser(userId: UserId): Promise<number> {
		const rows = (await this.sql.unsafe(STMT.countForUser, [
			userId,
		])) as unknown as Record<string, unknown>[];
		const total = rows[0]?.total;
		return typeof total === "number" ? total : 0;
	}
}

export function mapMembershipRow(row: Record<string, unknown>): MembershipRow {
	const role = row.role;
	if (!isUserRole(role))
		throw new Error("stored membership has an unknown role");
	return {
		organization_id: row.organization_id as MembershipRow["organization_id"],
		user_id: row.user_id as MembershipRow["user_id"],
		role,
		created_at: row.created_at as Date,
	};
}
