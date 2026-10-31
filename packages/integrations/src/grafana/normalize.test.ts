import { describe, expect, test } from "bun:test";
import {
	GRAFANA_FIRING_INCIDENT_KIND,
	grafanaIncidentFingerprint,
	grafanaRuleUidFromGeneratorUrl,
	grafanaSeverityOf,
	isGrafanaProductionEnvironment,
	normalizeGrafanaIncident,
} from "./normalize";
import type { GrafanaAlert, GrafanaAlertGroup } from "./schemas";

const RULE_UID = "rule-checkout-errors";
const GENERATOR = `https://grafana.example.com/alerting/grafana/${RULE_UID}/view`;
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";

function alert(overrides: Partial<GrafanaAlert> = {}): GrafanaAlert {
	return {
		status: "firing",
		labels: {
			alertname: "HighErrorRate",
			severity: "critical",
			environment: "production",
			service: "checkout",
			job: "checkout-api",
			instance: "10.0.0.1:8080",
			customer_id: "acme",
		},
		annotations: {
			summary: "Checkout errors are above the SLO",
			description: "5xx rate is 12% for the last 10 minutes",
			runbook_url: "https://runbooks.example.com/checkout",
		},
		startsAt: "2026-10-30T23:50:00Z",
		generatorURL: GENERATOR,
		fingerprint: "alert-fingerprint-1",
		dashboardURL: "https://grafana.example.com/d/checkout?viewPanel=2",
		panelURL: "https://grafana.example.com/d/checkout?viewPanel=2&panelId=4",
		...overrides,
	};
}

function group(
	alerts: GrafanaAlert[],
	overrides: Partial<GrafanaAlertGroup> = {},
): unknown {
	return {
		receiver: "isolate",
		status: "firing",
		orgId: 1,
		alerts,
		groupLabels: { alertname: "HighErrorRate" },
		commonLabels: { environment: "production" },
		commonAnnotations: {},
		externalURL: "https://grafana.example.com",
		version: "1",
		groupKey: '{}:{alertname="HighErrorRate"}',
		truncatedAlerts: 0,
		title: "HighErrorRate",
		message: "alert group",
		...overrides,
	};
}

describe("normalizeGrafanaIncident", () => {
	test("normalizes the highest-severity firing production alert", () => {
		const signal = normalizeGrafanaIncident(
			group([
				alert({
					labels: { ...alert().labels, severity: "warning" },
					fingerprint: "warning-alert",
				}),
				alert(),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(signal).not.toBeNull();
		expect(signal?.source).toBe("grafana");
		expect(signal?.kind).toBe(GRAFANA_FIRING_INCIDENT_KIND);
		expect(signal?.severity).toBe("critical");
		expect(signal?.service).toBe("checkout");
		expect(signal?.fingerprint.startsWith(`grafana:${RULE_UID}:`)).toBe(true);
		expect(signal?.receivedAt).toBe(RECEIVED_AT);
		expect(signal?.summary).toContain("5xx rate is 12%");
		expect(signal?.links.map((link) => link.label)).toEqual([
			"Dashboard",
			"Panel",
			"Alert rule",
		]);
	});

	test("maps source severity deterministically", () => {
		expect(grafanaSeverityOf("critical")).toBe("critical");
		expect(grafanaSeverityOf("error")).toBe("high");
		expect(grafanaSeverityOf("warning")).toBe("medium");
		expect(grafanaSeverityOf("info")).toBe("low");
		expect(grafanaSeverityOf("low")).toBe("low");
		expect(grafanaSeverityOf(undefined)).toBe("medium");
	});

	test("creates nothing for resolved, info, nodata or non-production groups", () => {
		expect(
			normalizeGrafanaIncident(group([alert()], { status: "resolved" }), {
				receivedAt: RECEIVED_AT,
			}),
		).toBeNull();
		expect(
			normalizeGrafanaIncident(
				group([alert({ labels: { ...alert().labels, severity: "info" } })]),
				{ receivedAt: RECEIVED_AT },
			),
		).toBeNull();
		expect(
			normalizeGrafanaIncident(
				group([
					alert({
						labels: {
							...alert().labels,
							alertname: "DatasourceNoData",
							severity: "warning",
						},
					}),
				]),
				{ receivedAt: RECEIVED_AT },
			),
		).toBeNull();
		expect(
			normalizeGrafanaIncident(
				group([
					alert({
						labels: {
							...alert().labels,
							severity: "warning",
							environment: "staging",
						},
					}),
				]),
				{ receivedAt: RECEIVED_AT },
			),
		).toBeNull();
		expect(
			normalizeGrafanaIncident(group([alert({ status: "resolved" })]), {
				receivedAt: RECEIVED_AT,
			}),
		).toBeNull();
	});

	test("selects production alerts from a mixed group", () => {
		const signal = normalizeGrafanaIncident(
			group([
				alert({
					labels: {
						...alert().labels,
						severity: "critical",
						environment: "staging",
					},
				}),
				alert({
					labels: { ...alert().labels, severity: "warning" },
					fingerprint: "prod-warning",
				}),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(signal?.severity).toBe("medium");
		expect(signal?.summary).toContain("Environment: production");
	});

	test("ties break deterministically by rule UID", () => {
		const make = (ruleUid: string, fingerprint: string) =>
			alert({
				generatorURL: `https://grafana.example.com/alerting/grafana/${ruleUid}/view`,
				fingerprint,
			});
		const forward = normalizeGrafanaIncident(
			group([make("rule-b", "b"), make("rule-a", "a")]),
			{ receivedAt: RECEIVED_AT },
		);
		const reverse = normalizeGrafanaIncident(
			group([make("rule-a", "a"), make("rule-b", "b")]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(forward?.fingerprint).toBe(reverse?.fingerprint);
		expect(forward?.fingerprint.startsWith("grafana:rule-a:")).toBe(true);
	});

	test("fingerprint is stable under label churn but changes with the stable subset", () => {
		const base = alert();
		const churned = alert({
			labels: {
				...base.labels,
				pod: "checkout-7f9c",
				trace_id: "abc123",
				severity: "critical",
			},
			fingerprint: "different-alert-fingerprint",
			annotations: { summary: "changed" },
		});
		const first = normalizeGrafanaIncident(group([base]), {
			receivedAt: RECEIVED_AT,
		});
		const second = normalizeGrafanaIncident(
			group([churned], { groupKey: "different-group-key" }),
			{ receivedAt: RECEIVED_AT },
		);
		expect(first?.fingerprint).toBe(second?.fingerprint);

		const otherService = normalizeGrafanaIncident(
			group([alert({ labels: { ...base.labels, service: "payments" } })]),
			{ receivedAt: RECEIVED_AT },
		);
		const otherEnvironment = normalizeGrafanaIncident(
			group([
				alert({
					labels: { ...base.labels, environment: "prod" },
				}),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(first?.fingerprint).not.toBe(otherService?.fingerprint);
		expect(first?.fingerprint).not.toBe(otherEnvironment?.fingerprint);
	});

	test("a trusted rule UID overrides the generator URL", () => {
		const signal = normalizeGrafanaIncident(group([alert()]), {
			ruleUid: "trusted-rule-uid",
			receivedAt: RECEIVED_AT,
		});
		expect(signal?.fingerprint.startsWith("grafana:trusted-rule-uid:")).toBe(
			true,
		);
	});

	test("extracts a rule UID only from supported generator URL shapes", () => {
		expect(
			grafanaRuleUidFromGeneratorUrl(
				"https://grafana.example.com/alerting/grafana/abc_123/view",
			),
		).toBe("abc_123");
		expect(
			grafanaRuleUidFromGeneratorUrl(
				"https://grafana.example.com/alerting/rule/def-456",
			),
		).toBe("def-456");
		expect(
			grafanaRuleUidFromGeneratorUrl(
				"https://grafana.example.com/graph?ruleUID=ghi789",
			),
		).toBe("ghi789");
		expect(
			grafanaRuleUidFromGeneratorUrl(
				"https://grafana.example.com/d/abc?viewPanel=2",
			),
		).toBeNull();
		expect(grafanaRuleUidFromGeneratorUrl("not a url")).toBeNull();
	});

	test("drops http, credential-bearing and duplicate links", () => {
		const signal = normalizeGrafanaIncident(
			group([
				alert({
					dashboardURL: "http://grafana.internal/d/abc",
					panelURL: "https://user:pass@grafana.example.com/d/abc",
					silenceURL: GENERATOR,
					generatorURL: GENERATOR,
				}),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(signal?.links).toEqual([{ label: "Alert rule", url: GENERATOR }]);
	});

	test("strips credential query parameters from display links", () => {
		const signal = normalizeGrafanaIncident(
			group([
				alert({
					dashboardURL:
						"https://grafana.example.com/d/checkout?viewPanel=2&token=secret",
					generatorURL: `${GENERATOR}?token=secret`,
				}),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		const dashboard = signal?.links.find((link) => link.label === "Dashboard");
		expect(dashboard?.url).toContain("viewPanel=2");
		expect(dashboard?.url).not.toContain("secret");
		const rule = signal?.links.find((link) => link.label === "Alert rule");
		expect(rule?.url).toBe(GENERATOR);
	});

	test("redacts credential-shaped annotation text", () => {
		const signal = normalizeGrafanaIncident(
			group([
				alert({
					annotations: {
						summary: "token glsa_abcdefghijklmnopqrstuvwxyz leaked",
						description: "password=hunter2 in the config",
					},
				}),
			]),
			{ receivedAt: RECEIVED_AT },
		);
		expect(signal?.summary).not.toContain("glsa_abcdefghijklmnopqrstuvwxyz");
		expect(signal?.summary).not.toContain("hunter2");
		expect(signal?.summary).toContain("[auth-redacted]");
		expect(signal?.summary).toContain("[auth-redacted]");
	});

	test("rejects unknown fields, oversized groups and invalid payloads", () => {
		const withUnknown = {
			...(group([alert()]) as Record<string, unknown>),
			unexpected: true,
		};
		expect(normalizeGrafanaIncident(withUnknown)).toBeNull();
		expect(
			normalizeGrafanaIncident(
				group([
					{
						...alert(),
						unknownField: 1,
					} as unknown as GrafanaAlert,
				]),
			),
		).toBeNull();
		expect(
			normalizeGrafanaIncident(
				group(
					Array.from({ length: 65 }, (_, index) =>
						alert({ fingerprint: `f${index}` }),
					),
				),
			),
		).toBeNull();
		expect(normalizeGrafanaIncident(null)).toBeNull();
		expect(normalizeGrafanaIncident("{}")).toBeNull();
	});

	test("production-environment and fingerprint helpers are bounded", () => {
		expect(isGrafanaProductionEnvironment("production")).toBe(true);
		expect(isGrafanaProductionEnvironment("PROD")).toBe(true);
		expect(isGrafanaProductionEnvironment("staging")).toBe(false);
		expect(isGrafanaProductionEnvironment(null)).toBe(false);
		const fingerprint = grafanaIncidentFingerprint({
			ruleUid: "r".repeat(64),
			alertname: "A".repeat(200),
			service: "S".repeat(200),
			environment: "production",
		});
		expect(fingerprint.length).toBeLessThanOrEqual(128);
		expect(fingerprint).toMatch(/^grafana:[A-Za-z0-9_-]+:[0-9a-f]{16}$/);
	});
});
