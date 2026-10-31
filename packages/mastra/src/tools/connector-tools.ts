import type { ToolName, ToolRiskBand } from "./policy";

/**
 * First-batch connector tool surface (wave 17).
 *
 * These names are the only connector tools the model may ask for. Each is
 * executed server-side by the worker through a device-held credential: the
 * provider secret never enters the sandbox, the prompt, a tool argument or a
 * log. Reads are `read_only`; acknowledge/resolve change provider state and are
 * audited `scoped_write`. Destructive connector actions are intentionally
 * absent.
 *
 * Registration is separate: a name in this table is not callable until the
 * worker binds an implementation for the task's organization and device.
 */
export const CONNECTOR_TOOL_RISKS = {
	"sentry.list_issues": "read_only",
	"sentry.get_issue": "read_only",
	"sentry.latest_event": "read_only",
	"grafana.query_metrics": "read_only",
	"grafana.query_logs": "read_only",
	"grafana.get_alert_rule": "read_only",
	"pagerduty.list_incidents": "read_only",
	"pagerduty.get_incident": "read_only",
	"pagerduty.list_log_entries": "read_only",
	"pagerduty.acknowledge": "scoped_write",
	"pagerduty.resolve": "scoped_write",
	"k8s.list_events": "read_only",
	"k8s.get_pod": "read_only",
	"k8s.get_deployment": "read_only",
	"k8s.logs_tail": "read_only",
} as const satisfies Partial<Record<ToolName, ToolRiskBand>>;

export type ConnectorToolName = keyof typeof CONNECTOR_TOOL_RISKS;

export const CONNECTOR_TOOL_NAMES = Object.keys(
	CONNECTOR_TOOL_RISKS,
) as ConnectorToolName[];
