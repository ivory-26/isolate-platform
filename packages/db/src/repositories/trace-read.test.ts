import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	type OrganizationId,
	type TaskId,
} from "@isolate/shared";
import type { PgSql } from "../client";
import {
	deriveTraceId,
	hashToolArguments,
	PostgresTraceReadRepository,
	sanitizeTraceData,
	TRACE_CONNECTOR_CALL_LIMIT,
	TRACE_EVENT_DEFAULT_LIMIT,
	TRACE_EVENT_MAX_LIMIT,
	TRACE_TOOL_INVOCATION_LIMIT,
	TRACE_USAGE_LIMIT,
} from "./trace-read";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const TASK_ID = asTaskId("33333333-3333-4333-8333-333333333333");
const TRACE_ID = "a".repeat(32);
const TRACEPARENT = `00-${TRACE_ID}-${"b".repeat(16)}-01`;
/** Fixture only; never a real credential. */
const FAKE_SECRET = `ghp_${"c".repeat(30)}`;

type Call = { readonly statement: string; readonly params: readonly unknown[] };

function scriptedSql(
	responses: readonly (readonly Record<string, unknown>[])[],
): { sql: PgSql; calls: Call[] } {
	const queue = [...responses];
	const calls: Call[] = [];
	const sql = {
		unsafe: async (statement: string, params: unknown[] = []) => {
			calls.push({ statement, params });
			return queue.shift() ?? [];
		},
	} as unknown as PgSql;
	return { sql, calls };
}

function taskExistsRow() {
	return [{ id: TASK_ID }];
}

function eventRow(overrides: Record<string, unknown> = {}) {
	return {
		type: "agent.turn_started",
		actor: "worker",
		data: { turn: 1, traceId: TRACE_ID },
		occurred_at: new Date("2026-11-01T10:00:00.000Z"),
		...overrides,
	};
}

function toolRow(overrides: Record<string, unknown> = {}) {
	return {
		tool_name: "connector.github.issue",
		decision: "denied",
		denial_reason: "POLICY_DENIED",
		arguments_redacted: { repo: "acme/app" },
		duration_ms: 12,
		created_at: new Date("2026-11-01T10:00:01.000Z"),
		...overrides,
	};
}

function usageRow(overrides: Record<string, unknown> = {}) {
	return {
		provider: "baseten",
		model_id: "model-a",
		prompt_tokens: 10,
		completion_tokens: 5,
		cost_usd: "0.001200",
		created_at: new Date("2026-11-01T10:00:02.000Z"),
		...overrides,
	};
}

function callRow(overrides: Record<string, unknown> = {}) {
	return {
		tool_name: "connector.github.issue",
		connector_id: "github",
		status: "completed",
		error_code: null,
		attempts: 1,
		traceparent: TRACEPARENT,
		created_at: new Date("2026-11-01T10:00:03.000Z"),
		claimed_at: new Date("2026-11-01T10:00:04.000Z"),
		completed_at: new Date("2026-11-01T10:00:05.000Z"),
		expires_at: new Date("2026-11-01T10:01:00.000Z"),
		...overrides,
	};
}

function input(
	overrides: Partial<{
		organizationId: OrganizationId;
		taskId: TaskId;
		maxEvents: number;
	}> = {},
) {
	return {
		organizationId: ORG_A,
		taskId: TASK_ID,
		...overrides,
	};
}

describe("PostgresTraceReadRepository", () => {
	test("a foreign or missing task reads no child table and returns null", async () => {
		const { sql, calls } = scriptedSql([[]]);
		const repository = new PostgresTraceReadRepository(sql);
		expect(
			await repository.getTaskTrace(
				input({ organizationId: ORG_B, taskId: TASK_ID }),
			),
		).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0].statement).toContain("WHERE t.organization_id = $1");
		expect(calls[0].params).toEqual([ORG_B, TASK_ID]);
	});

	test("assembles one ordered, bounded, ISO-dated trace", async () => {
		const { sql, calls } = scriptedSql([
			taskExistsRow(),
			[eventRow(), eventRow({ type: "agent.turn_finished" })],
			[toolRow()],
			[usageRow()],
			[callRow()],
		]);
		const repository = new PostgresTraceReadRepository(sql);
		const trace = await repository.getTaskTrace(input());

		expect(trace).not.toBeNull();
		if (trace === null) return;
		expect(trace.taskId).toBe(TASK_ID);
		expect(trace.traceId).toBe(TRACE_ID);
		expect(trace.events.map((event) => event.type)).toEqual([
			"agent.turn_started",
			"agent.turn_finished",
		]);
		expect(trace.events[0].createdAt).toBe("2026-11-01T10:00:00.000Z");
		expect(trace.toolInvocations[0]).toMatchObject({
			toolName: "connector.github.issue",
			decision: "denied",
			denialReason: "POLICY_DENIED",
			durationMs: 12,
			createdAt: "2026-11-01T10:00:01.000Z",
		});
		expect(trace.toolInvocations[0].argumentsHash).toMatch(/^[0-9a-f]{64}$/);
		expect(trace.usage[0]).toEqual({
			provider: "baseten",
			modelId: "model-a",
			promptTokens: 10,
			completionTokens: 5,
			costUsd: "0.001200",
			createdAt: "2026-11-01T10:00:02.000Z",
		});
		expect(trace.connectorCalls[0]).toEqual({
			toolName: "connector.github.issue",
			connectorId: "github",
			status: "completed",
			errorCode: null,
			attempts: 1,
			traceparent: TRACEPARENT,
			createdAt: "2026-11-01T10:00:03.000Z",
			claimedAt: "2026-11-01T10:00:04.000Z",
			completedAt: "2026-11-01T10:00:05.000Z",
			expiresAt: "2026-11-01T10:01:00.000Z",
		});

		// Five fixed statements, each oldest-first and bounded.
		expect(calls).toHaveLength(5);
		for (const call of calls.slice(1)) {
			expect(call.statement).toContain("ORDER BY");
			expect(call.statement).toContain("ASC");
			expect(call.statement).toContain("LIMIT $3");
		}
		expect(calls[1].params).toEqual([
			ORG_A,
			TASK_ID,
			TRACE_EVENT_DEFAULT_LIMIT,
		]);
		expect(calls[2].params).toEqual([
			ORG_A,
			TASK_ID,
			TRACE_TOOL_INVOCATION_LIMIT,
		]);
		expect(calls[3].params).toEqual([ORG_A, TASK_ID, TRACE_USAGE_LIMIT]);
		expect(calls[4].params).toEqual([
			ORG_A,
			TASK_ID,
			TRACE_CONNECTOR_CALL_LIMIT,
		]);
		// Payload columns are never selected.
		expect(calls[1].statement).not.toContain("arguments_redacted");
		expect(calls[4].statement).not.toContain("params");
		expect(calls[4].statement).not.toContain("result");
	});

	test("maxEvents defaults to 200 and clamps to 1..500", async () => {
		const limits: number[] = [];
		for (const maxEvents of [undefined, 10_000, 0, 2.9]) {
			const { sql, calls } = scriptedSql([taskExistsRow(), [], [], [], []]);
			const repository = new PostgresTraceReadRepository(sql);
			await repository.getTaskTrace(input({ maxEvents }));
			limits.push(calls[1].params[2] as number);
		}
		expect(limits).toEqual([
			TRACE_EVENT_DEFAULT_LIMIT,
			TRACE_EVENT_MAX_LIMIT,
			1,
			2,
		]);
	});

	test("fails closed on a malformed child row", async () => {
		const { sql } = scriptedSql([
			taskExistsRow(),
			[eventRow({ actor: "intruder" })],
			[],
			[],
			[],
		]);
		const repository = new PostgresTraceReadRepository(sql);
		await expect(repository.getTaskTrace(input())).rejects.toMatchObject({
			code: "DB_UNAVAILABLE",
		});
	});

	test("rejects an empty scope before any SQL", async () => {
		const { sql, calls } = scriptedSql([]);
		const repository = new PostgresTraceReadRepository(sql);
		await expect(
			repository.getTaskTrace(input({ organizationId: asOrganizationId("") })),
		).rejects.toThrow(/organizationId/);
		expect(calls).toHaveLength(0);
	});
});

describe("trace id derivation", () => {
	test("prefers the first connector traceparent, then event data", () => {
		expect(
			deriveTraceId({
				events: [{ data: { traceId: "d".repeat(32) } }],
				connectorCalls: [
					{ traceparent: null },
					{ traceparent: TRACEPARENT },
					{ traceparent: `00-${"e".repeat(32)}-${"f".repeat(16)}-01` },
				],
			}),
		).toBe(TRACE_ID);
		expect(
			deriveTraceId({
				events: [{ data: { turn: 1 } }, { data: { traceId: "d".repeat(32) } }],
				connectorCalls: [],
			}),
		).toBe("d".repeat(32));
	});

	test("ignores malformed ids instead of surfacing them", () => {
		expect(
			deriveTraceId({
				events: [
					{ data: { traceId: "NOT-A-TRACE" } },
					{ data: { traceId: 7 } },
				],
				connectorCalls: [{ traceparent: "00-short-0000-01" }],
			}),
		).toBeNull();
		expect(deriveTraceId({ events: [], connectorCalls: [] })).toBeNull();
	});
});

describe("argument hashing and data sanitisation", () => {
	test("hashes are stable across key order and change with the arguments", () => {
		const left = hashToolArguments({ b: 2, a: { d: 4, c: 3 } });
		const right = hashToolArguments({ a: { c: 3, d: 4 }, b: 2 });
		expect(left).toBe(right);
		expect(left).toMatch(/^[0-9a-f]{64}$/);
		expect(hashToolArguments({ a: { c: 3, d: 5 }, b: 2 })).not.toBe(left);
	});

	test("drops credential-shaped keys and values at any depth", () => {
		expect(
			sanitizeTraceData({
				turn: 2,
				token: FAKE_SECRET,
				nested: { authorization: "Bearer abcdefgh", ok: true },
				note: FAKE_SECRET,
				list: [{ password: "hunter2" }, "safe"],
			}),
		).toEqual({
			turn: 2,
			nested: { ok: true },
			note: null,
			list: [{}, "safe"],
		});
	});

	test("caps depth so a nested row cannot blow up the response", () => {
		let deep: Record<string, unknown> = { leaf: 1 };
		for (let index = 0; index < 10; index += 1) {
			deep = { child: deep };
		}
		expect(JSON.stringify(sanitizeTraceData(deep))).not.toContain("leaf");
	});

	test("the assembled trace never carries a secret or a payload field", async () => {
		const { sql } = scriptedSql([
			taskExistsRow(),
			[
				eventRow({
					data: { turn: 1, traceId: TRACE_ID, token: FAKE_SECRET },
				}),
			],
			[toolRow({ arguments_redacted: { token: FAKE_SECRET } })],
			[],
			[],
		]);
		const repository = new PostgresTraceReadRepository(sql);
		const trace = await repository.getTaskTrace(input());
		const text = JSON.stringify(trace);
		expect(text).not.toContain(FAKE_SECRET);
		expect(text).not.toContain("ghp_");
		expect(text).not.toContain("arguments_redacted");
		expect(text).not.toContain('"params"');
		expect(text).not.toContain('"result"');
		expect(text).not.toContain('"token"');
	});
});
