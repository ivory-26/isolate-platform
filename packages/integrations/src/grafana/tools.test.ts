import { describe, expect, test } from "bun:test";
import type { GrafanaContextDependencies, GrafanaFetchLike } from "./context";
import {
	createGrafanaReadTools,
	GRAFANA_TOOL_RISK_BANDS,
	getGrafanaAlertRule,
	grafanaGetAlertRuleInputSchema,
	grafanaQueryLogsInputSchema,
	grafanaQueryMetricsInputSchema,
	queryGrafanaLogs,
	queryGrafanaMetrics,
} from "./tools";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const TOKEN = "glsa_w16tools0123456789abcdef";
const RULE_UID = "rule-checkout-errors";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function router(status = 200): { impl: GrafanaFetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const impl: GrafanaFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (status !== 200) return json(status, { message: "unavailable" });
		if (url.includes("/api/v1/provisioning/alert-rules/")) {
			return json(200, {
				uid: RULE_UID,
				title: "Checkout error rate",
				condition: "C",
				for: "5m",
				labels: { severity: "critical" },
				annotations: { summary: "errors" },
			});
		}
		if (url.endsWith("/api/ds/query")) {
			return json(200, {
				results: {
					metrics: {
						status: 200,
						frames: [
							{
								schema: {
									fields: [
										{ name: "Time", type: "time" },
										{
											name: "Value",
											type: "number",
											labels: { job: "checkout" },
										},
									],
								},
								data: {
									values: [
										[NOW_MS - 60_000, NOW_MS],
										[1, 2],
									],
								},
							},
						],
					},
					logs: {
						status: 200,
						frames: [
							{
								schema: {
									fields: [
										{ name: "Time", type: "time" },
										{ name: "Line", type: "string" },
									],
								},
								data: {
									values: [
										[NOW_MS - 1000, NOW_MS],
										[
											"request failed token=glsa_abcdefghijklmnopqrstuvwxyz",
											"retry succeeded",
										],
									],
								},
							},
						],
					},
				},
			});
		}
		return json(404, { message: "not found" });
	};
	return { impl, calls };
}

function dependencies(impl: GrafanaFetchLike): GrafanaContextDependencies {
	return {
		baseUrl: "https://grafana.example.com",
		token: TOKEN,
		orgId: 1,
		metricsDatasourceUid: "prom-uid",
		logsDatasourceUid: "loki-uid",
		fetchImpl: impl,
		now: () => NOW_MS,
	};
}

describe("Grafana read tools", () => {
	test("every tool is read_only and registry descriptors match", () => {
		expect(GRAFANA_TOOL_RISK_BANDS).toEqual({
			"grafana.query_metrics": "read_only",
			"grafana.query_logs": "read_only",
			"grafana.get_alert_rule": "read_only",
		});
		const { impl } = router();
		const tools = createGrafanaReadTools(dependencies(impl));
		expect(tools.map((tool) => tool.name)).toEqual([
			"grafana.query_metrics",
			"grafana.query_logs",
			"grafana.get_alert_rule",
		]);
		for (const tool of tools) expect(tool.risk).toBe("read_only");
	});

	test("inputs are strict and reject model-authored queries or ranges", () => {
		expect(
			grafanaQueryMetricsInputSchema.safeParse({
				service: "checkout",
				expr: "up",
			}).success,
		).toBe(false);
		expect(
			grafanaQueryMetricsInputSchema.safeParse({
				service: "checkout",
				datasource: { uid: "x" },
			}).success,
		).toBe(false);
		expect(
			grafanaQueryMetricsInputSchema.safeParse({
				service: "checkout",
				from: "0",
				to: "9999999999999",
			}).success,
		).toBe(false);
		expect(
			grafanaQueryMetricsInputSchema.safeParse({
				service: "checkout",
				windowMinutes: 5,
			}).success,
		).toBe(false);
		expect(
			grafanaQueryLogsInputSchema.safeParse({
				service: "checkout",
				maxLines: 201,
			}).success,
		).toBe(false);
		expect(
			grafanaGetAlertRuleInputSchema.safeParse({ ruleUid: "../../admin" })
				.success,
		).toBe(false);
	});

	test("query_metrics returns a bounded item and a single datasource call", async () => {
		const { impl, calls } = router();
		const result = await queryGrafanaMetrics(dependencies(impl), {
			service: "checkout",
			startsAt: "2026-10-30T23:50:00Z",
		});
		expect(result.ok).toBe(true);
		expect(result.tool).toBe("grafana.query_metrics");
		expect(result.risk).toBe("read_only");
		if (result.ok) {
			expect(result.item?.kind).toBe("metrics");
			expect(result.item?.trustLevel).toBe("untrusted");
			expect(result.item?.excerpt).toContain("Series 1");
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(1500);
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://grafana.example.com/api/ds/query");
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("query_logs redacts credentials and caps the tail", async () => {
		const { impl, calls } = router();
		const result = await queryGrafanaLogs(dependencies(impl), {
			service: "checkout",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("logs");
			expect(result.item?.excerpt).toContain("[auth-redacted]");
			expect(result.item?.excerpt).not.toContain(
				"glsa_abcdefghijklmnopqrstuvwxyz",
			);
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
		}
		expect(calls.length).toBe(1);
	});

	test("get_alert_rule reads exactly one rule and never echoes the token", async () => {
		const { impl, calls } = router();
		const result = await getGrafanaAlertRule(dependencies(impl), {
			ruleUid: RULE_UID,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("alert_rule");
			expect(result.item?.excerpt).toContain("Condition: C");
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toContain(
			`/api/v1/provisioning/alert-rules/${RULE_UID}`,
		);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("invalid input is rejected before any provider call", async () => {
		const { impl, calls } = router();
		const result = await getGrafanaAlertRule(dependencies(impl), {
			ruleUid: "../../admin",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a validation failure");
		expect(result.code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);
	});

	test("429 maps to RATE_LIMITED with no secret-bearing output", async () => {
		const { impl } = router(429);
		const result = await queryGrafanaMetrics(dependencies(impl), {
			service: "checkout",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a rate-limit failure");
		expect(result.code).toBe("RATE_LIMITED");
		expect(result.message).toContain("rate limited");
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});
});
