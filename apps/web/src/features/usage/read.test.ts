import { describe, expect, test } from "bun:test";
import { readUsage, type UsageReadSql } from "../../server/usage-read.server";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-15T12:00:00.000Z");

type Call = { query: string; parameters: readonly unknown[] };

function fakeSql(): { sql: UsageReadSql; calls: Call[] } {
	const calls: Call[] = [];
	const sql: UsageReadSql = {
		async unsafe(query: string, parameters?: readonly unknown[]) {
			calls.push({ query, parameters: parameters ?? [] });
			if (query.includes("task_attempts")) {
				return [{ day: "2026-11-14", sandbox_seconds: "42.5" }];
			}
			if (query.includes("AS tasks")) {
				return [{ tasks: 3 }];
			}
			return [
				{
					day: "2026-11-14",
					prompt_tokens: "10",
					completion_tokens: "5",
					cost_usd: "0.010000",
					known_cost_rows: 1,
					total_rows: 1,
				},
			];
		},
	};
	return { sql, calls };
}

describe("readUsage", () => {
	test("binds the organization and the server-resolved UTC window to every query", async () => {
		const { sql, calls } = fakeSql();
		const model = await readUsage(sql, ORG, 7, NOW);
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.parameters[0]).toBe(ORG);
			expect(call.parameters[1]).toEqual(new Date("2026-11-09T00:00:00.000Z"));
			expect(call.parameters[2]).toEqual(new Date("2026-11-16T00:00:00.000Z"));
		}
		expect(model.period).toBe(7);
		expect(model.totals).toMatchObject({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			sandboxSeconds: 42,
			costUsd: "0.010000",
			tasks: 3,
		});
	});

	test("fails closed when the driver returns an unexpected shape", async () => {
		const sql: UsageReadSql = {
			async unsafe() {
				return { rows: [] };
			},
		};
		await expect(readUsage(sql, ORG, 7, NOW)).rejects.toThrow(
			"unexpected row shape",
		);
	});

	test("maps a missing sandbox result to zero seconds", async () => {
		const sql: UsageReadSql = {
			async unsafe(query: string) {
				if (query.includes("task_attempts")) return [];
				if (query.includes("AS tasks")) return [];
				return [];
			},
		};
		const model = await readUsage(sql, ORG, 30, NOW);
		expect(model.totals.sandboxSeconds).toBe(0);
		expect(model.hasRows).toBe(false);
	});
});
