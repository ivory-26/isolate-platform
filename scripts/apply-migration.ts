/**
 * Applies packages/db/migrations/*.sql against DATABASE_URL using the app's
 * own bounded client. Statements are split on line-anchored semicolons (DDL
 * only); every statement is static — no value interpolation, ever.
 *
 * Usage: bun --env-file ../isolate/.env scripts/apply-migration.ts
 * (path to the env file is relative to the caller; never print variables)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "../packages/db/src/client";
import { createConsoleLogger } from "../packages/shared/src";

const logger = createConsoleLogger("migrations");
const url = process.env.DATABASE_URL;
if (!url || url.trim().length === 0) {
	logger.error("DATABASE_URL is not set; refusing to run.");
	process.exit(1);
}

const migrationsDir = "packages/db/migrations";
const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

const sql = createDb(url);
try {
	for (const file of files) {
		const raw = readFileSync(join(migrationsDir, file), "utf8");
		// Build statements line-by-line so inline `--` comments stay attached,
		// and only split where a semicolon terminates the last token on a line.
		let current = "";
		const statements: string[] = [];
		for (const line of raw.split(/\r?\n/)) {
			current += `${line}\n`;
			if (line.trimEnd().endsWith(";")) {
				const trimmed = current.trim();
				// Skip statements that are comments-only (still idempotent run).
				const withoutComments = trimmed
					.split(/\r?\n/)
					.filter((l) => !l.trimStart().startsWith("--"))
					.join("\n")
					.trim();
				if (withoutComments.length > 0) statements.push(trimmed);
				current = "";
			}
		}
		const tail = current.trim();
		if (tail.length > 0 && !tail.split(/\r?\n/).every((l) => l.trimStart().startsWith("--"))) {
			statements.push(tail);
		}
		logger.info(`applying ${file} — ${statements.length} statements`);
		for (const statement of statements) {
			await sql.unsafe(statement);
		}
	}
	const applied = await sql.unsafe(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = 'public' AND table_name IN
		 ('organizations','users','memberships','repositories','integrations',
		 'integration_permissions','workflow_definitions','workflow_versions','tasks','task_attempts',
		 'workflow_runs','run_events','artifacts','approvals','tool_invocations','audit_events',
		 'usage_records','jobs','compiled_plans','rejection_issues')
		 ORDER BY table_name`,
	);
	logger.info(`tables verified: ${Array.isArray(applied) ? applied.length : "?"} of 20 planned`);
} finally {
	sql.end({ timeout: 5 });
}
