import { describe, expect, test } from "bun:test";
import type { PgSql } from "@isolate/db";
import { submitTaskSchema } from "../features/tasks/contracts";
import {
	activeMembershipSql,
	createPostgresStore,
	latestTasksSql,
	repositoryOwnershipSql,
} from "./postgres-store.server";
import { createTaskService } from "./task-service.server";
import { input, scope } from "./test-fixtures";

const taskId = "30000000-0000-4000-8000-000000000001";
const jobId = "30000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";
const planRowId = "30000000-0000-4000-8000-000000000004";
const rejectionRowId = "30000000-0000-4000-8000-000000000005";
const authoredVersionId = "30000000-0000-4000-8000-000000000006";
const when = new Date("2026-10-28T12:00:00.000Z");
function sqlFixture(
	options: {
		queueFailure?: boolean;
		repositoryDenied?: boolean;
		membershipDenied?: boolean;
		badTimestamp?: boolean;
		malformedGraph?: boolean;
		missingAuthoredVersion?: boolean;
	} = {},
) {
	const calls: {
		statement: string;
		parameters: unknown[];
		transaction: boolean;
	}[] = [];
	let committed = false;
	let rolledBack = false;
	let insertedTask: Record<string, unknown> | null = null;
	const request = input();
	const graph = options.malformedGraph
		? null
		: {
				id: request.workflowDefinitionId,
				name: "Stored authored definition",
				version: request.workflowVersion,
				nodes: [
					{
						id: "agent-step",
						type: "task.agent",
						label: "Agent",
						config: {
							agentId: "coding-agent",
							promptTemplateId: "stored-template",
						},
					},
				],
				edges: [],
			};
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
		goal: request.goal,
		acceptance_criteria: request.acceptanceCriteria,
		file_ownership: request.fileOwnership,
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
		if (statement === activeMembershipSql)
			return options.membershipDenied
				? []
				: [{ organization_id: scope.organizationId, user_id: scope.userId }];
		if (statement.includes("FROM compiled_plans")) return [];
		if (statement.includes("FROM workflow_versions")) {
			if (options.missingAuthoredVersion) return [];
			return [
				{
					id: authoredVersionId,
					definition_id: request.workflowDefinitionId,
					version: request.workflowVersion,
					graph,
					compiled: null,
					created_by: scope.userId,
					created_at: when,
				},
			];
		}
		if (statement.startsWith("INSERT INTO compiled_plans"))
			return [
				{
					id: planRowId,
					organization_id: parameters[0],
					workflow_definition_id: parameters[1],
					workflow_version: parameters[2],
					plan: JSON.parse(String(parameters[3])),
					created_at: when,
				},
			];
		if (statement.startsWith("INSERT INTO rejection_issues"))
			return [
				{
					id: rejectionRowId,
					organization_id: parameters[0],
					workflow_definition_id: parameters[1],
					workflow_version: parameters[2],
					issues: JSON.parse(String(parameters[3])),
					created_at: when,
				},
			];
		if (statement.startsWith("INSERT INTO tasks")) {
			// Mirrors ON CONFLICT DO NOTHING: the first insert wins, later calls
			// return the stored row (so idempotent replay equality is exercised).
			insertedTask ??= {
				...task,
				goal: parameters[5],
				acceptance_criteria: JSON.parse(String(parameters[6])),
				acceptance_checks: JSON.parse(String(parameters[7])),
				file_ownership: JSON.parse(String(parameters[8])),
				created_by: parameters[9],
			};
			return [insertedTask];
		}
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
				{ ...task, id: "30000000-0000-4000-8000-000000000007", run_id: null },
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
	test("ownership, compile, task and queue writes share one transaction", async () => {
		const h = sqlFixture();
		const result = await h.service.submit(h.request);
		expect(result.ok).toBe(true);
		expect(h.committed()).toBe(true);
		expect(h.rolledBack()).toBe(false);
		expect(h.calls).toHaveLength(7);
		expect(h.calls.every((call) => call.transaction)).toBe(true);
		expect(h.calls[0].parameters).toEqual([
			scope.organizationId,
			h.request.repositoryId,
		]);
		expect(h.calls[1].parameters).toEqual([
			scope.organizationId,
			h.request.workflowDefinitionId,
			h.request.workflowVersion,
		]);
		expect(h.calls[2].statement).toBe(activeMembershipSql);
		expect(h.calls[2].parameters).toEqual([scope.organizationId, scope.userId]);
		expect(h.calls[3].parameters.slice(0, 3)).toEqual([
			scope.organizationId,
			h.request.workflowDefinitionId,
			h.request.workflowVersion,
		]);
		expect(h.calls[4].parameters.slice(0, 3)).toEqual([
			scope.organizationId,
			h.request.workflowDefinitionId,
			h.request.workflowVersion,
		]);
		expect(h.calls[5].parameters[0]).toBe(scope.organizationId);
		expect(h.calls[5].parameters[5]).toBe(h.request.goal);
		// Parameter order mirrors the insert: goal, criteria, checks, ownership,
		// then the acting user.
		expect(JSON.parse(String(h.calls[5].parameters[7]))).toEqual([]);
		expect(JSON.parse(String(h.calls[5].parameters[8]))).toEqual(
			h.request.fileOwnership,
		);
		expect(h.calls[5].parameters[9]).toBe(scope.userId);
		expect(h.calls[6].parameters.slice(0, 3)).toEqual([
			scope.organizationId,
			taskId,
			"run_task",
		]);
		if (!result.ok) throw new Error("Expected receipt");
		expect(result.value.compilation).toEqual({
			outcome: "compiled",
			compiledPlanId: planRowId,
		});
	});
	test("enqueue error rolls back transaction and returns a safe error", async () => {
		const h = sqlFixture({ queueFailure: true });
		const result = await h.service.submit(h.request);
		expect(h.rolledBack()).toBe(true);
		expect(h.committed()).toBe(false);
		expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(result)).not.toContain("private");
	});
	test("foreign repository rolls back before compilation", async () => {
		const h = sqlFixture({ repositoryDenied: true });
		expect(await h.service.submit(h.request)).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.calls).toHaveLength(1);
		expect(h.rolledBack()).toBe(true);
	});
	test("caller without an active membership is FORBIDDEN before any write", async () => {
		const h = sqlFixture({ membershipDenied: true });
		expect(await h.service.submit(h.request)).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.rolledBack()).toBe(true);
		expect(h.committed()).toBe(false);
		expect(
			h.calls.some((call) => call.statement.startsWith("INSERT INTO tasks")),
		).toBe(false);
		expect(
			h.calls.some((call) => call.statement.startsWith("INSERT INTO jobs")),
		).toBe(false);
	});
	test("rejection commits sanitized history but writes no task or job", async () => {
		const h = sqlFixture({ malformedGraph: true });
		const result = await h.service.submit(h.request);
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "WORKFLOW_REJECTED",
				issues: [{ code: "MALFORMED_GRAPH", path: "graph" }],
			},
		});
		expect(h.committed()).toBe(true);
		expect(h.rolledBack()).toBe(false);
		expect(h.calls).toHaveLength(5);
		expect(h.calls[4].statement).toContain("INSERT INTO rejection_issues");
		expect(
			h.calls.some((call) => call.statement.startsWith("INSERT INTO tasks")),
		).toBe(false);
		expect(
			h.calls.some((call) => call.statement.startsWith("INSERT INTO jobs")),
		).toBe(false);
	});
	test("missing authored version is FORBIDDEN and never writes a task", async () => {
		const h = sqlFixture({ missingAuthoredVersion: true });
		expect(await h.service.submit(h.request)).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
		expect(h.rolledBack()).toBe(true);
		expect(h.committed()).toBe(false);
		expect(
			h.calls.some((call) => call.statement.startsWith("INSERT INTO tasks")),
		).toBe(false);
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
	test("store input comes from validated shared budget and workflow schemas", () => {
		const parsed = submitTaskSchema.parse(input());
		expect(parsed.budget).toEqual({
			maxAgentTurns: 12,
			repairBudget: 2,
			jobTimeoutMs: 120000,
		});
		expect(parsed.workflowDefinitionId).toBe(input().workflowDefinitionId);
		expect(parsed.workflowVersion).toBe(1);
		expect(parsed.acceptanceChecks).toEqual([]);
	});
	test("submission persists machine-checkable acceptance criteria on the task insert", async () => {
		const h = sqlFixture();
		const acceptanceChecks = [
			{ kind: "path_exists", path: "LIVE_ACCEPTANCE.md" },
			{ kind: "content_matches", path: "README.md", pattern: "# Isolate" },
			{
				kind: "command_exit_zero",
				command: "bun test live_acceptance.test.ts",
			},
		] as const;
		const result = await h.service.submit(
			input({ acceptanceChecks: [...acceptanceChecks] }),
		);
		if (!result.ok) throw new Error("Expected receipt");
		const insert = h.calls.find((call) =>
			call.statement.startsWith("INSERT INTO tasks"),
		);
		if (insert === undefined) throw new Error("Expected a task insert");
		// Bound jsonb parameter: acceptance checks come before file ownership.
		expect(JSON.parse(String(insert.parameters[7]))).toEqual([
			...acceptanceChecks,
		]);
		// The summary stays unchanged and never echoes stored criteria.
		expect(result.value.task).not.toHaveProperty("acceptanceChecks");
		expect(JSON.stringify(result)).not.toContain("LIVE_ACCEPTANCE.md");
	});
	test("idempotent replay with different acceptance checks conflicts before enqueue", async () => {
		const h = sqlFixture();
		const request = input({
			acceptanceChecks: [{ kind: "path_exists", path: "README.md" }],
		});
		expect((await h.service.submit(request)).ok).toBe(true);
		expect((await h.service.submit(request)).ok).toBe(true);
		expect(
			await h.service.submit({
				...request,
				acceptanceChecks: [{ kind: "path_exists", path: "CHANGED.md" }],
			}),
		).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
	});
});
