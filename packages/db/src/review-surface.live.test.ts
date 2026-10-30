import { expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresApprovalRepository } from "./repositories/approval-repository";
import { PostgresRepositoryRepository } from "./repositories/repository-repository";
import { PostgresRunEventRepository } from "./repositories/run-event-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";

/**
 * Live round-trip for the wave-8 review surface. Auto-skips without
 * DATABASE_URL and also skips when `0006_review_surface.sql` has not been
 * applied yet (the lane never applies migrations; the coordinator does).
 *
 * Every value is a bound parameter and no environment value is printed.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

const SHA = "a".repeat(64);

test.skipIf(!hasDb)(
	"Neon live: validation policy, retry linkage, approval decision, run events",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const unique = crypto.randomUUID().slice(0, 8);
		const slug = `live-w8db-${unique}`;
		const email = `live-w8db-${unique}@example.test`;
		const fullName = `live-w8db-${unique}/repo`;
		let orgUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				`SELECT
					(SELECT count(*)::int FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = 'repositories'
					   AND column_name IN ('validation_command', 'validation_timeout_ms')) AS repo_columns,
					(SELECT count(*)::int FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = 'tasks'
					   AND column_name IN ('pull_request_number', 'pull_request_url', 'retry_of', 'retry_depth')) AS task_columns,
					(SELECT pg_get_constraintdef(oid) FROM pg_constraint
					 WHERE conname = 'jobs_type_check') AS jobs_check`,
				[],
			)) as Array<Record<string, unknown>>;
			if (
				Number(ready[0]?.repo_columns ?? 0) !== 2 ||
				Number(ready[0]?.task_columns ?? 0) !== 4 ||
				!String(ready[0]?.jobs_check ?? "").includes("create_pull_request")
			) {
				return; // 0006 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0].id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "W8-DB Live"],
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
			const repoId = created.repository.id;
			expect(created.repository.validation_command).toBeNull();
			expect(created.repository.validation_timeout_ms).toBe(300000);

			// Policy round-trip: the pure helper trims before the write.
			expect(
				await repositories.setValidationPolicy({
					organizationId: orgId,
					repositoryId: repoId,
					validationCommand: "  bun test  ",
					validationTimeoutMs: 120000,
				}),
			).toMatchObject({
				validation_command: "bun test",
				validation_timeout_ms: 120000,
			});
			expect(
				(
					await repositories.get({
						organizationId: orgId,
						repositoryId: repoId,
					})
				)?.validation_command,
			).toBe("bun test");

			// DB-level bounds: 513 chars and a 999 ms timeout are rejected.
			let rejected = false;
			try {
				await sql.unsafe(
					"UPDATE repositories SET validation_command = $1 WHERE id = $2",
					["x".repeat(513), repoId],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
			rejected = false;
			try {
				await sql.unsafe(
					"UPDATE repositories SET validation_timeout_ms = 999 WHERE id = $1",
					[repoId],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// Task defaults: no PR, no retry linkage.
			const tasks = new PostgresTaskRepository(sql);
			const source = await tasks.create({
				organizationId: orgId,
				repositoryId: repoId,
				branch: `task/live-${unique}`,
				idempotencyKey: `live-w8db-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				goal: "Fix the failing live test",
				acceptanceCriteria: ["bun test passes", "no unowned writes"],
				fileOwnership: ["src/**"],
				createdBy: userId,
			});
			expect(source.retry_of).toBeNull();
			expect(source.retry_depth).toBe(0);
			expect(source.pull_request_number).toBeNull();
			expect(source.pull_request_url).toBeNull();
			expect(source.acceptance_criteria).toEqual([
				"bun test passes",
				"no unowned writes",
			]);

			// PR URL CHECK: 513 chars are rejected, 512 are accepted.
			rejected = false;
			try {
				await sql.unsafe(
					"UPDATE tasks SET pull_request_url = repeat('x', 513) WHERE id = $1",
					[source.id],
				);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
			await sql.unsafe(
				"UPDATE tasks SET pull_request_number = 1, pull_request_url = repeat('x', 512) WHERE id = $1",
				[source.id],
			);
			const withPr = await tasks.get(source.id);
			expect(withPr?.pull_request_number).toBe(1);
			expect(withPr?.pull_request_url?.length).toBe(512);

			// Rerun: only a failed source, and the boundary is reproduced.
			await tasks.transition({
				taskId: source.id,
				to: "failed",
				expectedStatus: "queued",
			});
			const retryInput = {
				organizationId: orgId,
				failedTaskId: source.id,
				idempotencyKey: `rerun-${unique}`,
			};
			const retry = await tasks.createRetry(retryInput);
			expect(retry.ok).toBe(true);
			if (!retry.ok) return;
			expect(retry.created).toBe(true);
			expect(retry.task).toMatchObject({
				status: "queued",
				retry_of: source.id,
				retry_depth: 1,
				repository_id: source.repository_id,
				goal: source.goal,
				created_by: source.created_by,
				branch: `${source.branch}-retry-1`,
				pull_request_number: null,
				pull_request_url: null,
			});
			expect(retry.task.acceptance_criteria).toEqual(
				source.acceptance_criteria,
			);
			expect(retry.task.file_ownership).toEqual(source.file_ownership);
			expect(retry.task.budget_limits).toEqual(source.budget_limits);

			const replay = await tasks.createRetry(retryInput);
			expect(replay.ok).toBe(true);
			if (replay.ok) {
				expect(replay.created).toBe(false);
				expect(replay.task.id).toBe(retry.task.id);
			}
			expect(
				await tasks.createRetry({
					organizationId: orgId,
					failedTaskId: retry.task.id,
					idempotencyKey: `rerun-second-${unique}`,
				}),
			).toEqual({ ok: false, code: "CONFLICT" });
			expect(
				await tasks.createRetry({
					organizationId: asOrganizationId(crypto.randomUUID()),
					failedTaskId: source.id,
					idempotencyKey: `rerun-foreign-${unique}`,
				}),
			).toEqual({ ok: false, code: "NOT_FOUND" });

			// Depth CHECK: the DB refuses depth 4 even on a direct write.
			rejected = false;
			try {
				await sql.unsafe("UPDATE tasks SET retry_depth = 4 WHERE id = $1", [
					retry.task.id,
				]);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);

			// jobs_type_check accepts the new PR job type.
			const job = (await sql.unsafe(
				`INSERT INTO jobs (organization_id, task_id, type, max_attempts, enqueue_uuid_key)
				 VALUES ($1, $2, 'create_pull_request', 1, $3) RETURNING id`,
				[orgId, source.id, `live-w8db-job-${unique}`],
			)) as Array<Record<string, unknown>>;
			expect(job).toHaveLength(1);

			// Approval decision: tenant-scoped, pending-only, audited.
			const approvals = new PostgresApprovalRepository(sql);
			const approval = await approvals.request({
				organizationId: orgId,
				taskId: source.id,
				workflowRunId: null,
				action: "github.create_pull_request",
				payloadSha256: SHA,
				requestedBy: "worker",
				expiresInSeconds: 300,
			});
			expect(
				(
					await approvals.listByTask({
						organizationId: orgId,
						taskId: source.id,
					})
				).map((row) => row.id),
			).toContain(approval.id);
			expect(
				await approvals.listByTask({
					organizationId: asOrganizationId(crypto.randomUUID()),
					taskId: source.id,
				}),
			).toEqual([]);

			const decided = await approvals.decide({
				organizationId: orgId,
				taskId: source.id,
				approvalId: approval.id,
				expectedStatus: "pending",
				decision: "approved",
				decidedBy: userId,
			});
			expect(decided.ok).toBe(true);
			if (decided.ok) {
				expect(decided.approval.status).toBe("approved");
				expect(decided.approval.decided_by).toBe(userId);
			}
			expect(
				await approvals.decide({
					organizationId: orgId,
					taskId: source.id,
					approvalId: approval.id,
					expectedStatus: "pending",
					decision: "rejected",
					decidedBy: userId,
				}),
			).toEqual({ ok: false, code: "CONFLICT" });
			expect(
				await approvals.decide({
					organizationId: orgId,
					taskId: retry.task.id,
					approvalId: approval.id,
					expectedStatus: "pending",
					decision: "approved",
					decidedBy: userId,
				}),
			).toEqual({ ok: false, code: "NOT_FOUND" });
			const audit = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM audit_events
				 WHERE organization_id = $1 AND target = $2 AND action = 'approval.decide'`,
				[orgId, `approval:${approval.id}`],
			)) as Array<Record<string, unknown>>;
			expect(Number(audit[0]?.n ?? 0)).toBe(1);

			// Run events: oldest-first, tenant-scoped through the task join.
			await sql.unsafe(
				`INSERT INTO run_events (task_id, workflow_run_id, type, actor, data, occurred_at)
				 VALUES ($1, NULL, 'task.retried', 'worker', $2::text::jsonb, now()),
				        ($1, NULL, 'task.enqueued', 'worker', $2::text::jsonb, now() + interval '1 millisecond')`,
				[retry.task.id, JSON.stringify({ sourceTaskId: source.id })],
			);
			const runEvents = new PostgresRunEventRepository(sql);
			const timeline = await runEvents.listByTask({
				organizationId: orgId,
				taskId: retry.task.id,
			});
			expect(timeline.map((row) => row.type)).toEqual([
				"task.retried",
				"task.enqueued",
			]);
			expect(timeline[0].data).toEqual({ sourceTaskId: source.id });
			expect(
				await runEvents.listByTask({
					organizationId: asOrganizationId(crypto.randomUUID()),
					taskId: retry.task.id,
				}),
			).toEqual([]);
			expect(
				await runEvents.listByTask({
					organizationId: orgId,
					taskId: retry.task.id,
					limit: 1,
				}),
			).toHaveLength(1);
		} finally {
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM audit_events WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				["DELETE FROM approvals WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM jobs WHERE organization_id = $1::uuid", [orgUuid]],
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
				["DELETE FROM tasks WHERE organization_id = $1::uuid", [orgUuid]],
				[
					"DELETE FROM repositories WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				["DELETE FROM memberships WHERE organization_id = $1::uuid", [orgUuid]],
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
