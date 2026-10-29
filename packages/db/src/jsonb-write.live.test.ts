import { expect, test } from "bun:test";
import { asOrganizationId, asWorkflowVersionId } from "@isolate/shared";
import { createDb } from "./client";
import {
	PostgresAuditRepository,
	PostgresToolInvocationRepository,
} from "./repositories/audit-repository";
import { PostgresQueueRepository } from "./repositories/queue-repository";
import { PostgresTaskAttemptRepository } from "./repositories/task-attempt-repository";
import { PostgresTaskRepository } from "./repositories/task-repository";
import { PostgresWorkflowRunRepository } from "./repositories/workflow-run-repository";

/**
 * DB-level regression suite for jsonb writes (W4-B follow-up).
 *
 * Repositories serialize JSON themselves and bind the string; the cast MUST be
 * `::text::jsonb`. A plain `::jsonb` cast makes postgres.js double-encode the
 * value (the column then holds a JSON *string* scalar), which passes the
 * repository read path (parseJsonbColumn) but breaks SQL-side JSON operators.
 * These assertions look at `jsonb_typeof` in Postgres, not at the mapped rows.
 *
 * Auto-skips without DATABASE_URL. No DDL: the coordinator applies migrations.
 */
const hasDb =
	typeof process.env.DATABASE_URL === "string" &&
	process.env.DATABASE_URL.length > 0;

test.skipIf(!hasDb)(
	"Neon live: JSON writes store jsonb objects and keep SQL operators working",
	async () => {
		const url = process.env.DATABASE_URL;
		if (!url) throw new Error("DATABASE_URL is required for live tests");
		const sql = createDb(url, { max: 2 });
		const unique = crypto.randomUUID().slice(0, 8);
		const slug = `live-w4db-jsonb-${unique}`;
		const email = `live-w4db-jsonb-${unique}@example.test`;
		const fullName = `live-w4db-jsonb-${unique}/repo`;
		let orgUuid: string | null = null;
		let userUuid: string | null = null;
		let definitionUuid: string | null = null;
		let versionUuid: string | null = null;

		try {
			const ready = (await sql.unsafe(
				"SELECT to_regclass('public.audit_events') AS t",
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
				[email, "W4-DB JSONB Live"],
			)) as Array<Record<string, unknown>>;
			userUuid = userRows[0].id as string;
			const repoRows = (await sql.unsafe(
				`INSERT INTO repositories (organization_id, provider, external_full_name, default_branch)
					VALUES ($1, 'github', $2, 'main') RETURNING id`,
				[orgUuid, fullName],
			)) as Array<Record<string, unknown>>;
			await sql.unsafe(
				"INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'member')",
				[orgUuid, userUuid],
			);
			const definitionRows = (await sql.unsafe(
				`INSERT INTO workflow_definitions (organization_id, name, created_by)
					VALUES ($1, $2, $3) RETURNING id`,
				[orgUuid, `jsonb-live-${unique}`, userUuid],
			)) as Array<Record<string, unknown>>;
			definitionUuid = definitionRows[0].id as string;
			const versionRows = (await sql.unsafe(
				`INSERT INTO workflow_versions (definition_id, version, graph, created_by)
					VALUES ($1, 1, '{}'::jsonb, $2) RETURNING id`,
				[definitionUuid, userUuid],
			)) as Array<Record<string, unknown>>;
			versionUuid = versionRows[0].id as string;

			const orgId = asOrganizationId(orgUuid);
			const tasks = new PostgresTaskRepository(sql);
			const queue = new PostgresQueueRepository(sql);
			const attempts = new PostgresTaskAttemptRepository(sql);
			const runs = new PostgresWorkflowRunRepository(sql);
			const audit = new PostgresAuditRepository(sql);
			const tools = new PostgresToolInvocationRepository(sql);

			const task = await tasks.create({
				organizationId: orgId,
				repositoryId: repoRows[0].id as string,
				branch: `task/jsonb-${unique}`,
				idempotencyKey: `jsonb-${unique}`,
				budgetLimits: {
					maxAgentTurns: 5,
					maxRepairAttempts: 2,
					maxDurationMs: 3600000,
				},
				createdBy: userUuid,
			});

			const run = await runs.startRun({
				taskId: task.id,
				organizationId: orgId,
				workflowVersionId: asWorkflowVersionId(versionUuid),
			});
			const attempt = await attempts.begin(task.id, run.id);
			const finished = await attempts.finish({
				attemptId: attempt.id,
				outcome: { kind: "execution", notes: "jsonb live" },
			});
			expect(finished?.outcome).toEqual({
				kind: "execution",
				notes: "jsonb live",
			});

			await queue.enqueue({
				organizationId: orgId,
				taskId: task.id,
				type: "run_task",
				payload: { note: "jsonb-live", nested: { ok: true } },
				idempotencyKey: `jsonb-job-${unique}`,
				maxAttempts: 3,
			});
			const event = await runs.appendEvent({
				taskId: task.id,
				workflowRunId: run.id,
				type: "workflow.step_started",
				actor: "worker",
				data: { step: "s1", nested: { ok: true } },
			});
			expect(event.data).toEqual({ step: "s1", nested: { ok: true } });

			const auditRow = await audit.append({
				organizationId: orgId,
				actorId: null,
				actorKind: "system",
				action: "task.create",
				target: `task:${task.id}`,
				details: { source: "jsonb-live", nested: { ok: true } },
			});
			expect(auditRow.details).toEqual({
				source: "jsonb-live",
				nested: { ok: true },
			});
			const toolRow = await tools.record({
				organizationId: orgId,
				taskId: task.id,
				workflowRunId: run.id,
				toolName: "repo.read_file",
				argumentsRedacted: { path: "README.md", nested: { ok: true } },
				decision: "allowed",
				denialReason: null,
				durationMs: 3,
			});
			expect(toolRow.arguments_redacted).toEqual({
				path: "README.md",
				nested: { ok: true },
			});

			// DB-level: every affected column must be a jsonb OBJECT, not the
			// double-encoded JSON string scalar that `::jsonb` produces.
			const typeRows = (await sql.unsafe(
				`SELECT
					jsonb_typeof((SELECT budget_limits FROM tasks WHERE id = $1)) AS budget_limits,
					jsonb_typeof((SELECT payload FROM jobs WHERE task_id = $1 LIMIT 1)) AS payload,
					jsonb_typeof((SELECT data FROM run_events WHERE task_id = $1 LIMIT 1)) AS data,
					jsonb_typeof((SELECT outcome FROM task_attempts WHERE task_id = $1 LIMIT 1)) AS outcome,
					jsonb_typeof((SELECT arguments_redacted FROM tool_invocations WHERE task_id = $1 LIMIT 1)) AS arguments_redacted,
					jsonb_typeof((SELECT details FROM audit_events WHERE organization_id = $2 LIMIT 1)) AS details`,
				[task.id, orgId],
			)) as Array<Record<string, unknown>>;
			expect(typeRows).toHaveLength(1);
			for (const column of [
				"budget_limits",
				"payload",
				"data",
				"outcome",
				"arguments_redacted",
				"details",
			]) {
				expect(typeRows[0][column]).toBe("object");
			}

			// SQL-side scan: text extraction from jsonb must return the values we
			// wrote, both after INSERT and after a task transition.
			const scanSql = `SELECT
				budget_limits->>'max_agent_turns' AS max_agent_turns,
				budget_limits->>'max_repair_attempts' AS max_repair_attempts,
				budget_limits->>'max_duration_ms' AS max_duration_ms
				FROM tasks WHERE id = $1`;
			const expectedScan = {
				max_agent_turns: "5",
				max_repair_attempts: "2",
				max_duration_ms: "3600000",
			};
			const afterInsert = (await sql.unsafe(scanSql, [task.id])) as Array<
				Record<string, unknown>
			>;
			expect(afterInsert[0]).toEqual(expectedScan);

			const moved = await tasks.transition({
				taskId: task.id,
				to: "planning",
				expectedStatus: "queued",
			});
			expect(moved.ok).toBe(true);
			const afterTransition = (await sql.unsafe(scanSql, [task.id])) as Array<
				Record<string, unknown>
			>;
			expect(afterTransition[0]).toEqual(expectedScan);
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
				["DELETE FROM workflow_versions WHERE id = $1::uuid", [versionUuid]],
				[
					"DELETE FROM workflow_definitions WHERE id = $1::uuid",
					[definitionUuid],
				],
				["DELETE FROM repositories WHERE external_full_name = $1", [fullName]],
				["DELETE FROM memberships WHERE organization_id = $1::uuid", [orgUuid]],
				["DELETE FROM users WHERE id = $1::uuid", [userUuid]],
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
