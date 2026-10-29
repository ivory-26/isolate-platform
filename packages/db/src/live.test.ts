import { expect, test } from "bun:test";
import { asOrganizationId } from "@isolate/shared";
import { createDb } from "./client";
import { PostgresApprovalRepository } from "./repositories/approval-repository";
import { PostgresQueueRepository } from "./repositories/queue-repository";
import { PostgresTaskContextRepository } from "./repositories/task-context-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";
import { PostgresUsageRepository } from "./repositories/usage-repository";
import type { ApprovalRow, TaskRow } from "./schema";

/**
 * Live round-trip against a real Neon instance. Auto-skips without
 * DATABASE_URL; the coordinator owns the migration apply step, so these
 * tests only run meaningfully after migrations/0001_platform_core.sql is
 * applied. Every value is a bound parameter and no environment value is
 * ever printed.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

const SHA = "c".repeat(64);
const unique = crypto.randomUUID().slice(0, 8);

test.skipIf(!hasDb)(
	"Neon live: task lifecycle + queue claim + approval payload binding",
	async () => {
		const sql = createDb(process.env.DATABASE_URL!);
		// Tenant keys for this run (random suffix keeps reruns independent).
		const slug = `live-a2-${unique}`;
		const email = `live-a2-${unique}@example.test`;
		const fullName = `live-a2-${unique}/repo`;
		const idemKey = `live-${unique}`;
		const jobKey = `live-job-${unique}`;
		const workerId = `worker-${unique}`;
		let orgUuid: string | null = null;

		try {
			// The migration is applied by the coordinator, not by this package.
			// If 0001_platform_core.sql is not applied yet, exit as a clean skip.
			const ready = (await sql.unsafe(
				"SELECT to_regclass('public.organizations') AS t",
				[],
			)) as Array<Record<string, unknown>>;
			if (!ready[0]?.t) {
				return;
			}

			// Seed the minimal FK chain: organization -> user -> repository.
			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0]!.id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "Sprint A2 Live Test"],
			)) as Array<Record<string, unknown>>;
			const repoRows = (await sql.unsafe(
				`INSERT INTO repositories (organization_id, provider, external_full_name, default_branch)
					VALUES ($1, 'github', $2, 'main') RETURNING id`,
				[orgRows[0]!.id, fullName],
			)) as Array<Record<string, unknown>>;
			await sql.unsafe(
				"INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')",
				[orgRows[0]!.id, userRows[0]!.id],
			);

			const orgId = asOrganizationId(orgRows[0]!.id as string);
			const tasks = new PostgresTaskRepository(sql);
			const queue = new PostgresQueueRepository(sql);
			const approvals = new PostgresApprovalRepository(sql);

			// Task create; the second call with the SAME idempotency key must
			// return the original row (not overwrite the budget).
			const createInput = {
				organizationId: orgId,
				repositoryId: repoRows[0]!.id as string,
				branch: `task/live-${unique}`,
				idempotencyKey: idemKey,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 2,
					maxDurationMs: 3600000,
				},
				goal: "Add a live health endpoint",
				acceptanceCriteria: ["tests pass", "no unrelated files change"],
				fileOwnership: ["apps/web/**"],
				createdBy: userRows[0]!.id as string,
			};
			const created: TaskRow = await tasks.create(createInput);
			const deduped: TaskRow = await tasks.create({
				...createInput,
				budgetLimits: {
					maxAgentTurns: 9,
					maxRepairAttempts: 9,
					maxDurationMs: 1,
				},
			});
			expect(deduped.id).toBe(created.id);
			expect(deduped.status).toBe("queued");
			expect(deduped.budget_limits.max_agent_turns).toBe(5);

			// Task context survives the round-trip and is tenant-scoped.
			expect(created.goal).toBe("Add a live health endpoint");
			expect(created.acceptance_criteria).toEqual([
				"tests pass",
				"no unrelated files change",
			]);
			expect(created.file_ownership).toEqual(["apps/web/**"]);
			const context = await new PostgresTaskContextRepository(sql).get({
				organizationId: orgId,
				taskId: created.id,
			});
			expect(context).toMatchObject({
				taskId: created.id,
				organizationId: orgId,
				goal: "Add a live health endpoint",
				acceptanceCriteria: ["tests pass", "no unrelated files change"],
				fileOwnership: ["apps/web/**"],
				branch: `task/live-${unique}`,
				repositoryProvider: "github",
				repositoryFullName: fullName,
				repositoryDefaultBranch: "main",
				budgetLimits: {
					max_agent_turns: 5,
					max_repair_attempts: 2,
					max_duration_ms: 3600000,
				},
			});
			expect(
				await new PostgresTaskContextRepository(sql).get({
					organizationId: asOrganizationId(crypto.randomUUID()),
					taskId: created.id,
				}),
			).toBeNull();

			// State machine: legal move ok; stale expectation -> CONFLICT.
			const moved = await tasks.transition({
				taskId: created.id,
				to: "planning",
				expectedStatus: "queued",
			});
			expect(moved.ok).toBe(true);
			const stale = await tasks.transition({
				taskId: created.id,
				to: "executing",
				expectedStatus: "queued",
			});
			expect(stale.ok).toBe(false);
			if (!stale.ok) {
				expect(stale.code).toBe("CONFLICT");
			}

			// Queue: idempotent enqueue, atomic claim, completion ack.
			const jobInput = {
				organizationId: orgId,
				taskId: created.id,
				type: "run_task" as const,
				payload: { note: "live-a2" },
				idempotencyKey: jobKey,
				maxAttempts: 3,
			};
			const job = await queue.enqueue(jobInput);
			const duplicate = await queue.enqueue(jobInput);
			expect(duplicate.id).toBe(job.id);
			const claimed = await queue.claimNext({
				ownerId: workerId,
				leaseSeconds: 30,
			});
			// The queue is shared; only touch a job we actually claimed.
			if (claimed !== null && claimed.id === job.id) {
				expect(claimed.status).toBe("claimed");
				expect(claimed.attempts).toBe(1);
				const foreignAck = await queue.ackComplete(job.id, "not-the-owner");
				expect(foreignAck.ok).toBe(false);
				const ack = await queue.ackComplete(job.id, workerId);
				expect(ack.ok).toBe(true);
			}

			// Approvals: decisions bind to the EXACT payload_sha256 only.
			const approval: ApprovalRow = await approvals.request({
				organizationId: orgId,
				taskId: created.id,
				workflowRunId: null,
				action: "pr.merge",
				payloadSha256: SHA,
				requestedBy: "agent",
				expiresInSeconds: 60,
			});
			const wrongHash = await approvals.decide({
				approvalId: approval.id,
				decide: "approve",
				payloadSha256: "d".repeat(64),
				decidedBy: "user",
			});
			expect(wrongHash.ok).toBe(false);
			if (!wrongHash.ok) {
				expect(wrongHash.code).toBe("PAYLOAD_CHANGED");
			}
			const decided = await approvals.decide({
				approvalId: approval.id,
				decide: "reject",
				payloadSha256: SHA,
				decidedBy: "user",
			});
			expect(decided.ok).toBe(true);
			expect(decided.ok && decided.approval.status).toBe("rejected");

			// listByStatus scan reaches the row via the status index.
			const planning = await tasks.listByStatus("planning", 10);
			expect(planning.some((task) => task.id === created.id)).toBe(true);
		} finally {
			// Best-effort teardown in reverse FK order; NEVER masks test
			// failures. Every parameter is bound; no statement interpolates.
			// orgUuid is a real uuid; when seeding failed we still remove
			// nothing (the deletes below all scope to it, harmlessly empty).
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM tool_invocations WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM audit_events WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM usage_records WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM approvals WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				[
					"DELETE FROM jobs WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
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
				[
					"DELETE FROM workflow_runs WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				["DELETE FROM tasks WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM repositories WHERE external_full_name = $1", [fullName]],
				["DELETE FROM memberships WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM users WHERE email = $1", [email]],
				["DELETE FROM organizations WHERE slug = $1", [slug]],
			];
			for (const [statement, params] of teardown) {
				try {
					await sql.unsafe(statement, params);
				} catch {
					// Swallow cleanup errors only (tables may not exist yet).
				}
			}
			await sql.end({ timeout: 5 });
		}
	},
	// Neon connect + TLS handshake can exceed Bun's 5s default on cold pools.
	120000,
);

test.skipIf(!hasDb)(
	"Neon live: usage rows bind exact jsonb-unrelated numerics and aggregate",
	async () => {
		const sql = createDb(process.env.DATABASE_URL!);
		const suffix = crypto.randomUUID().slice(0, 8);
		const slug = `live-w4db-usage-${suffix}`;
		const email = `live-w4db-usage-${suffix}@example.test`;
		const fullName = `live-w4db-usage-${suffix}/repo`;
		let orgUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				"SELECT to_regclass('public.usage_records') AS t",
				[],
			)) as Array<Record<string, unknown>>;
			if (!ready[0]?.t) {
				return; // migration 0001 not applied: clean skip
			}

			const orgRows = (await sql.unsafe(
				"INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
				[slug, slug],
			)) as Array<Record<string, unknown>>;
			orgUuid = orgRows[0].id as string;
			const userRows = (await sql.unsafe(
				"INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id",
				[email, "W4-DB Usage Live"],
			)) as Array<Record<string, unknown>>;
			const repoRows = (await sql.unsafe(
				`INSERT INTO repositories (organization_id, provider, external_full_name, default_branch)
					VALUES ($1, 'github', $2, 'main') RETURNING id`,
				[orgUuid, fullName],
			)) as Array<Record<string, unknown>>;
			await sql.unsafe(
				"INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')",
				[orgUuid, userRows[0].id],
			);

			const orgId = asOrganizationId(orgUuid);
			const tasks = new PostgresTaskRepository(sql);
			const usage = new PostgresUsageRepository(sql);
			const task = await tasks.create({
				organizationId: orgId,
				repositoryId: repoRows[0].id as string,
				branch: `task/usage-${suffix}`,
				idempotencyKey: `usage-${suffix}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 2,
					maxDurationMs: 3600000,
				},
				createdBy: userRows[0].id as string,
			});

			const first = await usage.record({
				organizationId: orgId,
				taskId: task.id,
				provider: "baseten",
				modelId: "meta-models/muse-spark-open-1026",
				promptTokens: 100,
				completionTokens: 20,
				costUsd: 0.1,
			});
			expect(first.prompt_tokens).toBe(100);
			expect(first.cost_usd).toBe("0.100000");
			await usage.record({
				organizationId: orgId,
				taskId: task.id,
				provider: "baseten",
				modelId: "meta-models/muse-spark-open-1026",
				promptTokens: 50,
				completionTokens: 5,
				costUsd: 0.2,
			});

			const byTask = await usage.sumByTask(task.id);
			expect(byTask).toEqual({
				promptTokens: 150,
				completionTokens: 25,
				totalTokens: 175,
				costUsd: "0.300000",
			});
			expect(
				await usage.sumByOrgSince(orgId, new Date(Date.now() - 3600_000)),
			).toEqual(byTask);
			expect(
				await usage.sumByOrgSince(orgId, new Date(Date.now() + 3600_000)),
			).toEqual({
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				costUsd: null,
			});

			// Exact storage: no binary-float tail, and column types are the
			// numeric/integer types (json has no part in this table).
			const raw = (await sql.unsafe(
				`SELECT cost_usd::text AS cost_usd FROM usage_records
					WHERE organization_id = $1::uuid ORDER BY cost_usd ASC`,
				[orgId],
			)) as Array<Record<string, unknown>>;
			expect(raw.map((row) => row.cost_usd)).toEqual(["0.100000", "0.200000"]);
			const types = (await sql.unsafe(
				`SELECT DISTINCT
					pg_typeof(cost_usd)::text AS cost_usd_type,
					pg_typeof(prompt_tokens)::text AS prompt_tokens_type,
					pg_typeof(completion_tokens)::text AS completion_tokens_type
				FROM usage_records WHERE organization_id = $1::uuid`,
				[orgId],
			)) as Array<Record<string, unknown>>;
			expect(types).toEqual([
				{
					cost_usd_type: "numeric",
					prompt_tokens_type: "integer",
					completion_tokens_type: "integer",
				},
			]);
		} finally {
			const teardown: Array<[string, unknown[]]> = [
				[
					"DELETE FROM tool_invocations WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM audit_events WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM usage_records WHERE organization_id = $1::uuid",
					[orgUuid],
				],
				[
					"DELETE FROM jobs WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
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
				[
					"DELETE FROM workflow_runs WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1::uuid)",
					[orgUuid],
				],
				["DELETE FROM tasks WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM repositories WHERE external_full_name = $1", [fullName]],
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
