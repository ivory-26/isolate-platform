import { expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresArtifactRepository } from "./repositories/artifact-repository";
import { PostgresExecutionLifecycle } from "./repositories/execution-lifecycle";
import { PostgresRepositoryRepository } from "./repositories/repository-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";

/**
 * Live round-trip for wave-7 execution truth. Auto-skips without DATABASE_URL
 * and also skips when `0005_execution_truth.sql` has not been applied yet
 * (the lane never applies migrations; the coordinator does).
 *
 * No value from the environment is printed; every value is a bound parameter.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

const SHA = "e".repeat(64);
const unique = crypto.randomUUID().slice(0, 8);
const NOW = Date.now;

test.skipIf(!hasDb)(
	"Neon live: repository onboarding + execution lifecycle round-trip",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const slug = `live-w7db-${unique}`;
		const email = `live-w7db-${unique}@example.test`;
		const fullName = `live-w7db-${unique}/repo`;
		let orgUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				`SELECT
					to_regclass('public.tasks') AS tasks,
					to_regclass('public.artifacts') AS artifacts,
					to_regclass('public.approvals_pending_task_action_unique') AS pending_index,
					(SELECT count(*)::int FROM information_schema.columns
					 WHERE table_schema = 'public' AND table_name = 'artifacts'
					   AND column_name = 'content') AS content_column`,
				[],
			)) as Array<Record<string, unknown>>;
			if (
				!ready[0]?.tasks ||
				!ready[0]?.artifacts ||
				!ready[0]?.pending_index ||
				Number(ready[0]?.content_column ?? 0) !== 1
			) {
				return; // 0005 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0].id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "W7-DB Live"],
			)) as Array<Record<string, unknown>>;
			const orgId = asOrganizationId(orgUuid);

			const repositories = new PostgresRepositoryRepository(sql);
			const created = await repositories.create({
				organizationId: orgId,
				externalFullName: fullName,
				defaultBranch: "main",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(
				await repositories.create({
					organizationId: orgId,
					externalFullName: fullName,
					defaultBranch: "release",
				}),
			).toEqual({ ok: false, code: "CONFLICT" });
			expect(
				await repositories.get({
					organizationId: orgId,
					repositoryId: created.repository.id,
				}),
			).toMatchObject({ external_full_name: fullName, default_branch: "main" });

			const tasks = new PostgresTaskRepository(sql);
			const task = await tasks.create({
				organizationId: orgId,
				repositoryId: created.repository.id,
				branch: `task/live-${unique}`,
				idempotencyKey: `live-w7db-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 1,
					maxDurationMs: 600000,
				},
				createdBy: userRows[0].id as string,
			});

			const lifecycle = new PostgresExecutionLifecycle(sql);
			await lifecycle.transition({
				organizationId: orgId,
				taskId: task.id,
				from: "queued",
				to: "planning",
				actor: "worker",
			});
			await lifecycle.event({
				organizationId: orgId,
				taskId: task.id,
				workflowRunId: null,
				type: "workspace.cloned",
				actor: "worker",
				data: { branch: task.branch, nested: { ok: true } },
			});
			const artifact = await lifecycle.artifact({
				organizationId: orgId,
				taskId: task.id,
				kind: "diff",
				contentType: "text/x-diff",
				content: "+live\n",
				sha256: SHA,
			});
			const artifacts = new PostgresArtifactRepository(sql);
			const listed = await artifacts.listByTask({
				organizationId: orgId,
				taskId: task.id,
			});
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({
				id: artifact.artifactId,
				sha256: SHA,
				storage_ref: `inline:${SHA}`,
				content: "+live\n",
				byte_size: 6,
			});

			const attempt = await lifecycle.attemptStarted({
				organizationId: orgId,
				taskId: task.id,
				workflowRunId: null,
			});
			expect(attempt.attemptIndex).toBe(1);
			await lifecycle.attemptFinished({
				organizationId: orgId,
				taskId: task.id,
				attemptId: attempt.attemptId,
				outcome: { kind: "execution", notes: "live" },
			});

			const approval = await lifecycle.approvalRequested({
				organizationId: orgId,
				taskId: task.id,
				workflowRunId: null,
				action: "git.push_branch",
				payloadSha256: SHA,
				requestedBy: "worker",
				expiresAt: new Date(NOW() + 60000),
			});
			const duplicate = await lifecycle.approvalRequested({
				organizationId: orgId,
				taskId: task.id,
				workflowRunId: null,
				action: "git.push_branch",
				payloadSha256: "f".repeat(64),
				requestedBy: "worker",
				expiresAt: new Date(NOW() + 120000),
			});
			expect(duplicate.approvalId).toBe(approval.approvalId);
			expect(
				await lifecycle.approvalStatus({
					organizationId: orgId,
					taskId: task.id,
					approvalId: approval.approvalId,
				}),
			).toEqual({ status: "pending", payloadSha256: SHA });

			expect(
				await lifecycle.isCancelled({ organizationId: orgId, taskId: task.id }),
			).toBe(false);
			await lifecycle.transition({
				organizationId: orgId,
				taskId: task.id,
				from: "planning",
				to: "cancelled",
				actor: "user",
			});
			expect(
				await lifecycle.isCancelled({ organizationId: orgId, taskId: task.id }),
			).toBe(true);
		} finally {
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM run_events WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
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
