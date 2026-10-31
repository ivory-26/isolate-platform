import { describe, expect, test } from "bun:test";
import {
	isBoundedSignozPromql,
	MAX_SIGNOZ_ALERTS,
	MAX_SIGNOZ_LABEL_KEYS,
	parseSignozWebhookPayload,
	signozQueryRangeRequestSchema,
	signozQueryRangeResponseSchema,
	signozRuleListResponseSchema,
	signozWebhookPayloadSchema,
} from "./schemas";

function alert(index = 0): Record<string, unknown> {
	return {
		status: "firing",
		labels: { alertname: `Alert-${index}`, "service.name": "api" },
		startsAt: "2026-10-31T11:00:00.000Z",
	};
}

describe("signozWebhookPayloadSchema", () => {
	test("accepts a bounded firing payload", () => {
		const parsed = signozWebhookPayloadSchema.safeParse({
			alerts: [alert()],
			status: "firing",
			fingerprint: "delivery-1",
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects unknown top-level and alert-level fields", () => {
		expect(
			signozWebhookPayloadSchema.safeParse({ alerts: [alert()], extra: 1 })
				.success,
		).toBe(false);
		expect(
			signozWebhookPayloadSchema.safeParse({
				alerts: [{ ...alert(), injected: "x" }],
			}).success,
		).toBe(false);
	});

	test("bounds the alert count, label count and label value", () => {
		expect(
			signozWebhookPayloadSchema.safeParse({
				alerts: Array.from({ length: MAX_SIGNOZ_ALERTS + 1 }, (_, index) =>
					alert(index),
				),
			}).success,
		).toBe(false);
		const manyLabels = Object.fromEntries(
			Array.from({ length: MAX_SIGNOZ_LABEL_KEYS + 1 }, (_, index) => [
				`label_${index}`,
				"value",
			]),
		);
		expect(
			signozWebhookPayloadSchema.safeParse({
				alerts: [{ labels: manyLabels }],
			}).success,
		).toBe(false);
		expect(
			signozWebhookPayloadSchema.safeParse({
				alerts: [{ labels: { alertname: "a".repeat(513) } }],
			}).success,
		).toBe(false);
	});

	test("parseSignozWebhookPayload handles strings, objects and garbage", () => {
		expect(
			parseSignozWebhookPayload(JSON.stringify({ alerts: [alert()] })),
		).not.toBeNull();
		expect(parseSignozWebhookPayload({ alerts: [alert()] })).not.toBeNull();
		expect(parseSignozWebhookPayload("not json")).toBeNull();
		expect(parseSignozWebhookPayload(null)).toBeNull();
		expect(parseSignozWebhookPayload({ alerts: [] })).toBeNull();
	});
});

describe("provider response allowlists", () => {
	test("strips unknown fields from a query_range response", () => {
		const parsed = signozQueryRangeResponseSchema.safeParse({
			status: "success",
			unknownTop: true,
			data: {
				type: "time_series",
				unknownEnvelope: true,
				data: {
					results: [
						{
							queryName: "A",
							unknownResult: true,
							series: [
								{
									labels: { service_name: "api" },
									values: [{ timestamp: 1, value: "1.5", extra: true }],
									unknownSeries: true,
								},
							],
						},
					],
				},
			},
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.data?.data?.results?.[0]?.series?.[0]?.labels).toEqual({
			service_name: "api",
		});
	});

	test("rule list accepts null rows and strips definitions not in the allowlist", () => {
		const parsed = signozRuleListResponseSchema.safeParse({
			status: "success",
			data: {
				rules: [
					null,
					{
						id: "rule-1",
						alertName: "HighErrorRate",
						alert: "sum(rate(x[5m]))",
						ruleType: "promql_rule",
						state: "firing",
						channel: "https://hooks.example.com/secret",
					},
				],
			},
		});
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const rows = parsed.data.data?.rules ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBeNull();
		expect(rows[1]).not.toHaveProperty("channel");
	});
});

describe("isBoundedSignozPromql", () => {
	test("accepts ordinary single-line PromQL", () => {
		expect(
			isBoundedSignozPromql(
				'sum by (service_name) (rate(http_requests_total{status=~"5.."}[5m]))',
			),
		).toBe(true);
		expect(isBoundedSignozPromql("up")).toBe(true);
	});

	test("rejects control characters, comments, statements and template markers", () => {
		for (const value of [
			"up\n",
			"up\r",
			"up; drop",
			"up # comment",
			"up /* hidden */",
			"up `x`",
			"up $x",
			"up {{ x }}",
			"rate(✨[1m])",
			"",
			"   ",
			"a".repeat(501),
			null,
			42,
		]) {
			expect(isBoundedSignozPromql(value)).toBe(false);
		}
	});
});

describe("signozQueryRangeRequestSchema", () => {
	test("accepts exactly one PromQL query and rejects anything else", () => {
		const valid = {
			start: 1_000,
			end: 61_000,
			stepInterval: 60,
			compositeQuery: {
				queryType: "promql",
				panelType: "graph",
				promQueries: {
					A: { queryName: "A", promql: "up" },
				},
			},
		};
		expect(signozQueryRangeRequestSchema.safeParse(valid).success).toBe(true);

		expect(
			signozQueryRangeRequestSchema.safeParse({
				...valid,
				compositeQuery: {
					...valid.compositeQuery,
					queryType: "clickhouse_sql",
				},
			}).success,
		).toBe(false);
		expect(
			signozQueryRangeRequestSchema.safeParse({
				...valid,
				compositeQuery: {
					...valid.compositeQuery,
					promQueries: {
						...valid.compositeQuery.promQueries,
						B: { queryName: "B", promql: "up" },
					},
				},
			}).success,
		).toBe(false);
		expect(
			signozQueryRangeRequestSchema.safeParse({
				...valid,
				compositeQuery: {
					...valid.compositeQuery,
					promQueries: { A: { queryName: "A", promql: "up; drop" } },
				},
			}).success,
		).toBe(false);
		expect(
			signozQueryRangeRequestSchema.safeParse({ ...valid, end: valid.start })
				.success,
		).toBe(false);
		expect(
			signozQueryRangeRequestSchema.safeParse({ ...valid, stepInterval: 5 })
				.success,
		).toBe(false);
	});
});
