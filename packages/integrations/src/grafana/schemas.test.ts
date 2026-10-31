import { describe, expect, test } from "bun:test";
import {
	GRAFANA_UID_PATTERN,
	grafanaAlertGroupSchema,
	grafanaAlertRuleSchema,
	grafanaDsQueryRequestSchema,
	grafanaDsQueryResponseSchema,
	MAX_GRAFANA_ALERTS,
	MAX_GRAFANA_LABEL_VALUE_CHARS,
	parseGrafanaAlertGroup,
} from "./schemas";

function minimalGroup(alertCount = 1): Record<string, unknown> {
	return {
		status: "firing",
		alerts: Array.from({ length: alertCount }, (_, index) => ({
			status: "firing",
			labels: { alertname: `Alert${index}`, severity: "warning" },
		})),
		version: "1",
	};
}

const VALID_QUERY = {
	from: "1761955200000",
	to: "1761957000000",
	queries: [
		{
			refId: "metrics",
			datasource: { type: "prometheus", uid: "prom-uid" },
			expr: '{job="checkout"}',
			maxDataPoints: 20,
			intervalMs: 9000,
			format: "time_series",
			range: true,
		},
	],
};

describe("grafanaAlertGroupSchema", () => {
	test("accepts a bounded alert group and strips nothing on valid input", () => {
		const parsed = grafanaAlertGroupSchema.safeParse(minimalGroup(2));
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.alerts).toHaveLength(2);
	});

	test("rejects unknown top-level and alert fields", () => {
		expect(
			grafanaAlertGroupSchema.safeParse({
				...minimalGroup(),
				unexpected: true,
			}).success,
		).toBe(false);
		expect(
			grafanaAlertGroupSchema.safeParse({
				status: "firing",
				alerts: [{ status: "firing", labels: {}, line: "x" }],
			}).success,
		).toBe(false);
	});

	test("bounds the number of alerts and label values", () => {
		expect(
			grafanaAlertGroupSchema.safeParse(minimalGroup(MAX_GRAFANA_ALERTS + 1))
				.success,
		).toBe(false);
		expect(
			grafanaAlertGroupSchema.safeParse({
				status: "firing",
				alerts: [
					{
						status: "firing",
						labels: {
							alertname: "x".repeat(MAX_GRAFANA_LABEL_VALUE_CHARS + 1),
						},
					},
				],
			}).success,
		).toBe(false);
	});

	test("parses a raw JSON body but not an oversized or invalid one", () => {
		expect(
			parseGrafanaAlertGroup(JSON.stringify(minimalGroup())),
		).not.toBeNull();
		expect(parseGrafanaAlertGroup("{")).toBeNull();
		expect(parseGrafanaAlertGroup("x".repeat(64 * 1024 + 1))).toBeNull();
	});
});

describe("datasource query schemas", () => {
	test("accepts a trusted template request and rejects free-form fields", () => {
		expect(grafanaDsQueryRequestSchema.safeParse(VALID_QUERY).success).toBe(
			true,
		);
		expect(
			grafanaDsQueryRequestSchema.safeParse({
				...VALID_QUERY,
				expr: "up",
			}).success,
		).toBe(false);
		expect(
			grafanaDsQueryRequestSchema.safeParse({
				...VALID_QUERY,
				queries: [
					{
						...VALID_QUERY.queries[0],
						maxDataPoints: 21,
					},
				],
			}).success,
		).toBe(false);
		expect(
			grafanaDsQueryRequestSchema.safeParse({
				...VALID_QUERY,
				queries: [
					{
						...VALID_QUERY.queries[0],
						datasource: { type: "prometheus", uid: "../etc" },
					},
				],
			}).success,
		).toBe(false);
		expect(
			grafanaDsQueryRequestSchema.safeParse({
				...VALID_QUERY,
				queries: [
					{
						...VALID_QUERY.queries[0],
						datasource: { type: "loki", uid: "loki-uid" },
						format: "table",
						queryType: "range",
						maxLines: 200,
					},
				],
			}).success,
		).toBe(true);
	});

	test("accepts a bounded response allowlist and drops unknown fields", () => {
		const parsed = grafanaDsQueryResponseSchema.safeParse({
			results: {
				metrics: {
					status: 200,
					unknown: "dropped",
					frames: [
						{
							schema: {
								fields: [
									{ name: "Time", type: "time" },
									{ name: "Value", type: "number", labels: { job: "api" } },
								],
							},
							data: {
								values: [
									[1, 2],
									[3, 4],
								],
							},
						},
					],
				},
			},
		});
		expect(parsed.success).toBe(true);
		expect(
			parsed.success && "unknown" in (parsed.data.results?.metrics ?? {}),
		).toBe(false);
	});

	test("alert-rule responses are allowlisted and bounded", () => {
		const parsed = grafanaAlertRuleSchema.safeParse({
			uid: "rule-abc",
			title: "High error rate",
			for: "5m",
			labels: { severity: "critical" },
			annotations: { summary: "errors" },
			unknownField: { nested: true },
		});
		expect(parsed.success).toBe(true);
		expect(parsed.success && "unknownField" in parsed.data).toBe(false);
		expect(parsed.success && parsed.data.uid).toBe("rule-abc");
	});

	test("UID pattern accepts Grafana-shaped ids only", () => {
		expect(GRAFANA_UID_PATTERN.test("abc_DEF-123")).toBe(true);
		expect(GRAFANA_UID_PATTERN.test("../abc")).toBe(false);
		expect(GRAFANA_UID_PATTERN.test("")).toBe(false);
	});
});
