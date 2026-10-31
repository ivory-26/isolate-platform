import { describe, expect, test } from "bun:test";
import {
	normalizeSignozIncident,
	signozIncidentFingerprint,
	signozRuleIdOf,
	signozSeverityOf,
} from "./normalize";
import type { SignozAlert } from "./schemas";

const RECEIVED_AT = "2026-10-31T12:00:00.000Z";

function alert(overrides: Partial<SignozAlert> = {}): SignozAlert {
	return {
		status: "firing",
		labels: {
			alertname: "HighErrorRate",
			"service.name": "checkout",
			severity: "critical",
			rule_id: "rule-1",
			pod: "checkout-7d9f",
		},
		annotations: {
			summary: "Error rate above 5%",
			runbook_url: "https://runbooks.example.com/checkout",
		},
		startsAt: "2026-10-31T11:00:00.000Z",
		generatorURL:
			"https://signoz.example.com/alerts/rules/rule-1?token=should-be-dropped",
		fingerprint: "alert-fingerprint-1",
		...overrides,
	};
}

function payload(alerts: SignozAlert[]): unknown {
	return { alerts, status: "firing", receiver: "isolate" };
}

describe("signozSeverityOf", () => {
	test("maps the documented label values", () => {
		expect(signozSeverityOf("critical")).toBe("critical");
		expect(signozSeverityOf("FATAL")).toBe("critical");
		expect(signozSeverityOf("error")).toBe("high");
		expect(signozSeverityOf("high")).toBe("high");
		expect(signozSeverityOf("warning")).toBe("medium");
		expect(signozSeverityOf("warn")).toBe("medium");
		expect(signozSeverityOf("low")).toBe("low");
		expect(signozSeverityOf("info")).toBe("info");
		expect(signozSeverityOf("debug")).toBe("info");
		expect(signozSeverityOf(undefined)).toBe("medium");
		expect(signozSeverityOf("unrecognized")).toBe("medium");
	});
});

describe("normalizeSignozIncident", () => {
	test("normalizes a firing alert with a stable fingerprint and links", () => {
		const signal = normalizeSignozIncident(payload([alert()]), {
			receivedAt: RECEIVED_AT,
		});
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(signal.source).toBe("signoz");
		expect(signal.kind).toBe("alert_firing");
		expect(signal.severity).toBe("critical");
		expect(signal.service).toBe("checkout");
		expect(signal.fingerprint.startsWith("signoz:rule-1:")).toBe(true);
		expect(signal.fingerprint.length).toBeLessThanOrEqual(128);
		expect(signal.title).toContain("HighErrorRate");
		expect(signal.summary).toContain("Severity: critical -> critical");
		expect(signal.receivedAt).toBe(RECEIVED_AT);
		expect(signal.links).toEqual([
			{
				label: "Alert",
				url: "https://signoz.example.com/alerts/rules/rule-1",
			},
			{
				label: "Runbook",
				url: "https://runbooks.example.com/checkout",
			},
		]);
	});

	test("fingerprint ignores volatile labels and startsAt", () => {
		const base = normalizeSignozIncident(payload([alert()]));
		const churned = normalizeSignozIncident(
			payload([
				alert({
					labels: {
						alertname: "HighErrorRate",
						"service.name": "checkout",
						severity: "critical",
						rule_id: "rule-1",
						pod: "checkout-ff01",
						instance: "10.1.2.3:8080",
					},
					startsAt: "2026-10-31T11:30:00.000Z",
				}),
			]),
		);
		expect(base?.fingerprint).toBe(churned?.fingerprint);
	});

	test("fingerprint changes when the rule, service or state changes", () => {
		const base = signozIncidentFingerprint({
			ruleId: "rule-1",
			alertName: "HighErrorRate",
			service: "checkout",
			state: "firing",
			labels: { alertname: "HighErrorRate" },
		});
		expect(
			signozIncidentFingerprint({
				ruleId: "rule-2",
				alertName: "HighErrorRate",
				service: "checkout",
				state: "firing",
				labels: { alertname: "HighErrorRate" },
			}),
		).not.toBe(base);
		expect(
			signozIncidentFingerprint({
				ruleId: "rule-1",
				alertName: "HighErrorRate",
				service: "payments",
				state: "firing",
				labels: { alertname: "HighErrorRate" },
			}),
		).not.toBe(base);
		expect(
			signozIncidentFingerprint({
				ruleId: "rule-1",
				alertName: "HighErrorRate",
				service: "checkout",
				state: "resolved",
				labels: { alertname: "HighErrorRate" },
			}),
		).not.toBe(base);
	});

	test("returns null for resolved deliveries, bad payloads and unknown fields", () => {
		expect(
			normalizeSignozIncident({
				alerts: [alert({ status: "resolved" })],
				status: "resolved",
			}),
		).toBeNull();
		expect(normalizeSignozIncident({ alerts: [] })).toBeNull();
		expect(
			normalizeSignozIncident({
				alerts: [{ ...alert(), surprise: true }],
				status: "firing",
			}),
		).toBeNull();
		expect(normalizeSignozIncident("not-json")).toBeNull();
	});

	test("selects the highest-severity firing alert deterministically", () => {
		const signal = normalizeSignozIncident(
			payload([
				alert({ labels: { alertname: "Low", severity: "low", rule_id: "a" } }),
				alert({
					labels: {
						alertname: "Critical",
						severity: "critical",
						rule_id: "b",
					},
				}),
				alert({
					labels: { alertname: "Medium", severity: "warning", rule_id: "c" },
				}),
			]),
		);
		expect(signal?.severity).toBe("critical");
		expect(signal?.fingerprint.startsWith("signoz:b:")).toBe(true);
	});

	test("a trusted rule id override wins over the label", () => {
		const signal = normalizeSignozIncident(payload([alert()]), {
			ruleId: "trusted-rule-9",
		});
		expect(signal?.fingerprint.startsWith("signoz:trusted-rule-9:")).toBe(true);
	});

	test("falls back to an anonymous rule id and the alertname as service", () => {
		const signal = normalizeSignozIncident(
			payload([
				alert({
					labels: { alertname: "QueueBacklog", severity: "high" },
				}),
			]),
		);
		expect(signal?.service).toBe("QueueBacklog");
		expect(signal?.fingerprint.startsWith("signoz:anon-")).toBe(true);
	});

	test("redacts emails, IPs and API keys before truncation", () => {
		const signal = normalizeSignozIncident(
			payload([
				alert({
					annotations: {
						description:
							"owner owner@example.com from 10.1.2.3 SIGNOZ-API-KEY: supersecretvalue123",
						summary: "contact ops@example.com",
					},
				}),
			]),
		);
		const summary = signal?.summary ?? "";
		expect(summary).not.toContain("owner@example.com");
		expect(summary).not.toContain("ops@example.com");
		expect(summary).not.toContain("10.1.2.3");
		expect(summary).not.toContain("supersecretvalue123");
		expect(summary).toContain("[email-redacted]");
		expect(summary).toContain("[ip-redacted]");
	});

	test("drops non-https links and query strings", () => {
		const signal = normalizeSignozIncident(
			payload([
				alert({
					generatorURL: "http://insecure.example.com/rule?token=abc",
					annotations: { runbook_url: "https://runbooks.example.com/x?t=1" },
					labels: {
						alertname: "HighErrorRate",
						"service.name": "checkout",
						dashboard_url: "https://signoz.example.com/dashboards/1",
					},
				}),
			]),
		);
		expect(signal?.links).toEqual([
			{ label: "Dashboard", url: "https://signoz.example.com/dashboards/1" },
			{ label: "Runbook", url: "https://runbooks.example.com/x" },
		]);
	});
});

describe("signozRuleIdOf", () => {
	test("accepts a documented label and rejects an invalid one", () => {
		const withLabel = signozRuleIdOf(alert(), null);
		expect(withLabel).toBe("rule-1");
		const anon = signozRuleIdOf(
			alert({ labels: { alertname: "X", rule_id: "bad rule id" } }),
			null,
		);
		expect(anon.startsWith("anon-")).toBe(true);
	});
});
