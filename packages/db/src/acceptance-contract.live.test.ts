import { expect, test } from "bun:test";
import { asOrganizationId, asRepositoryId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresBranchLockRepository } from "./repositories/branch-lock-repository";
import { PostgresRepositoryRepository } from "./repositories/repository-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";

/**
 * Live suite for the wave-9 acceptance contract and branch advisory lock.
 * Auto-skips without DATABASE_URL and cleanly skips when
 * `0007_acceptance_contract.sql` has not been applied (this lane never applies
 * migrations; the coordinator does).
 *
 * Every value is a bound parameter and no environment value is printed.
 */
const databaseUrl = process.env.DATABASE_URL;
const hasDb = typeof databaseUrl === "string" && databaseUrl.length > 0;

/** Session advisory locks require a direct endpoint, not PgBouncer pooling. */
const pooledEndpoint = (() => {
	if (!hasDb || !databaseUrl) return false;
	try {
		return /-pooler\./.test(new URL(databaseUrl).hostname);
	} catch {
		return false;
	}
})();

const CHECKS = [
	{ kind: "path_exists", path: "LIVE_ACCEPTANCE.md" },
	{ kind: "content_matches", path: "README.md", pattern: "^# " },
	{ kind: "command_exit_zero", command: "bun test" },
] as const;

test.skipIf(!hasDb)(
	"Neon live: acceptance checks round-trip and the DB enforces array <= 32",
	async () => {
		const url = databaseUrl;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const unique = crypto.randomUUID().slice(0, 8);
		const slug = `live-w9db-${unique}`;
		const email = `live-w9db-${unique}@example.test`;
		const fullName = `live-w9db-${unique}/repo`;
		let orgUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				`SELECT
					(SELECT count(*)::int FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = 'tasks'
					   AND column_name = 'acceptance_checks') AS column_present,
					(SELECT pg_get_constraintdef(oid) FROM pg_constraint
					 WHERE conname = 'tasks_acceptance_checks_array_check') AS check_def`,
				[],
			)) as Array<Record<string, unknown>>;
			if (
				Number(ready[0]?.column_present ?? 0) !== 1 ||
				!String(ready[0]?.check_def ?? "").includes("jsonb_array_length")
			) {
				return; // 0007 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0].id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "W9-DB Live"],
			)) as Array<Record<string, unknown>>;
			const userId = userRows[0].id as string;
			const orgId = asOrganizationId(orgUuid);

			const repositories = new PostgresRepositoryRepository(sql);
			const created = await repositories.create({
				organizationId: orgId,
				externalFullName: fullName,
				defaultBranch: "main",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const repoId = asRepositoryId(created.repository.id);

			const tasks = new PostgresTaskRepository(sql);
			const task = await tasks.create({
				organizationId: orgId,
				repositoryId: repoId,
				branch: `task/live-w9db-${unique}`,
				idempotencyKey: `live-w9db-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				goal: "Prove completion from the environment",
				acceptanceCriteria: ["acceptance checks pass"],
				acceptanceChecks: [...CHECKS],
				fileOwnership: ["src/**"],
				createdBy: userId,
			});
			expect(task.acceptance_checks).toEqual([...CHECKS]);
			expect((await tasks.get(task.id))?.acceptance_checks).toEqual([
				...CHECKS,
			]);

			// DB-level JSON type: array, not a double-encoded jsonb string.
			const stored = (await sql.unsafe(
				`SELECT jsonb_typeof(acceptance_checks) AS kind,
				        jsonb_array_length(acceptance_checks) AS length,
				        acceptance_checks->0->>'kind' AS first_kind
				 FROM tasks WHERE id = $1`,
				[task.id],
			)) as Array<Record<string, unknown>>;
			expect(stored[0]?.kind).toBe("array");
			expect(Number(stored[0]?.length)).toBe(CHECKS.length);
			expect(stored[0]?.first_kind).toBe("path_exists");

			// A task created without checks stores the default empty array.
			const plain = await tasks.create({
				organizationId: orgId,
				repositoryId: repoId,
				branch: `task/live-w9db-plain-${unique}`,
				idempotencyKey: `live-w9db-plain-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				createdBy: userId,
			});
			expect(plain.acceptance_checks).toEqual([]);
			const plainStored = (await sql.unsafe(
				`SELECT jsonb_typeof(acceptance_checks) AS kind,
				        jsonb_array_length(acceptance_checks) AS length
				 FROM tasks WHERE id = $1`,
				[plain.id],
			)) as Array<Record<string, unknown>>;
			expect(plainStored[0]?.kind).toBe("array");
			expect(Number(plainStored[0]?.length)).toBe(0);

			// CHECK: a jsonb object (not an array) is refused at the DB.
			let rejected = false;
			try {
				await sql.unsafe(
					"UPDATE tasks SET acceptance_checks = '{}'::jsonb WHERE id = $1",
					[task.id],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// CHECK: 33 entries are refused; exactly 32 are accepted.
			rejected = false;
			try {
				await sql.unsafe(
					`UPDATE tasks
					 SET acceptance_checks = (
						SELECT jsonb_agg(jsonb_build_object('kind', 'path_exists', 'path', 'a'))
						FROM generate_series(1, 33)
					 ) WHERE id = $1`,
					[task.id],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			await sql.unsafe(
				`UPDATE tasks
				 SET acceptance_checks = (
					SELECT jsonb_agg(jsonb_build_object('kind', 'path_exists', 'path', 'a'))
					FROM generate_series(1, 32)
				 ) WHERE id = $1`,
				[task.id],
			);
			expect((await tasks.get(task.id))?.acceptance_checks).toHaveLength(32);
		} finally {
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM run_events WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM artifacts WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				["DELETE FROM jobs WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM tasks WHERE organization_id = $1::uuid", [orgUuid]],
				[
					"DELETE FROM repositories WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				["DELETE FROM users WHERE email = $1", [email]],
				["DELETE FROM organizations WHERE slug = $1", [slug]],
			];
			for (const [statement, params] of teardown) {
				try {
					await sql.unsafe(statement, params);
				} catch {
					// Best effort only; cleanup must not mask the test failure.
				}
			}
			await sql.end({ timeout: 5 });
		}
	},
	120000,
);

/**
 * Session advisory locks are only coherent on a direct connection. On Neon's
 * pooled host (`-pooler`) PgBouncer transaction pooling can route the unlock
 * to a different backend, so this case is skipped there rather than producing
 * a false failure. See the repository doc comment.
 */
test.skipIf(!hasDb || pooledEndpoint)(
	"Neon live: branch advisory lock is exclusive per triple (direct endpoint)",
	async () => {
		const url = databaseUrl;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 3 });
		const organizationId = asOrganizationId(crypto.randomUUID());
		const repositoryId = asRepositoryId(crypto.randomUUID());
		const branch = `task/lock-${crypto.randomUUID().slice(0, 8)}`;
		const releases: Array<() => Promise<void>> = [];

		try {
			const locks = new PostgresBranchLockRepository(sql);
			const first = await locks.acquire({
				organizationId,
				repositoryId,
				branch,
			});
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			releases.push(first.release);

			// Same triple, second caller: exclusive.
			expect(
				await locks.acquire({ organizationId, repositoryId, branch }),
			).toEqual({ ok: false, code: "LOCKED" });

			// A different branch on the same repository is free.
			const otherBranch = await locks.acquire({
				organizationId,
				repositoryId,
				branch: `${branch}-other`,
			});
			expect(otherBranch.ok).toBe(true);
			if (otherBranch.ok) releases.push(otherBranch.release);

			// Release is idempotent and frees the triple for the next caller.
			await first.release();
			await first.release();
			const reacquired = await locks.acquire({
				organizationId,
				repositoryId,
				branch,
			});
			expect(reacquired.ok).toBe(true);
			if (reacquired.ok) releases.push(reacquired.release);
		} finally {
			for (const release of releases.reverse()) {
				try {
					await release();
				} catch {
					// Best effort; never mask the assertion failure.
				}
			}
			await sql.end({ timeout: 5 });
		}
	},
	120000,
);
