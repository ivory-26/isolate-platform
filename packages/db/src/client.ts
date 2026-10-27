import type { Sql } from "postgres";
import postgres from "postgres";

/**
 * postgres.js client factory for Neon (ARCHITECTURE.md §5).
 *
 * Owned by @isolate/db; env parsing stays in the app/worker packages — this
 * module takes an explicit URL so tests can use isolated instances and no
 * credential value ever passes through logging paths.
 */
export type PgSql = Sql<Record<string, unknown>>;

export function createDb(
	databaseUrl: string,
	options?: { max?: number; idleTimeout?: number; connectTimeout?: number },
): PgSql {
	return postgres(databaseUrl, {
		// Neon pooled endpoints (pgbouncer transaction mode) do not support
		// named prepared statements — keep prepare:false.
		prepare: false,
		max: options?.max ?? 5,
		idle_timeout: options?.idleTimeout ?? 30,
		connect_timeout: options?.connectTimeout ?? 10,
		onnotice: () => undefined,
	});
}
