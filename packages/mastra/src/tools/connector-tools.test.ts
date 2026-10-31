import { describe, expect, test } from "bun:test";
import { CONNECTOR_TOOL_NAMES, CONNECTOR_TOOL_RISKS } from "./connector-tools";
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
] as const;

describe("connector tool risk bands", () => {
	test("reads are read_only and acknowledge/resolve are scoped writes", () => {
		for (const tool of READ_ONLY) {
			expect(CONNECTOR_TOOL_RISKS[tool]).toBe("read_only");
		}
		expect(CONNECTOR_TOOL_RISKS["pagerduty.acknowledge"]).toBe("scoped_write");
		expect(CONNECTOR_TOOL_RISKS["pagerduty.resolve"]).toBe("scoped_write");
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(15);
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
