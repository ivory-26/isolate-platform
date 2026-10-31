import { describe, expect, test } from "bun:test";
import {
	DATADOG_ALERT_ID_PATTERN,
	DATADOG_MONITOR_ID_PATTERN,
	datadogIncidentSchema,
	datadogLogsSearchResponseSchema,
	datadogMetricsQueryResponseSchema,
	datadogMonitorSchema,
	datadogPrioritySchema,
	datadogWebhookAlertSchema,
	MAX_DATADOG_TAGS,
	parseDatadogWebhookAlert,
} from "./schemas";

const TEMPLATE = {
	id: "1234567890",
	title: "High error rate on checkout",
	priority: "P1",
	alert_type: "error",
	alert_transition: "Triggered",
	date_happened: 1793404800,
	tags: "service:checkout,env:prod,host:web-1",
	url: "https://app.datadoghq.com/event/event?id=1",
	dashboard_url: "https://app.datadoghq.com/dashboard/abc-def",
	org: "acme",
};

describe("datadogWebhookAlertSchema", () => {
	test("accepts the pinned template and normalizes tags", () => {
		const parsed = datadogWebhookAlertSchema.safeParse(TEMPLATE);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.tags).toEqual([
			"service:checkout",
			"env:prod",
			"host:web-1",
		]);
	});

	test("rejects unknown template fields, including a free-form body", () => {
		for (const extra of [
			{ body: "raw text" },
			{ text: "raw text" },
			{ message: "raw text" },
			{ responders: ["alice@example.com"] },
			{ nested: { secret: "x" } },
		]) {
			expect(
				datadogWebhookAlertSchema.safeParse({ ...TEMPLATE, ...extra }).success,
			).toBe(false);
		}
	});

	test("rejects a missing org, title, id or date", () => {
		const withoutOrg: Record<string, unknown> = { ...TEMPLATE };
		delete withoutOrg.org;
		expect(datadogWebhookAlertSchema.safeParse(withoutOrg).success).toBe(false);
		for (const key of ["title", "id", "date_happened"] as const) {
			const candidate: Record<string, unknown> = { ...TEMPLATE };
			delete candidate[key];
			expect(datadogWebhookAlertSchema.safeParse(candidate).success).toBe(
				false,
			);
		}
	});

	test("bounds tag count and tag text", () => {
		const tags = Array.from(
			{ length: MAX_DATADOG_TAGS },
			(_, index) => `t${index}`,
		);
		expect(
			datadogWebhookAlertSchema.safeParse({ ...TEMPLATE, tags }).success,
		).toBe(true);
		expect(
			datadogWebhookAlertSchema.safeParse({
				...TEMPLATE,
				tags: [...tags, "one-too-many"],
			}).success,
		).toBe(false);
		expect(
			datadogWebhookAlertSchema.safeParse({
				...TEMPLATE,
				tags: "x".repeat(4001),
			}).success,
		).toBe(false);
	});

	test("priority accepts only P1..P5, case-insensitively", () => {
		expect(datadogPrioritySchema.parse("p4")).toBe("P4");
		expect(datadogPrioritySchema.safeParse("P6").success).toBe(false);
		expect(datadogPrioritySchema.safeParse("1").success).toBe(false);
	});

	test("accepts epoch seconds, epoch millis or an ISO date", () => {
		const iso = "2026-10-31T00:00:00.000Z";
		for (const date of [1793404800, "1793404800", "1793404800000", iso]) {
			const parsed = parseDatadogWebhookAlert({
				...TEMPLATE,
				date_happened: date,
			});
			expect(parsed).not.toBeNull();
			expect(parsed?.dateHappenedMs).toBe(Date.parse(iso));
		}
	});

	test("parses a raw alert body defensively without modelling text/body", () => {
		const parsed = parseDatadogWebhookAlert({
			id: "evt-1",
			title: "CPU high",
			priority: "P2",
			alert_type: "warning",
			date_happened: 1793404800,
			tags: ["service:checkout"],
			text: "raw event body",
			body: "raw body",
			message: "raw message",
			unknown_field: { nested: true },
		});
		expect(parsed).not.toBeNull();
		expect(parsed?.priority).toBe("P2");
		expect(parsed?.tags).toEqual(["service:checkout"]);
		expect(JSON.stringify(parsed)).not.toContain("raw");
	});

	test("a template-shaped body with an unknown field is rejected", () => {
		expect(
			parseDatadogWebhookAlert({ ...TEMPLATE, body: "raw text" }),
		).toBeNull();
	});

	test("rejects invalid JSON, oversize input and a missing id", () => {
		expect(parseDatadogWebhookAlert("{")).toBeNull();
		expect(parseDatadogWebhookAlert("x".repeat(64 * 1024 + 1))).toBeNull();
		expect(parseDatadogWebhookAlert({ ...TEMPLATE, id: undefined })).toBeNull();
		expect(DATADOG_ALERT_ID_PATTERN.test("../../etc")).toBe(false);
		expect(DATADOG_MONITOR_ID_PATTERN.test("12a")).toBe(false);
	});
});

describe("Datadog response schemas", () => {
	test("metrics response keeps bounded points and strips unknown fields", () => {
		const parsed = datadogMetricsQueryResponseSchema.safeParse({
			data: {
				type: "timeseries_response",
				attributes: {
					series: [
						{
							query_index: 0,
							aggr: "avg",
							scope: "avg:system.cpu.user{service:checkout}",
							pointlist: [
								[1761955200000, 1.5],
								[1761955260000, null],
								[1761955320000, 2.5],
							],
							unknown: "dropped",
						},
					],
					query: "avg:system.cpu.user{service:checkout}",
				},
			},
		});
		expect(parsed.success).toBe(true);
		expect(
			parsed.success && parsed.data.data?.attributes?.series?.[0]?.pointlist,
		).toHaveLength(3);
		expect(
			parsed.success &&
				"unknown" in (parsed.data.data?.attributes?.series?.[0] ?? {}),
		).toBe(false);
	});

	test("logs response strips message and keeps only aggregate attributes", () => {
		const parsed = datadogLogsSearchResponseSchema.safeParse({
			data: [
				{
					id: "log-1",
					type: "log",
					attributes: {
						timestamp: "2026-10-31T00:00:00.000Z",
						status: "error",
						service: "checkout",
						message: "raw log body with token=abc",
						attributes: {
							"error.kind": "timeout",
							"http.status_code": "504",
						},
					},
				},
			],
			meta: { page: { after: "next-cursor" } },
		});
		expect(parsed.success).toBe(true);
		expect(
			parsed.success && "message" in (parsed.data.data?.[0]?.attributes ?? {}),
		).toBe(false);
		expect(JSON.stringify(parsed.success && parsed.data)).not.toContain(
			"raw log body",
		);
	});

	test("incident and monitor responses drop notes and message bodies", () => {
		const incident = datadogIncidentSchema.safeParse({
			data: {
				id: "incident-abc",
				type: "incidents",
				attributes: {
					title: "Checkout outage",
					severity: "SEV-1",
					state: "active",
					created: "2026-10-30T23:50:00.000Z",
					notes: ["responder note"],
					responders: [{ email: "alice@example.com" }],
				},
			},
		});
		expect(incident.success).toBe(true);
		expect(JSON.stringify(incident.success && incident.data)).not.toContain(
			"alice",
		);

		const monitor = datadogMonitorSchema.safeParse({
			id: 12345,
			name: "Checkout errors",
			type: "metric alert",
			overall_state: "Alert",
			tags: ["service:checkout"],
			message: "notify @slack-secret-webhook",
			options: { webhook_url: "https://hooks.example.com/secret" },
		});
		expect(monitor.success).toBe(true);
		expect(JSON.stringify(monitor.success && monitor.data)).not.toContain(
			"secret-webhook",
		);
	});
});
