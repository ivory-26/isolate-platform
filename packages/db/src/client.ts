import type { Sql } from "postgres";
import postgres from "postgres";

/**
 * Tiny postgres.js client factory for Neon.
 *
 * Design notes:
 * - Takes an explicit connection URL; env parsing stays in the app/worker
 *   packages so this module never reads (or logs) credential values.
 * - `prepare: false` is mandatory here: Neon pooled endpoints run PgBouncer in
 *   transaction mode, which cannot pin named prepared statements.
 * - Defaults are small and bounded so a forgotten `sql.end()` is a grown
 *   connection pool, not an unbounded one.
 */
export type PgSql = Sql<Record<string, unknown>>;

export type DbClientOptions = {
	max?: number;
	idleTimeout?: number;
	connectTimeout?: number;
};

const pool = {
	max: 5,
	idleTimeout: 30,
	connectTimeout: 10,
} as const;

export function createDb(
	databaseUrl: string,
	options: DbClientOptions = {},
): PgSql {
	if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
		throw new Error("createDb requires a non-empty PostgreSQL URL");
	}
	return postgres(databaseUrl, {
		prepare: false,
		max: options.max ?? pool.max,
		idle_timeout: options.idleTimeout ?? pool.idleTimeout,
		connect_timeout: options.connectTimeout ?? pool.connectTimeout,
		// Notices are noise in our logs; errors still surface as rejections.
		onnotice: () => undefined,
	});
}
