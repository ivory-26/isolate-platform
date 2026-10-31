import { describe, expect, test } from "bun:test";
import type { DatadogContextDependencies, DatadogFetchLike } from "./context";
import {
	createDatadogReadTools,
	DATADOG_TOOL_RISK_BANDS,
	datadogGetIncidentInputSchema,
	datadogGetMonitorInputSchema,
	datadogQueryMetricsInputSchema,
	datadogSearchLogsInputSchema,
	getDatadogIncident,
	getDatadogMonitor,
	queryDatadogMetrics,
	searchDatadogLogs,
} from "./tools";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const API_KEY = "redacted-sample";
const APP_KEY = "redacted-sample";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function router(status = 200): { impl: DatadogFetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const impl: DatadogFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (status !== 200) return json(status, { errors: ["unavailable"] });
		if (url.includes("/api/v2/incidents/")) {
			return json(200, {
				data: {
					id: "incident-abc",
					attributes: {
						title: "Checkout outage",
						severity: "SEV-1",
						state: "active",
					},
				},
			});
		}
		if (url.includes("/api/v1/monitor/")) {
			return json(200, {
				id: 12345,
				name: "Checkout error rate",
				type: "metric alert",
				overall_state: "Alert",
				tags: ["service:checkout", "env:prod"],
				message: "token=supersecret",
			});
		}
		if (url.endsWith("/api/v2/query/timeseries")) {
			return json(200, {
				data: {
					attributes: {
						series: [
							{
								query_index: 0,
								scope: "avg:system.cpu.user{service:checkout}",
								pointlist: [
									[NOW_MS - 60_000, 1],
									[NOW_MS, 2],
								],
							},
						],
					},
				},
			});
		}
		if (url.endsWith("/api/v2/logs/events/search")) {
			return json(200, {
				data: [
					{
						id: "log-1",
						attributes: {
							status: "error",
							service: "checkout",
							message: "raw body token=logsecret",
							attributes: {
								"error.kind": "timeout alice@example.com 10.1.2.3",
							},
						},
					},
					{
						id: "log-2",
						attributes: { status: "info", service: "checkout" },
					},
				],
			});
		}
		return json(404, { errors: ["not found"] });
	};
	return { impl, calls };
}

function dependencies(impl: DatadogFetchLike): DatadogContextDependencies {
	return {
		baseUrl: "https://api.datadoghq.com",
		apiKey: API_KEY,
		appKey: APP_KEY,
		fetchImpl: impl,
		now: () => NOW_MS,
	};
}

describe("Datadog read tools", () => {
	test("every tool is read_only and registry descriptors match", () => {
		expect(DATADOG_TOOL_RISK_BANDS).toEqual({
			"datadog.query_metrics": "read_only",
			"datadog.search_logs": "read_only",
			"datadog.get_incident": "read_only",
			"datadog.get_monitor": "read_only",
		});
		const { impl } = router();
		const tools = createDatadogReadTools(dependencies(impl));
		expect(tools.map((tool) => tool.name)).toEqual([
			"datadog.query_metrics",
			"datadog.search_logs",
			"datadog.get_incident",
			"datadog.get_monitor",
		]);
		for (const tool of tools) expect(tool.risk).toBe("read_only");
	});

	test("inputs are strict and reject model-authored queries or ranges", () => {
		for (const extra of [
			{ query: "avg:system.cpu.user{*}" },
			{ from: 0 },
			{ to: 9999999999 },
			{ site: "https://api.datadoghq.com" },
			{ apiKey: API_KEY },
			{ dashboardUrl: "https://evil.example.com" },
		]) {
			expect(
				datadogQueryMetricsInputSchema.safeParse({
					service: "checkout",
					...extra,
				}).success,
			).toBe(false);
			expect(
				datadogSearchLogsInputSchema.safeParse({
					service: "checkout",
					...extra,
				}).success,
			).toBe(false);
		}
		expect(
			datadogSearchLogsInputSchema.safeParse({
				service: "checkout",
				maxEntries: 21,
			}).success,
		).toBe(false);
		expect(
			datadogQueryMetricsInputSchema.safeParse({
				service: "bad service",
			}).success,
		).toBe(false);
		expect(
			datadogGetIncidentInputSchema.safeParse({
				incidentId: "../../admin",
			}).success,
		).toBe(false);
		expect(
			datadogGetMonitorInputSchema.safeParse({ monitorId: "12a" }).success,
		).toBe(false);
	});

	test("query_metrics returns a bounded item and a single call", async () => {
		const { impl, calls } = router();
		const result = await queryDatadogMetrics(dependencies(impl), {
			service: "checkout",
			startsAt: "2026-10-30T23:50:00Z",
		});
		expect(result.ok).toBe(true);
		expect(result.tool).toBe("datadog.query_metrics");
		expect(result.risk).toBe("read_only");
		if (result.ok) {
			expect(result.item?.kind).toBe("metrics");
			expect(result.item?.trustLevel).toBe("untrusted");
			expect(result.item?.excerpt).toContain("Series 1");
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(1500);
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(
			`${"https://api.datadoghq.com"}/api/v2/query/timeseries`,
		);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
		expect(JSON.stringify(result)).not.toContain(APP_KEY);
	});

	test("search_logs aggregates, redacts and caps without message bodies", async () => {
		const { impl, calls } = router();
		const result = await searchDatadogLogs(dependencies(impl), {
			service: "checkout",
			maxEntries: 20,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("logs");
			expect(result.item?.excerpt).toContain("Status: error=1, info=1");
			expect(result.item?.excerpt).toContain("[email-redacted]");
			expect(result.item?.excerpt).toContain("[ip-redacted]");
			expect(result.item?.excerpt).not.toContain("raw body");
			expect(result.item?.excerpt).not.toContain("logsecret");
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
		}
		expect(calls.length).toBe(1);
	});

	test("get_incident reads exactly one incident", async () => {
		const { impl, calls } = router();
		const result = await getDatadogIncident(dependencies(impl), {
			incidentId: "incident-abc",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("incident");
			expect(result.item?.excerpt).toContain("Severity: SEV-1");
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toContain("/api/v2/incidents/incident-abc");
	});

	test("get_monitor reads exactly one monitor without its message", async () => {
		const { impl, calls } = router();
		const result = await getDatadogMonitor(dependencies(impl), {
			monitorId: 12345,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("monitor");
			expect(result.item?.excerpt).toContain("State: Alert");
			expect(result.item?.excerpt).not.toContain("supersecret");
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toContain("/api/v1/monitor/12345");
	});

	test("invalid input is rejected before any provider call", async () => {
		const { impl, calls } = router();
		const result = await getDatadogIncident(dependencies(impl), {
			incidentId: "../../admin",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a validation failure");
		expect(result.code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);
	});

	test("429 maps to RATE_LIMITED with no secret-bearing output", async () => {
		const { impl } = router(429);
		const result = await queryDatadogMetrics(dependencies(impl), {
			service: "checkout",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected a rate-limit failure");
		expect(result.code).toBe("RATE_LIMITED");
		expect(result.message).toContain("rate limited");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(API_KEY);
		expect(serialized).not.toContain(APP_KEY);
	});
});
