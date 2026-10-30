import { expect, test } from "bun:test";
import { asOrganizationId, asRepositoryId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresBranchLockRepository } from "./repositories/branch-lock-repository";
import { PostgresRepositoryRepository } from "./repositories/repository-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";

/**
 * Live suite for the wave-9 acceptance contract and the branch row lease.
 * Auto-skips without DATABASE_URL and cleanly skips when
 * `0007_acceptance_contract.sql` has not been applied (this lane never applies
 * migrations; the coordinator does).
 *
 * The branch-lock case runs on ANY endpoint, including Neon's `-pooler` host:
 * the lease is a table row manipulated by single statements, so PgBouncer
 * transaction pooling cannot split acquire/release across backends.
 *
 * Every value is a bound parameter and no environment value is printed.
 */
const databaseUrl = process.env.DATABASE_URL;
const hasDb = typeof databaseUrl === "string" && databaseUrl.length > 0;

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
 * The row lease has no session state, so this runs against pooled and direct
 * endpoints alike (no `-pooler` skip). Two independent clients prove that a
 * second CONNECTION cannot take a live lease. "Elapsed time" is simulated by
 * moving `expires_at` into the past, so the case never sleeps.
 */
test.skipIf(!hasDb)(
	"Neon live: branch row lease is exclusive per triple and owner-guarded",
	async () => {
		const url = databaseUrl;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sqlA = createDb(url, { max: 2 });
		const sqlB = createDb(url, { max: 2 });
		const organizationId = asOrganizationId(crypto.randomUUID());
		const repositoryId = asRepositoryId(crypto.randomUUID());
		const branch = `task/lock-${crypto.randomUUID().slice(0, 8)}`;
		const releases: Array<() => Promise<void>> = [];

		try {
			const ready = (await sqlA.unsafe(
				`SELECT
					to_regclass('public.branch_locks') IS NOT NULL AS table_present,
					to_regclass('public.branch_locks_expires_at_idx') IS NOT NULL AS index_present`,
				[],
			)) as Array<Record<string, unknown>>;
			if (ready[0]?.table_present !== true) {
				return; // 0007 not applied: clean skip
			}
			// The expiry-sweep index is part of the contract.
			expect(ready[0]?.index_present).toBe(true);

			const locksA = new PostgresBranchLockRepository(sqlA);
			const locksB = new PostgresBranchLockRepository(sqlB);
			const acquire = (lockRepo: PostgresBranchLockRepository) =>
				lockRepo.acquire({
					organizationId,
					repositoryId,
					branch,
					ttlMs: 60_000,
				});

			const first = await acquire(locksA);
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			releases.push(first.release);

			// A different pooled connection cannot take the live lease.
			expect(await acquire(locksB)).toEqual({ ok: false, code: "LOCKED" });

			// A different branch on the same repository is free.
			const otherBranch = await locksB.acquire({
				organizationId,
				repositoryId,
				branch: `${branch}-other`,
				ttlMs: 60_000,
			});
			expect(otherBranch.ok).toBe(true);
			if (otherBranch.ok) releases.push(otherBranch.release);

			// Simulate lease expiry, then take over from the second client.
			await sqlA.unsafe(
				`UPDATE branch_locks SET expires_at = now() - interval '1 second'
				 WHERE organization_id = $1::uuid
				   AND repository_id = $2::uuid
				   AND branch = $3`,
				[organizationId, repositoryId, branch],
			);
			const takeover = await acquire(locksB);
			expect(takeover.ok).toBe(true);
			if (!takeover.ok) return;
			releases.push(takeover.release);

			// Wrong-owner release is a no-op: the old holder must not delete
			// the lease that was handed to the new owner.
			await first.release();
			expect(await acquire(locksA)).toEqual({ ok: false, code: "LOCKED" });

			// Release is idempotent and frees the triple for the next caller.
			await takeover.release();
			await takeover.release();
			const reacquired = await acquire(locksA);
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
			try {
				await sqlA.unsafe(
					`DELETE FROM branch_locks
					 WHERE organization_id = $1::uuid AND repository_id = $2::uuid`,
					[organizationId, repositoryId],
				);
			} catch {
				// Table may be absent: nothing to clean.
			}
			await sqlA.end({ timeout: 5 });
			await sqlB.end({ timeout: 5 });
		}
	},
	120000,
);
