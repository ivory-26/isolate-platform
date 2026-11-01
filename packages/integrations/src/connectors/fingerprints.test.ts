import { describe, expect, test } from "bun:test";
import { parseConnectorIncidentFingerprint } from "./fingerprints";

describe("parseConnectorIncidentFingerprint", () => {
	test("parses every implemented source shape", () => {
		expect(parseConnectorIncidentFingerprint("sentry:acme:api:12345")).toEqual({
			source: "sentry",
			orgSlug: "acme",
			project: "api",
			issueId: "12345",
		});
		expect(
			parseConnectorIncidentFingerprint("grafana:rule-1:abcdef0123456789"),
		).toEqual({ source: "grafana", ruleUid: "rule-1" });
		expect(
			parseConnectorIncidentFingerprint("pagerduty:PSERVICE:INC123"),
		).toEqual({
			source: "pagerduty",
			serviceId: "PSERVICE",
			incidentId: "INC123",
		});
		expect(
			parseConnectorIncidentFingerprint(
				"k8s:kind-isolate-demo:payments:Pod/api-7c9f:CrashLoopBackOff",
			),
		).toEqual({
			source: "kubernetes",
			cluster: "kind-isolate-demo",
			namespace: "payments",
			kind: "Pod",
			name: "api-7c9f",
			reason: "CrashLoopBackOff",
		});
		expect(
			parseConnectorIncidentFingerprint("datadog:1234567890:abcdef0123456789"),
		).toEqual({ source: "datadog", monitorId: "1234567890" });
		expect(
			parseConnectorIncidentFingerprint("newrelic:abcdef0123456789"),
		).toEqual({ source: "newrelic", digest: "abcdef0123456789" });
		expect(
			parseConnectorIncidentFingerprint("honeycomb:dataset-1:trigger-1:firing"),
		).toEqual({
			source: "honeycomb",
			dataset: "dataset-1",
			triggerId: "trigger-1",
			state: "firing",
		});
		expect(
			parseConnectorIncidentFingerprint("axiom:monitor-1:abcdef0123456789"),
		).toEqual({ source: "axiom", monitorId: "monitor-1" });
		expect(
			parseConnectorIncidentFingerprint("signoz:rule-1:abcdef0123456789"),
		).toEqual({ source: "signoz", ruleId: "rule-1" });
	});

	test("returns null for unknown, malformed or over-long fingerprints", () => {
		for (const value of [
			"github:repo:run:main",
			"sentry:only-two",
			"grafana:",
			"k8s:cluster:ns:not-a-kind-name:reason",
			"newrelic:",
			`datadog:${"a".repeat(200)}:hash`,
			"",
		]) {
			expect(parseConnectorIncidentFingerprint(value)).toBeNull();
		}
	});
});
