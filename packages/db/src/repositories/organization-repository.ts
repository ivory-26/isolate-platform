import type { OrganizationId, UserId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { OrganizationRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Organizations (tenants).
 *
 * Creating an organization also creates its owner's membership in the same
 * transaction: an organization without an owner is unreachable, and a
 * membership without its organization is meaningless.
 */
export interface OrganizationRepository {
	/** Create an organization and its owner membership atomically. */
	createWithOwner(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow>;
	/**
	 * Create an organization only when the owner has no membership yet.
	 *
	 * Returns null when the user already belongs to an organization. The check
	 * and the insert share one transaction, so two concurrent first logins
	 * cannot both create a personal workspace.
	 */
	createIfUnowned(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow | null>;
	getById(id: OrganizationId): Promise<OrganizationRow | null>;
	getBySlug(slug: string): Promise<OrganizationRow | null>;
}

const ORGANIZATION_COLUMNS = "id, name, slug, created_at";

const STMT = {
	insert: `INSERT INTO organizations (id, name, slug)
		VALUES ($1, $2, $3) RETURNING ${ORGANIZATION_COLUMNS}`,
	insertMembership: `INSERT INTO memberships (organization_id, user_id, role)
		VALUES ($1, $2, 'owner')
		ON CONFLICT (organization_id, user_id) DO NOTHING`,
	hasMembership: `SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1`,
	get: `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = $1`,
	getBySlug: `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE slug = $1`,
} as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class PostgresOrganizationRepository implements OrganizationRepository {
	constructor(private readonly sql: PgSql) {}

	async createWithOwner(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow> {
		validateOrganizationInput(input);
		return this.sql.begin<OrganizationRow>(async (transaction) => {
			const connection = transaction as unknown as PgSql;
			return insertOrganization(connection, input);
		});
	}

	async createIfUnowned(input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	}): Promise<OrganizationRow | null> {
		validateOrganizationInput(input);
		return this.sql.begin<OrganizationRow | null>(async (transaction) => {
			const connection = transaction as unknown as PgSql;
			const existing = (await connection.unsafe(STMT.hasMembership, [
				input.ownerId,
			])) as unknown as Record<string, unknown>[];
			if (existing.length > 0) return null;
			return insertOrganization(connection, input);
		});
	}

	async getById(id: OrganizationId): Promise<OrganizationRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [id])) as unknown as Record<
			string,
			unknown
		>[];
		return rows.length === 0 ? null : mapOrganizationRow(rows[0]);
	}

	async getBySlug(slug: string): Promise<OrganizationRow | null> {
		const rows = (await this.sql.unsafe(STMT.getBySlug, [
			slug,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapOrganizationRow(rows[0]);
	}
}

async function insertOrganization(
	connection: PgSql,
	input: {
		id: OrganizationId;
		name: string;
		slug: string;
		ownerId: UserId;
	},
): Promise<OrganizationRow> {
	const rows = (await connection.unsafe(STMT.insert, [
		input.id,
		input.name,
		input.slug,
	])) as unknown as Record<string, unknown>[];
	if (rows.length === 0) throw new Error("organization insert returned no row");
	await connection.unsafe(STMT.insertMembership, [input.id, input.ownerId]);
	return mapOrganizationRow(rows[0]);
}

function validateOrganizationInput(input: {
	id: OrganizationId;
	name: string;
	slug: string;
	ownerId: UserId;
}): void {
	requireNonEmpty(input.id, "id");
	requireNonEmpty(input.name, "name");
	requireNonEmpty(input.slug, "slug");
	requireNonEmpty(input.ownerId, "ownerId");
	if (input.name.length > 120)
		throw new Error("name must be at most 120 characters");
	if (input.slug.length > 64)
		throw new Error("slug must be at most 64 characters");
	if (!SLUG_PATTERN.test(input.slug))
		throw new Error("slug must be lowercase alphanumeric segments");
}

export function mapOrganizationRow(
	row: Record<string, unknown>,
): OrganizationRow {
	return {
		id: row.id as OrganizationRow["id"],
		name: row.name as string,
		slug: row.slug as string,
		created_at: row.created_at as Date,
	};
}
