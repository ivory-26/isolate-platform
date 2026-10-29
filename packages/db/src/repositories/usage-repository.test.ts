import { describe, expect, test } from "bun:test";
import {
	asOrganizationId,
	asTaskId,
	type UsageRecordInput,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { InMemoryUsageRepository } from "../testing/fakes";
import {
	aggregateUsageRows,
	MAX_USAGE_COST_USD,
	PostgresUsageRepository,
} from "./usage-repository";

const ORG = asOrganizationId("00000000-0000-4000-8000-000000000001");
const TASK = asTaskId("00000000-0000-4000-8000-000000000002");

function usageInput(
	overrides: Partial<UsageRecordInput> = {},
): UsageRecordInput {
	return {
		organizationId: ORG,
		taskId: TASK,
		provider: "baseten",
		modelId: "meta-models/muse-spark-open",
		promptTokens: 10,
		completionTokens: 5,
		costUsd: 0.1,
		...overrides,
	};
}

type RecordedCall = { query: string; params: readonly unknown[] };

/** Minimal PgSql stand-in: records SQL/params and returns canned rows. */
function recordingSql(resultRows: unknown[]): {
	sql: PgSql;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const sql = {
		unsafe: async (query: string, params: readonly unknown[] = []) => {
			calls.push({ query, params });
			return resultRows;
		},
	} as unknown as PgSql;
	return { sql, calls };
}

describe("aggregateUsageRows (pure helper shared by driver and fake)", () => {
	test("empty input yields zeros and a null cost", () => {
		expect(aggregateUsageRows([])).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: null,
		});
	});

	test("sums tokens and exact decimal cost without float artifacts", () => {
		// 0.1 + 0.2 must be 0.300000, not 0.30000000000000004.
		const totals = aggregateUsageRows([
			{ prompt_tokens: 100, completion_tokens: 20, cost_usd: "0.100000" },
			{ prompt_tokens: 50, completion_tokens: 5, cost_usd: 0.2 },
		]);
		expect(totals).toEqual({
			promptTokens: 150,
			completionTokens: 25,
			totalTokens: 175,
			costUsd: "0.300000",
		});
	});

	test("driver SUM row and fake stored rows produce identical totals", () => {
		// Driver: one row from COALESCE(SUM(...)) — numerics/bigints as strings.
		const driverTotals = aggregateUsageRows([
			{
				prompt_tokens: "150",
				completion_tokens: "25",
				cost_usd: "0.300000",
			},
		]);
		// Fake: the stored rows those aggregates were computed from.
		const fakeTotals = aggregateUsageRows([
			{ prompt_tokens: 100, completion_tokens: 20, cost_usd: "0.100000" },
			{ prompt_tokens: 50, completion_tokens: 5, cost_usd: "0.200000" },
		]);
		expect(driverTotals).toEqual(fakeTotals);
	});

	test("null cost rows are ignored; an all-null ledger yields null cost", () => {
		expect(
			aggregateUsageRows([
				{ prompt_tokens: 1, completion_tokens: 1, cost_usd: null },
				{ prompt_tokens: 2, completion_tokens: 2, cost_usd: "0.500000" },
			]).costUsd,
		).toBe("0.500000");
		expect(
			aggregateUsageRows([
				{ prompt_tokens: 1, completion_tokens: 1, cost_usd: null },
			]).costUsd,
		).toBeNull();
	});

	test("null token columns count as zero", () => {
		expect(
			aggregateUsageRows([
				{ prompt_tokens: null, completion_tokens: null, cost_usd: null },
				{ prompt_tokens: 3, completion_tokens: null, cost_usd: null },
			]),
		).toEqual({
			promptTokens: 3,
			completionTokens: 0,
			totalTokens: 3,
			costUsd: null,
		});
	});

	test("rejects malformed aggregate values with bounded messages", () => {
		expect(() =>
			aggregateUsageRows([
				{ prompt_tokens: -1, completion_tokens: 0, cost_usd: null },
			]),
		).toThrow("usage token aggregate is not a non-negative integer");
		expect(() =>
			aggregateUsageRows([
				{ prompt_tokens: 0, completion_tokens: 0, cost_usd: "not-money" },
			]),
		).toThrow("usage cost aggregate is not a valid decimal");
	});
});

describe("InMemoryUsageRepository (UsageRepository contract)", () => {
	test("record maps ids, tokens and the canonical cost string", async () => {
		const at = new Date("2026-01-01T00:00:00.000Z");
		const repo = new InMemoryUsageRepository(() => at);
		const row = await repo.record(
			usageInput({ promptTokens: 100, completionTokens: 25, costUsd: 0.1 }),
		);
		expect(row.organization_id).toBe(ORG);
		expect(row.task_id).toBe(TASK);
		expect(row.provider).toBe("baseten");
		expect(row.model_id).toBe("meta-models/muse-spark-open");
		expect(row.prompt_tokens).toBe(100);
		expect(row.completion_tokens).toBe(25);
		expect(row.cost_usd).toBe("0.100000");
		expect(row.created_at).toBe(at);
		expect(row.id.length).toBeGreaterThan(0);
	});

	test("record accepts null task, tokens and cost", async () => {
		const repo = new InMemoryUsageRepository();
		const row = await repo.record(
			usageInput({
				taskId: null,
				promptTokens: null,
				completionTokens: null,
				costUsd: null,
			}),
		);
		expect(row.task_id).toBeNull();
		expect(row.prompt_tokens).toBeNull();
		expect(row.completion_tokens).toBeNull();
		expect(row.cost_usd).toBeNull();
	});

	test("sumByTask aggregates one task and excludes other tasks/orgs", async () => {
		const repo = new InMemoryUsageRepository();
		const otherTask = asTaskId(crypto.randomUUID());
		const otherOrg = asOrganizationId(crypto.randomUUID());
		const otherOrgTask = asTaskId(crypto.randomUUID());
		await repo.record(
			usageInput({ promptTokens: 100, completionTokens: 20, costUsd: 0.1 }),
		);
		await repo.record(
			usageInput({ promptTokens: 50, completionTokens: 5, costUsd: 0.2 }),
		);
		await repo.record(
			usageInput({ taskId: otherTask, promptTokens: 7, costUsd: null }),
		);
		await repo.record(
			usageInput({
				organizationId: otherOrg,
				taskId: otherOrgTask,
				promptTokens: 9,
				costUsd: null,
			}),
		);
		await repo.record(
			usageInput({ taskId: null, promptTokens: 11, costUsd: null }),
		);

		expect(await repo.sumByTask(TASK)).toEqual({
			promptTokens: 150,
			completionTokens: 25,
			totalTokens: 175,
			costUsd: "0.300000",
		});
		expect((await repo.sumByTask(otherTask)).promptTokens).toBe(7);
	});

	test("sumByOrgSince is an inclusive clock window scoped to the org", async () => {
		let now = new Date("2026-01-01T00:00:00.000Z");
		const repo = new InMemoryUsageRepository(() => now);
		const otherOrg = asOrganizationId(crypto.randomUUID());
		await repo.record(
			usageInput({ promptTokens: 10, completionTokens: 1, costUsd: 0.1 }),
		);
		now = new Date("2026-01-01T01:00:00.000Z");
		await repo.record(
			usageInput({ promptTokens: 20, completionTokens: 2, costUsd: 0.2 }),
		);
		await repo.record(
			usageInput({ organizationId: otherOrg, promptTokens: 40, costUsd: 1 }),
		);

		// Inclusive lower bound: the row recorded exactly at `since` counts.
		expect(
			(await repo.sumByOrgSince(ORG, new Date("2026-01-01T01:00:00.000Z")))
				.promptTokens,
		).toBe(20);
		expect(
			(await repo.sumByOrgSince(ORG, new Date("2025-12-31T23:00:00.000Z")))
				.promptTokens,
		).toBe(30);
		expect(
			await repo.sumByOrgSince(ORG, new Date("2026-01-02T00:00:00.000Z")),
		).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: null,
		});
		expect(
			(await repo.sumByOrgSince(otherOrg, new Date("2025-12-31T23:00:00.000Z")))
				.promptTokens,
		).toBe(40);
	});

	test("rejects invalid ids, labels, tokens, cost and since with bounded errors", async () => {
		const repo = new InMemoryUsageRepository();
		const cases: Array<{
			overrides: Partial<UsageRecordInput>;
			message: string;
		}> = [
			{
				overrides: { organizationId: asOrganizationId("") },
				message: "organizationId must be a non-empty string",
			},
			{
				overrides: { taskId: asTaskId("") },
				message: "taskId must be a non-empty string",
			},
			{
				overrides: { provider: "" },
				message: "provider must be a non-empty string",
			},
			{
				overrides: { modelId: "  " },
				message: "modelId must be a non-empty string",
			},
			{
				overrides: { provider: "p".repeat(201) },
				message: "provider must be at most 200 characters",
			},
			{
				overrides: { modelId: "m".repeat(201) },
				message: "modelId must be at most 200 characters",
			},
			{
				overrides: { promptTokens: 1.5 },
				message: "promptTokens must be a non-negative integer or null",
			},
			{
				overrides: { completionTokens: -1 },
				message: "completionTokens must be a non-negative integer or null",
			},
			{
				overrides: { costUsd: -0.1 },
				message: "costUsd must be a finite non-negative number or null",
			},
			{
				overrides: { costUsd: Number.NaN },
				message: "costUsd must be a finite non-negative number or null",
			},
			{
				overrides: { costUsd: Number.POSITIVE_INFINITY },
				message: "costUsd must be a finite non-negative number or null",
			},
			{
				overrides: { costUsd: MAX_USAGE_COST_USD + 1 },
				message: "costUsd exceeds the numeric(12,6) column bound",
			},
		];
		for (const { overrides, message } of cases) {
			await expect(repo.record(usageInput(overrides))).rejects.toThrow(message);
		}
		await expect(
			repo.sumByOrgSince(ORG, "2026-01-01" as unknown as Date),
		).rejects.toThrow("since must be a valid Date");
	});

	test("validation messages never echo the supplied value", async () => {
		const repo = new InMemoryUsageRepository();
		const oversized = `${"p".repeat(200)}SUPERSECRETVALUE`;
		try {
			await repo.record(usageInput({ provider: oversized }));
			throw new Error("expected validation to reject an oversized provider");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("provider");
			expect((error as Error).message).not.toContain("SUPERSECRETVALUE");
		}
	});
});

describe("PostgresUsageRepository SQL wiring", () => {
	test("record binds a canonical numeric string and maps RETURNING", async () => {
		const createdAt = new Date("2026-01-01T00:00:00.000Z");
		const { sql, calls } = recordingSql([
			{
				id: "usage-1",
				organization_id: ORG,
				task_id: null,
				model_id: "meta-models/muse-spark-open",
				provider: "baseten",
				prompt_tokens: 100,
				completion_tokens: 25,
				cost_usd: "0.100000",
				created_at: createdAt,
			},
		]);
		const repo = new PostgresUsageRepository(sql);
		const row = await repo.record(
			usageInput({
				taskId: null,
				promptTokens: 100,
				completionTokens: 25,
				costUsd: 0.1,
			}),
		);
		expect(row.cost_usd).toBe("0.100000");
		expect(row.task_id).toBeNull();
		expect(row.created_at).toBe(createdAt);

		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.query).toContain("$7::numeric(12,6)");
		expect(call.query).not.toContain("jsonb");
		expect(call.params[6]).toBe("0.100000");
		// Integer token counts bind as numbers (never strings).
		expect(call.params[4]).toBe(100);
		expect(call.params[5]).toBe(25);
	});

	test("record validates before issuing SQL", async () => {
		const { sql, calls } = recordingSql([]);
		const repo = new PostgresUsageRepository(sql);
		await expect(repo.record(usageInput({ costUsd: -1 }))).rejects.toThrow(
			"costUsd must be a finite non-negative number or null",
		);
		expect(calls).toHaveLength(0);
	});

	test("sumByTask maps a driver SUM row (strings) through the shared helper", async () => {
		const { sql, calls } = recordingSql([
			{
				prompt_tokens: "150",
				completion_tokens: "25",
				cost_usd: "0.300000",
				has_cost: true,
			},
		]);
		const totals = await new PostgresUsageRepository(sql).sumByTask(TASK);
		expect(totals).toEqual({
			promptTokens: 150,
			completionTokens: 25,
			totalTokens: 175,
			costUsd: "0.300000",
		});
		expect(calls[0].params).toEqual([TASK]);
	});

	test("sumByTask with no cost-bearing rows reports a null cost", async () => {
		const { sql } = recordingSql([
			{
				prompt_tokens: "0",
				completion_tokens: "0",
				cost_usd: null,
				has_cost: false,
			},
		]);
		expect(await new PostgresUsageRepository(sql).sumByTask(TASK)).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: null,
		});
	});

	test("sumByOrgSince binds the org and the Date lower bound", async () => {
		const since = new Date("2026-01-01T00:00:00.000Z");
		const { sql, calls } = recordingSql([
			{
				prompt_tokens: "5",
				completion_tokens: "2",
				cost_usd: null,
				has_cost: false,
			},
		]);
		await new PostgresUsageRepository(sql).sumByOrgSince(ORG, since);
		expect(calls[0].params).toEqual([ORG, since]);
		expect(calls[0].query).toContain("created_at >= $2");
	});
});
