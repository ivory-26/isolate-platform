import { expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresIncidentRepository } from "./repositories/incident-repository";
import { PostgresRepositoryRepository } from "./repositories/repository-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";

/**
 * Live round-trip for the wave-13 incident surface. Auto-skips without
 * DATABASE_URL and also skips when `0009_incidents.sql` has not been applied
 * yet (the lane never applies migrations; the coordinator does).
 *
 * The suite is deliberately jsonb-free: incident signals are scalar columns, so
 * the pooled-driver jsonb decode defect cannot mask a storage bug here.
 * Every value is a bound parameter and no environment value is printed.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

const RECEIVED_AT = new Date("2026-10-30T12:00:00.000Z");
const FINGERPRINT = "repo:owner/checkout:run:12345";

test.skipIf(!hasDb)(
	"Neon live: incident signal dedupe, bounds and task provenance",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const unique = crypto.randomUUID().slice(0, 8);
		const slug = `live-w13db-${unique}`;
		const otherSlug = `live-w13db-other-${unique}`;
		const email = `live-w13db-${unique}@example.test`;
		const fullName = `live-w13db-${unique}/repo`;
		let orgUuid: string | null = null;
		let otherOrgUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				`SELECT
					to_regclass('public.incident_signals')::text AS signals_table,
					(SELECT count(*)::int FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = 'tasks'
					   AND column_name IN ('incident_source', 'incident_fingerprint')) AS task_columns`,
				[],
			)) as Array<Record<string, unknown>>;
			if (
				ready[0]?.signals_table === null ||
				ready[0]?.signals_table === undefined ||
				Number(ready[0]?.task_columns ?? 0) !== 2
			) {
				return; // 0009 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0].id as string;
			const otherOrgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[otherSlug, otherSlug],
			)) as Array<Record<string, unknown>>;
			otherOrgUuid = otherOrgRows[0].id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "W13-DB Live"],
			)) as Array<Record<string, unknown>>;
			const userId = userRows[0].id as string;
			const orgId = asOrganizationId(orgUuid);
			const otherOrgId = asOrganizationId(otherOrgUuid);

			const repositories = new PostgresRepositoryRepository(sql);
			const createdRepo = await repositories.create({
				organizationId: orgId,
				externalFullName: fullName,
				defaultBranch: "main",
			});
			expect(createdRepo.ok).toBe(true);
			if (!createdRepo.ok) return;
			const repoId = createdRepo.repository.id;

			const incidents = new PostgresIncidentRepository(sql);
			const first = await incidents.recordIfNew({
				organizationId: orgId,
				source: "github",
				kind: "workflow_run.failed",
				severity: "critical",
				service: "checkout",
				fingerprint: FINGERPRINT,
				deliveryId: `delivery-${unique}-1`,
				receivedAt: RECEIVED_AT,
			});
			expect(first.created).toBe(true);

			// Replay inside the bucket: no second row, same id.
			const replay = await incidents.recordIfNew({
				organizationId: orgId,
				source: "github",
				kind: "workflow_run.failed",
				severity: "critical",
				service: "checkout",
				fingerprint: FINGERPRINT,
				deliveryId: `delivery-${unique}-2`,
				receivedAt: new Date(RECEIVED_AT.getTime() + 29 * 60 * 1000),
			});
			expect(replay).toEqual({
				ok: true,
				signalId: first.signalId,
				created: false,
			});
			const countAfterReplay = (await sql.unsafe(
				"SELECT count(*)::int AS n FROM incident_signals WHERE organization_id = $1",
				[orgId],
			)) as Array<Record<string, unknown>>;
			expect(Number(countAfterReplay[0]?.n ?? 0)).toBe(1);

			// The DB itself refuses a duplicate dedupe key (not just the repo).
			let rejected = false;
			try {
				await sql.unsafe(
					`INSERT INTO incident_signals
						(organization_id, source, kind, severity, service, fingerprint, received_at)
					 VALUES ($1, 'github', 'workflow_run.failed', 'critical', 'checkout', $2, $3::timestamptz)`,
					[
						orgId,
						FINGERPRINT,
						new Date(RECEIVED_AT.getTime() + 60 * 1000).toISOString(),
					],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// The next 30-minute bucket is a new signal.
			const nextBucket = await incidents.recordIfNew({
				organizationId: orgId,
				source: "github",
				kind: "workflow_run.failed",
				severity: "critical",
				service: "checkout",
				fingerprint: FINGERPRINT,
				receivedAt: new Date(RECEIVED_AT.getTime() + 31 * 60 * 1000),
			});
			expect(nextBucket.created).toBe(true);
			expect(nextBucket.signalId).not.toBe(first.signalId);

			// Tenant-scoped: the same fingerprint in another org is a new signal.
			const foreign = await incidents.recordIfNew({
				organizationId: otherOrgId,
				source: "github",
				kind: "workflow_run.failed",
				severity: "critical",
				service: "checkout",
				fingerprint: FINGERPRINT,
				receivedAt: RECEIVED_AT,
			});
			expect(foreign.created).toBe(true);

			// DB-level bounds: fingerprint > 128 and an unknown severity fail.
			rejected = false;
			try {
				await sql.unsafe(
					`INSERT INTO incident_signals
						(organization_id, source, kind, severity, service, fingerprint)
					 VALUES ($1, 'github', 'workflow_run.failed', 'critical', 'checkout', $2)`,
					[orgId, "f".repeat(129)],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
			rejected = false;
			try {
				await sql.unsafe(
					`INSERT INTO incident_signals
						(organization_id, source, kind, severity, service, fingerprint)
					 VALUES ($1, 'github', 'workflow_run.failed', 'urgent', 'checkout', 'fp-x')`,
					[orgId],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// Task provenance round-trips; a normal submit stays NULL.
			const tasks = new PostgresTaskRepository(sql);
			const incidentTask = await tasks.create({
				organizationId: orgId,
				repositoryId: repoId,
				branch: `task/live-w13db-${unique}`,
				idempotencyKey: `live-w13db-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				goal: "Fix the failing workflow run",
				incidentSource: "github",
				incidentFingerprint: FINGERPRINT,
				createdBy: userId,
			});
			expect(incidentTask.incident_source).toBe("github");
			expect(incidentTask.incident_fingerprint).toBe(FINGERPRINT);
			const plainTask = await tasks.create({
				organizationId: orgId,
				repositoryId: repoId,
				branch: `task/live-w13db-plain-${unique}`,
				idempotencyKey: `live-w13db-plain-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				createdBy: userId,
			});
			expect(plainTask.incident_source).toBeNull();
			expect(plainTask.incident_fingerprint).toBeNull();

			// Cap count: this tenant, in-window, incident fingerprint, source.
			expect(
				await incidents.countActiveIncidentTasks({
					organizationId: orgId,
					since: new Date(Date.now() - 60 * 60 * 1000),
					sources: ["github"],
				}),
			).toBe(1);
			expect(
				await incidents.countActiveIncidentTasks({
					organizationId: orgId,
					since: new Date(Date.now() + 60 * 1000),
					sources: ["github"],
				}),
			).toBe(0);
			expect(
				await incidents.countActiveIncidentTasks({
					organizationId: otherOrgId,
					since: new Date(Date.now() - 60 * 60 * 1000),
					sources: ["github"],
				}),
			).toBe(0);

			// A retry of an incident task keeps its provenance.
			await tasks.transition({
				taskId: incidentTask.id,
				to: "failed",
				expectedStatus: "queued",
			});
			const retry = await tasks.createRetry({
				organizationId: orgId,
				failedTaskId: incidentTask.id,
				idempotencyKey: `live-w13db-retry-${unique}`,
			});
			expect(retry.ok).toBe(true);
			if (retry.ok) {
				expect(retry.task.incident_source).toBe("github");
				expect(retry.task.incident_fingerprint).toBe(FINGERPRINT);
			}
		} finally {
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM incident_signals WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM incident_signals WHERE organization_id = $1::uuid",
					[otherOrgUuid],
				],
				[
					"DELETE FROM run_events WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				["DELETE FROM tasks WHERE organization_id = $1::uuid", [orgUuid]],
				[
					"DELETE FROM repositories WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				["DELETE FROM users WHERE email = $1", [email]],
				["DELETE FROM organizations WHERE slug = $1", [slug]],
				["DELETE FROM organizations WHERE slug = $1", [otherSlug]],
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
