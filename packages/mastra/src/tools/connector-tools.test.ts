import { describe, expect, test } from "bun:test";
import { INCIDENT_SOURCES } from "@isolate/shared";
import {
	CONNECTOR_TOOL_NAMES,
	CONNECTOR_TOOL_RISKS,
	connectorIdForToolName,
	connectorToolNamesForSource,
} from "./connector-tools";
import { createRiskTablePolicy, type ToolName } from "./policy";

const READ_ONLY = [
	"sentry.list_issues",
	"sentry.get_issue",
	"sentry.latest_event",
	"grafana.query_metrics",
	"grafana.query_logs",
	"grafana.get_alert_rule",
	"pagerduty.list_incidents",
	"pagerduty.get_incident",
	"pagerduty.list_log_entries",
	"k8s.list_events",
	"k8s.get_pod",
	"k8s.get_deployment",
	"k8s.logs_tail",
	"datadog.query_metrics",
	"datadog.search_logs",
	"datadog.get_incident",
	"datadog.get_monitor",
	"axiom.query_apl",
	"axiom.get_monitor",
	"axiom.list_datasets",
	"signoz.query_range",
	"signoz.get_rule",
	"signoz.list_rules",
	"newrelic.run_nrql",
	"newrelic.get_entity",
	"newrelic.list_alert_policies",
	"honeycomb.run_query",
	"honeycomb.get_trigger",
	"honeycomb.list_slos",
] as const;

describe("connector tool risk bands", () => {
	test("reads are read_only and acknowledge/resolve are scoped writes", () => {
		for (const tool of READ_ONLY) {
			expect(CONNECTOR_TOOL_RISKS[tool]).toBe("read_only");
		}
		expect(CONNECTOR_TOOL_RISKS["pagerduty.acknowledge"]).toBe("scoped_write");
		expect(CONNECTOR_TOOL_RISKS["pagerduty.resolve"]).toBe("scoped_write");
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(31);
	});

	test("no connector tool is sensitive or destructive", () => {
		for (const band of Object.values(CONNECTOR_TOOL_RISKS)) {
			expect(band === "read_only" || band === "scoped_write").toBe(true);
		}
	});

	test("the policy admits reads and scoped writes, and never widens a band", async () => {
		const policy = createRiskTablePolicy(CONNECTOR_TOOL_RISKS);
		for (const tool of CONNECTOR_TOOL_NAMES) {
			const result = await policy({
				tool: tool as ToolName,
				organizationId: "org",
				taskId: "task",
				arguments: {},
				scopes: [],
			});
			expect(result.ok).toBe(true);
		}
	});
});

describe("connector tool scoping by incident source", () => {
	test("every exposed tool maps to exactly one known connector id", () => {
		const owned = new Map<string, string>();
		for (const name of CONNECTOR_TOOL_NAMES) {
			const connectorId = connectorIdForToolName(name);
			expect(connectorId.length).toBeGreaterThan(0);
			expect(owned.has(name)).toBe(false);
			owned.set(name, connectorId);
		}
		const knownSources: readonly string[] = INCIDENT_SOURCES;
		for (const connectorId of owned.values()) {
			expect(knownSources).toContain(connectorId);
		}
	});

	test("each source exposes only tools of its own connector", () => {
		const counts = new Map<string, number>();
		for (const source of INCIDENT_SOURCES) {
			const names = connectorToolNamesForSource(source);
			counts.set(source, names.length);
			for (const name of names) {
				expect(connectorIdForToolName(name)).toBe(source);
			}
		}
		expect(counts.get("sentry")).toBe(3);
		expect(counts.get("grafana")).toBe(3);
		expect(counts.get("pagerduty")).toBe(5);
		expect(counts.get("kubernetes")).toBe(4);
		expect(counts.get("datadog")).toBe(4);
		expect(counts.get("axiom")).toBe(3);
		expect(counts.get("signoz")).toBe(3);
		expect(counts.get("newrelic")).toBe(3);
		expect(counts.get("honeycomb")).toBe(3);
		// No connector implementation: nothing is exposed.
		expect(counts.get("github")).toBe(0);
		expect(counts.get("generic")).toBe(0);
	});

	test("kubernetes source owns the k8s.* tools", () => {
		const names = connectorToolNamesForSource("kubernetes");
		expect(names).toEqual([
			"k8s.list_events",
			"k8s.get_pod",
			"k8s.get_deployment",
			"k8s.logs_tail",
		]);
	});

	test("every connector name is owned by one source, with nothing left over", () => {
		const owned = INCIDENT_SOURCES.flatMap((source) =>
			connectorToolNamesForSource(source),
		);
		expect(new Set(owned).size).toBe(owned.length);
		expect([...owned].sort()).toEqual([...CONNECTOR_TOOL_NAMES].sort());
	});

	test("an unknown or absent source exposes nothing", () => {
		expect(connectorToolNamesForSource(undefined)).toEqual([]);
		expect(connectorToolNamesForSource("")).toEqual([]);
		expect(connectorToolNamesForSource("unknown-connector")).toEqual([]);
		expect(connectorToolNamesForSource("Kubernetes")).toEqual([]);
	});
});
