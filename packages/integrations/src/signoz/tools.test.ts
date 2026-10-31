import { describe, expect, test } from "bun:test";
import type { SignozContextDependencies } from "./context";
import {
	createSignozReadTools,
	getSignozRule,
	listSignozRules,
	querySignozRange,
	SIGNOZ_TOOL_RISK_BANDS,
} from "./tools";

const BASE = "https://signoz.example.com";
const API_KEY = "signoz-read-key-0123456789";
const NOW_MS = Date.parse("2026-10-31T12:00:00.000Z");
const RULE_ID = "a1b2c3d4-0000-1111-2222-333344445555";
const PROMQL = 'sum(rate(http_requests_total{service_name="checkout"}[5m]))';

function deps(
	status = 200,
	body: unknown = {
		status: "success",
		data: {
			data: {
				results: [
					{
						queryName: "A",
						series: [
							{
								labels: { service_name: "checkout" },
								values: [{ timestamp: NOW_MS - 60_000, value: "3.5" }],
							},
						],
					},
				],
			},
		},
	},
): SignozContextDependencies {
	return {
		baseUrl: BASE,
		apiKey: API_KEY,
		now: () => NOW_MS,
		fetchImpl: async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	};
}

describe("signoz.read_only tool bounds", () => {
	test("query_range rejects unbounded expressions and unknown arguments", async () => {
		for (const input of [
			{ service: "checkout", query: `${PROMQL}\n` },
			{ service: "checkout", query: "up; drop table" },
			{ service: "checkout", query: "up /* hidden */" },
			{ service: "checkout", query: "a".repeat(501) },
			{ service: "checkout", query: PROMQL, datasource: "metrics" },
			{ service: "checkout", query: PROMQL, windowMinutes: 600 },
			{ service: "", query: PROMQL },
		]) {
			const result = await querySignozRange(deps(), input);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.code).toBe("VALIDATION_FAILED");
			expect(result.risk).toBe("read_only");
		}
	});

	test("get_rule accepts only a SigNoz rule id", async () => {
		for (const input of [
			{ ruleId: "bad rule id" },
			{ ruleId: "../etc/passwd" },
			{ ruleId: "" },
			{ ruleId: RULE_ID, extra: true },
		]) {
			const result = await getSignozRule(deps(), input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("VALIDATION_FAILED");
		}
	});

	test("list_rules caps the limit at 20 and rejects unknown filters", async () => {
		for (const input of [
			{ limit: 21 },
			{ limit: 0 },
			{ state: "x".repeat(65) },
			{ repo: "x" },
		]) {
			const result = await listSignozRules(deps(), input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("VALIDATION_FAILED");
		}
	});
});

describe("signoz tool results", () => {
	test("query_range returns a redacted, bounded read-only item", async () => {
		const result = await querySignozRange(deps(), {
			service: "checkout",
			query: PROMQL,
			windowMinutes: 30,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.risk).toBe("read_only");
		expect(result.item?.kind).toBe("metrics");
		expect(result.item?.source).toBe("signoz");
		expect(result.item?.trustLevel).toBe("untrusted");
		expect(result.item?.excerpt.length).toBeLessThanOrEqual(1500);
	});

	test("maps a provider rejection to a bounded failure", async () => {
		const result = await querySignozRange(deps(401, { status: "error" }), {
			service: "checkout",
			query: PROMQL,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(result.risk).toBe("read_only");
		expect(result.message).not.toContain(API_KEY);
	});

	test("get_rule returns a rule item and list_rules a bounded summary", async () => {
		const ruleResult = await getSignozRule(
			deps(200, {
				status: "success",
				data: {
					id: RULE_ID,
					alertName: "HighErrorRate",
					ruleType: "promql_rule",
				},
			}),
			{ ruleId: RULE_ID },
		);
		expect(ruleResult.ok).toBe(true);
		if (ruleResult.ok) expect(ruleResult.item?.kind).toBe("alert_rule");

		const listResult = await listSignozRules(
			deps(200, {
				status: "success",
				data: {
					rules: [
						{
							id: RULE_ID,
							alertName: "A",
							ruleType: "promql_rule",
							state: "firing",
						},
						{
							id: "rule-2",
							alertName: "B",
							ruleType: "promql_rule",
							state: "firing",
						},
					],
				},
			}),
			{ limit: 1 },
		);
		expect(listResult.ok).toBe(true);
		if (!listResult.ok) return;
		expect(listResult.item?.kind).toBe("rule_list");
		expect(listResult.truncated).toBe(true);
	});
});

describe("createSignozReadTools", () => {
	test("exposes three read-only descriptors that reject unknown keys", () => {
		const tools = createSignozReadTools(deps());
		expect(tools.map((tool) => tool.name)).toEqual([
			"signoz.query_range",
			"signoz.get_rule",
			"signoz.list_rules",
		]);
		for (const tool of tools) {
			expect(tool.risk).toBe("read_only");
			expect(SIGNOZ_TOOL_RISK_BANDS[tool.name]).toBe("read_only");
			expect(tool.inputSchema.safeParse({ unexpected: true }).success).toBe(
				false,
			);
		}
	});
});
