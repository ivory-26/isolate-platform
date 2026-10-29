import { describe, expect, test } from "bun:test";
import type { PgSql } from "@isolate/db";
import { submitTaskSchema } from "../features/tasks/contracts";
import {
	createPostgresStore,
	latestTasksSql,
	repositoryOwnershipSql,
} from "./postgres-store.server";
import { createTaskService } from "./task-service.server";
import { input, scope } from "./test-fixtures";

const taskId = "30000000-0000-4000-8000-000000000001";
const jobId = "30000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";
const when = new Date("2026-10-28T12:00:00.000Z");
function sqlFixture(
	options: {
		queueFailure?: boolean;
		repositoryDenied?: boolean;
		badTimestamp?: boolean;
	} = {},
) {
	const calls: {
		statement: string;
		parameters: unknown[];
		transaction: boolean;
	}[] = [];
	let committed = false;
	let rolledBack = false;
	const request = input();
	const task = {
		id: taskId,
		organization_id: scope.organizationId,
		repository_id: request.repositoryId,
		worktree: request.branch,
		branch: request.branch,
		status: "queued",
		idempotency_key: request.idempotencyKey,
		budget_limits: {
			max_agent_turns: 12,
			max_repair_attempts: 2,
			max_duration_ms: 120000,
		},
		created_by: scope.userId,
		created_at: when,
		updated_at: when,
	};
	const job = {
		id: jobId,
		organization_id: scope.organizationId,
		task_id: taskId,
		type: "run_task",
		payload: { taskId },
		status: "pending",
		attempts: 0,
		max_attempts: 3,
		lease_owner_id: null,
		lease_expires_at: null,
		not_before: when,
		enqueue_uuid_key: `run_task:${taskId}`,
		last_error_code: null,
		last_error_message: null,
		created_at: when,
	};
	async function execute(
		statement: string,
		parameters: unknown[],
		transaction: boolean,
	): Promise<Record<string, unknown>[]> {
		calls.push({ statement, parameters, transaction });
		if (statement === repositoryOwnershipSql)
			return options.repositoryDenied ? [] : [{ id: request.repositoryId }];
		if (statement.startsWith("INSERT INTO tasks")) return [task];
		if (statement.startsWith("INSERT INTO jobs")) {
			if (options.queueFailure) throw new Error("private driver failure");
			return [job];
		}
		if (statement === latestTasksSql)
			return [
				{
					...task,
					created_at: options.badTimestamp ? null : when,
					run_id: runId,
					run_status: "running",
					run_started_at: when,
					run_finished_at: null,
					credential_ref: "must-not-escape",
					data: { apiKey: "fake-only" },
				},
				{ ...task, id: "30000000-0000-4000-8000-000000000004", run_id: null },
			];
		throw new Error("Unexpected fixture statement");
	}
	const sql = {
		unsafe: (statement: string, parameters: unknown[]) =>
			execute(statement, parameters, false),
		async begin<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
			try {
				const result = await callback({
					unsafe: (statement: string, parameters: unknown[]) =>
						execute(statement, parameters, true),
				});
				committed = true;
				return result;
			} catch (error) {
				rolledBack = true;
				throw error;
			}
		},
	} as unknown as PgSql;
	const store = createPostgresStore(sql);
	return {
		store,
		request,
		calls,
		committed: () => committed,
		rolledBack: () => rolledBack,
		service: createTaskService({
			resolveScope: async () => scope,
			getStore: async () => store,
		}),
	};
}

describe("offline PostgreSQL adapter", () => {
	test("ownership check, task and queue writes share one transaction", async () => {
		const h = sqlFixture();
		const result = await h.service.submit(h.request);
		expect(result.ok).toBe(true);
		expect(h.committed()).toBe(true);
		expect(h.rolledBack()).toBe(false);
		expect(h.calls).toHaveLength(3);
		expect(h.calls.every((call) => call.transaction)).toBe(true);
		expect(h.calls[0].parameters).toEqual([
			scope.organizationId,
			h.request.repositoryId,
		]);
		expect(h.calls[1].parameters[0]).toBe(scope.organizationId);
		expect(h.calls[1].parameters[5]).toBe(scope.userId);
		expect(h.calls[2].parameters.slice(0, 3)).toEqual([
			scope.organizationId,
			taskId,
			"run_task",
		]);
	});
	test("enqueue error rolls back transaction and returns a safe error", async () => {
		const h = sqlFixture({ queueFailure: true });
		const result = await h.service.submit(h.request);
		expect(h.rolledBack()).toBe(true);
		expect(h.committed()).toBe(false);
		expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(result)).not.toContain("private");
	});
	test("foreign repository rolls back before task write", async () => {
		const h = sqlFixture({ repositoryDenied: true });
		expect(await h.service.submit(h.request)).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.calls).toHaveLength(1);
		expect(h.rolledBack()).toBe(true);
	});
	test("list scopes tasks and runs before latest-first limit, projects only safe fields", async () => {
		const h = sqlFixture();
		const result = await h.service.list({ limit: 10 });
		if (!result.ok) throw new Error("Expected list");
		expect(h.calls[0]).toMatchObject({
			statement: latestTasksSql,
			parameters: [scope.organizationId, 10],
		});
		expect(latestTasksSql).toContain("WHERE t.organization_id = $1");
		expect(latestTasksSql).toContain("task_id = t.id AND organization_id = $1");
		expect(latestTasksSql).toContain(
			"ORDER BY t.created_at DESC, t.id DESC LIMIT $2",
		);
		expect(latestTasksSql).toContain(
			"ORDER BY started_at DESC, id DESC LIMIT 1",
		);
		expect(result.value[0].latestRun).toEqual({
			id: runId,
			status: "running",
			startedAt: when.toISOString(),
			finishedAt: null,
		});
		expect(result.value[1].latestRun).toBeNull();
		for (const field of [
			"credential_ref",
			"apiKey",
			"idempotency_key",
			"created_by",
			"worktree",
			"budget_limits",
		])
			expect(JSON.stringify(result)).not.toContain(field);
	});
	test("malformed stored timestamp fails safely", async () => {
		expect(
			await sqlFixture({ badTimestamp: true }).service.list({}),
		).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
	});
	test("store input comes from validated shared budget schema", () => {
		expect(submitTaskSchema.parse(input()).budget).toEqual({
			maxAgentTurns: 12,
			repairBudget: 2,
			jobTimeoutMs: 120000,
		});
	});
});
