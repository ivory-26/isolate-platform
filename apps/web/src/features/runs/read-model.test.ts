import { describe, expect, test } from "bun:test";
import type { PgSql } from "@isolate/db";
import { asOrganizationId } from "@isolate/shared";
import { UiInvalidInputError, UiNotFoundError } from "../ui/contracts";
import { readRunDetail, readRunsList } from "./read-model";

const ORG = asOrganizationId("99999999-9999-4999-8999-999999999999");
const OTHER_ORG = asOrganizationId("88888888-8888-4888-8888-888888888888");
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const WHEN = new Date("2026-11-20T10:00:00.000Z");

type Call = { statement: string; params: readonly unknown[] };

function scriptedSql(
	respond: (statement: string, params: readonly unknown[]) => unknown[],
): { sql: PgSql; calls: Call[] } {
	const calls: Call[] = [];
	const sql = {
		unsafe: async (statement: string, params: unknown[] = []) => {
			calls.push({ statement, params });
			return respond(statement, params);
		},
	} as unknown as PgSql;
	return { sql, calls };
}

function listRow(overrides: Record<string, unknown> = {}) {
	return {
		id: TASK_ID,
		branch: "task/w20-runs",
		status: "failed",
		retry_depth: 1,
		created_at: WHEN,
		updated_at: WHEN,
		repository_id: REPO_ID,
		external_full_name: "acme/app",
		default_branch: "main",
		run_id: "44444444-4444-4444-8444-444444444444",
		run_status: "failed",
		run_started_at: WHEN,
		run_finished_at: WHEN,
		...overrides,
	};
}

function taskRow(overrides: Record<string, unknown> = {}) {
	return {
		id: TASK_ID,
		branch: "task/w20-runs",
		status: "failed",
		goal: "Ship the runs surface",
		acceptance_criteria: ["Timeline renders", "Filters persist"],
		file_ownership: ["apps/web/src/features/runs/**"],
		pull_request_number: 2,
		pull_request_url: "https://github.com/acme/app/pull/2",
		retry_of: null,
		retry_depth: 1,
		incident_source: "pagerduty",
		incident_fingerprint: "fp-123",
		created_at: WHEN,
		updated_at: WHEN,
		repository_id: REPO_ID,
		external_full_name: "acme/app",
		default_branch: "main",
		...overrides,
	};
}

function listFixture() {
	return [
		listRow(),
		listRow({
			id: "55555555-5555-4555-8555-555555555555",
			status: "completed",
			run_id: null,
			run_status: null,
			run_started_at: null,
			run_finished_at: null,
		}),
	];
}

function detailSql(
	options: {
		task: Record<string, unknown>[];
		eventData?: Record<string, unknown>;
	} = {
		task: [taskRow()],
	},
) {
	return scriptedSql((statement) => {
		if (statement.includes("LEFT JOIN LATERAL")) return listFixture();
		if (statement.includes("SELECT t.status, count(*)")) {
			return [
				{ status: "failed", count: 2 },
				{ status: "awaiting_approval", count: 1 },
				{ status: "completed", count: 3 },
			];
		}
		if (statement.includes("FROM repositories r")) {
			return [{ id: REPO_ID, external_full_name: "acme/app" }];
		}
		if (statement.includes("t.incident_source")) return options.task;
		if (statement.includes("SELECT t.id FROM tasks t")) {
			return options.task.map((row) => ({ id: row.id }));
		}
		if (statement.includes("FROM run_events")) {
			return [
				{
					type: "agent.turn_started",
					actor: "worker",
					data: { turn: 1, apiKey: "fixture-only" },
					occurred_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM tool_invocations")) {
			return [
				{
					tool_name: "connector.github.issue",
					decision: "denied",
					denial_reason: "POLICY_DENIED",
					arguments_redacted: { command: "ls" },
					duration_ms: 12,
					created_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM usage_records")) {
			return [
				{
					provider: "baseten",
					model_id: "model-a",
					prompt_tokens: 10,
					completion_tokens: 5,
					cost_usd: "0.001200",
					created_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM connector_calls")) {
			return [
				{
					tool_name: "connector.github.issue",
					connector_id: "github",
					status: "completed",
					error_code: null,
					attempts: 1,
					traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
					created_at: WHEN,
					claimed_at: WHEN,
					completed_at: WHEN,
					expires_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM workflow_runs")) {
			return [
				{
					id: "44444444-4444-4444-8444-444444444444",
					status: "failed",
					started_at: WHEN,
					finished_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM approvals a")) {
			return [
				{
					id: "66666666-6666-4666-8666-666666666666",
					action: "git.push_branch",
					status: "pending",
					payload_sha256: "c".repeat(64),
					requested_by: "agent",
					decided_by: null,
					decided_at: null,
					expires_at: new Date("2026-11-20T13:00:00.000Z"),
					created_at: WHEN,
				},
			];
		}
		if (statement.includes("FROM artifacts a")) {
			return [
				{
					id: "77777777-7777-4777-8777-777777777777",
					kind: "diff",
					content_type: "text/x-diff",
					byte_size: 100000,
					sha256: "d".repeat(64),
					storage_ref: `blob:${"d".repeat(64)}`,
					content_preview: "diff --git a/x b/x",
					content_bytes: 100000,
					created_at: WHEN,
				},
			];
		}
		throw new Error(`Unexpected statement: ${statement.slice(0, 40)}`);
	});
}

describe("readRunsList", () => {
	test("binds scope tenancy and every filter as parameters", async () => {
		const { sql, calls } = detailSql();
		const page = await readRunsList(
			sql,
			{ organizationId: ORG },
			{
				status: "failed",
				repositoryId: REPO_ID,
				q: "task/w20",
				sort: "created",
				limit: 25,
			},
		);

		expect(page.rows).toHaveLength(2);
		expect(page.rows[0]).toMatchObject({
			taskId: TASK_ID,
			branch: "task/w20-runs",
			status: "failed",
			retryDepth: 1,
			repository: {
				id: REPO_ID,
				fullName: "acme/app",
				defaultBranch: "main",
			},
			latestRun: {
				id: "44444444-4444-4444-8444-444444444444",
				status: "failed",
			},
		});
		expect(page.rows[1]?.latestRun).toBeNull();
		expect(page.summary).toEqual({
			total: 6,
			active: 1,
			awaitingApproval: 1,
			failed: 2,
			reviewReady: 3,
		});
		expect(page.repositories).toEqual([{ id: REPO_ID, fullName: "acme/app" }]);

		const listCall = calls.find((call) =>
			call.statement.includes("LEFT JOIN LATERAL"),
		);
		expect(listCall?.params).toEqual([
			ORG,
			"failed",
			REPO_ID,
			"task/w20",
			"created",
			25,
		]);
		expect(listCall?.statement).toContain(
			"CASE WHEN $5 = 'created' THEN t.created_at END DESC",
		);
		expect(listCall?.params[0]).toBe(ORG);

		const summaryCall = calls.find((call) =>
			call.statement.includes("SELECT t.status, count(*)"),
		);
		expect(summaryCall?.params).toEqual([ORG]);
		expect(calls.every((call) => call.params[0] === ORG)).toBe(true);
	});

	test("chooses the whitelisted order for each sort", async () => {
		const { sql, calls } = detailSql();
		await readRunsList(
			sql,
			{ organizationId: ORG },
			{
				status: "all",
				repositoryId: null,
				q: "",
				sort: "updated",
				limit: 10,
			},
		);
		expect(
			calls.find((call) => call.statement.includes("LEFT JOIN LATERAL"))
				?.statement,
		).toContain("CASE WHEN $5 = 'updated' THEN t.updated_at END DESC");

		const again = detailSql();
		await readRunsList(
			again.sql,
			{ organizationId: ORG },
			{
				status: "all",
				repositoryId: null,
				q: "",
				sort: "status",
				limit: 10,
			},
		);
		expect(
			again.calls.find((call) => call.statement.includes("LEFT JOIN LATERAL"))
				?.statement,
		).toContain("CASE WHEN $5 = 'status' THEN t.status END ASC");
	});

	test("rejects invalid input before any SQL", async () => {
		const { sql, calls } = detailSql();
		await expect(
			readRunsList(
				sql,
				{ organizationId: OTHER_ORG },
				{
					status: "all",
					repositoryId: "not-a-uuid",
					q: "",
					sort: "created",
					limit: 25,
				},
			),
		).rejects.toBeInstanceOf(UiInvalidInputError);
		await expect(
			readRunsList(sql, { organizationId: ORG }, { limit: 500 }),
		).rejects.toBeInstanceOf(UiInvalidInputError);
		await expect(
			readRunsList(sql, { organizationId: ORG }, { sort: "random(); drop" }),
		).rejects.toBeInstanceOf(UiInvalidInputError);
		expect(calls).toHaveLength(0);
	});
});

describe("readRunDetail", () => {
	test("rejects a non-UUID task id before touching SQL", async () => {
		const { sql, calls } = detailSql();
		await expect(
			readRunDetail(sql, { organizationId: ORG }, { taskId: "not-a-uuid" }),
		).rejects.toBeInstanceOf(UiNotFoundError);
		expect(calls).toHaveLength(0);
	});

	test("a missing or foreign task stops after the identity read", async () => {
		const { sql, calls } = detailSql({ task: [] });
		await expect(
			readRunDetail(sql, { organizationId: OTHER_ORG }, { taskId: TASK_ID }),
		).rejects.toBeInstanceOf(UiNotFoundError);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.params).toEqual([OTHER_ORG, TASK_ID]);
	});

	test("maps the full detail projection with the task id normalized", async () => {
		const { sql, calls } = detailSql();
		const detail = await readRunDetail(
			sql,
			{ organizationId: ORG },
			{
				taskId: TASK_ID.toUpperCase(),
			},
		);

		expect(detail.task).toMatchObject({
			id: TASK_ID,
			branch: "task/w20-runs",
			status: "failed",
			goal: "Ship the runs surface",
			acceptanceCriteria: ["Timeline renders", "Filters persist"],
			fileOwnership: ["apps/web/src/features/runs/**"],
			pullRequestNumber: 2,
			pullRequestUrl: "https://github.com/acme/app/pull/2",
			retryDepth: 1,
			incidentSource: "pagerduty",
			incidentFingerprint: "fp-123",
			repository: {
				id: REPO_ID,
				fullName: "acme/app",
				defaultBranch: "main",
			},
		});
		expect(detail.traceId).toBe("a".repeat(32));
		expect(detail.workflowRuns).toHaveLength(1);
		expect(detail.events).toHaveLength(1);
		// The trace read model drops credential-shaped keys before mapping.
		expect(detail.events[0]?.data).toEqual({ turn: 1 });
		expect(detail.events[0]?.data).not.toHaveProperty("apiKey");
		expect(detail.toolInvocations[0]).toMatchObject({
			toolName: "connector.github.issue",
			decision: "denied",
			denialReason: "POLICY_DENIED",
			durationMs: 12,
		});
		expect(detail.toolInvocations[0]?.argumentsHash).toHaveLength(64);
		expect(detail.usage[0]).toMatchObject({
			provider: "baseten",
			modelId: "model-a",
			promptTokens: 10,
			completionTokens: 5,
			costUsd: "0.001200",
		});
		expect(detail.connectorCalls[0]).toMatchObject({
			connectorId: "github",
			status: "completed",
			attempts: 1,
		});
		expect(detail.approvals[0]).toMatchObject({
			action: "git.push_branch",
			status: "pending",
			payloadSha256: "c".repeat(64),
		});
		expect(detail.artifacts[0]).toMatchObject({
			kind: "diff",
			contentType: "text/x-diff",
			byteSize: 100000,
			isBlob: true,
			contentPreview: "diff --git a/x b/x",
			truncated: true,
		});

		// Every statement is scoped to the trusted organization, and the
		// normalized (lower-case) task id is the only task input.
		expect(calls.every((call) => call.params[0] === ORG)).toBe(true);
		const taskCall = calls.find((call) =>
			call.statement.includes("t.incident_source"),
		);
		expect(taskCall?.params).toEqual([ORG, TASK_ID]);
		expect(calls.some((call) => call.statement.includes(TASK_ID))).toBe(false);
	});

	test("caps detail sections at the fixed parameters", async () => {
		const { sql, calls } = detailSql();
		await readRunDetail(sql, { organizationId: ORG }, { taskId: TASK_ID });
		const runCall = calls.find((call) =>
			call.statement.includes("FROM workflow_runs"),
		);
		expect(runCall?.params).toEqual([ORG, TASK_ID, 20]);
		const approvalCall = calls.find((call) =>
			call.statement.includes("FROM approvals a"),
		);
		expect(approvalCall?.params).toEqual([ORG, TASK_ID, 50]);
		const artifactCall = calls.find((call) =>
			call.statement.includes("FROM artifacts a"),
		);
		expect(artifactCall?.params).toEqual([ORG, TASK_ID, 20, 16_384]);
	});
});
