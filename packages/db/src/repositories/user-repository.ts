import type { UserId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { UserRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Platform users.
 *
 * The row id is the authenticated identity's id: Neon Managed Better Auth
 * issues uuid user ids, so `public.users.id` is the session's user id and no
 * separate identity table is needed. `ensure` therefore upserts by id.
 */
export interface UserRepository {
	/**
	 * Insert-or-update the platform user for an authenticated identity.
	 *
	 * The email unique constraint is the guard against two identities claiming
	 * the same address: a conflicting email belonging to another id raises and
	 * the caller fails closed instead of merging the two accounts.
	 */
	ensure(input: {
		id: UserId;
		email: string;
		displayName: string;
	}): Promise<UserRow>;
	getById(id: UserId): Promise<UserRow | null>;
}

const STMT = {
	upsert: `INSERT INTO users (id, email, display_name)
	VALUES ($1, $2, $3)
	ON CONFLICT (id) DO UPDATE
	SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
	RETURNING id, email, display_name, created_at`,
	get: `SELECT id, email, display_name, created_at FROM users WHERE id = $1`,
} as const;

export class PostgresUserRepository implements UserRepository {
	constructor(private readonly sql: PgSql) {}

	async ensure(input: {
		id: UserId;
		email: string;
		displayName: string;
	}): Promise<UserRow> {
		requireNonEmpty(input.id, "id");
		requireNonEmpty(input.email, "email");
		requireNonEmpty(input.displayName, "displayName");
		const rows = (await this.sql.unsafe(STMT.upsert, [
			input.id,
			input.email,
			input.displayName,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) throw new Error("user upsert returned no row");
		return mapUserRow(rows[0]);
	}

	async getById(id: UserId): Promise<UserRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [id])) as unknown as Record<
			string,
			unknown
		>[];
		return rows.length === 0 ? null : mapUserRow(rows[0]);
	}
}

function mapUserRow(row: Record<string, unknown>): UserRow {
	return {
		id: row.id as UserRow["id"],
		email: row.email as string,
		display_name: row.display_name as string,
		created_at: row.created_at as Date,
	};
}
