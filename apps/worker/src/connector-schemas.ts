import {
	axiomGetMonitorInputSchema,
	axiomListDatasetsInputSchema,
	axiomQueryAplInputSchema,
	datadogGetIncidentInputSchema,
	datadogGetMonitorInputSchema,
	datadogQueryMetricsInputSchema,
	datadogSearchLogsInputSchema,
	grafanaGetAlertRuleInputSchema,
	grafanaQueryLogsInputSchema,
	grafanaQueryMetricsInputSchema,
	honeycombGetTriggerInputSchema,
	honeycombListSlosInputSchema,
	honeycombRunQueryInputSchema,
	k8sGetDeploymentInputSchema,
	k8sGetPodInputSchema,
	k8sListEventsInputSchema,
	k8sLogsTailInputSchema,
	newRelicGetEntityInputSchema,
	newRelicListAlertPoliciesInputSchema,
	newRelicRunNrqlInputSchema,
	pagerDutyGetIncidentInputSchema,
	pagerDutyListIncidentsInputSchema,
	pagerDutyListLogEntriesInputSchema,
	pagerDutyWriteInputSchema,
	sentryGetIssueInputSchema,
	sentryLatestEventInputSchema,
	sentryListIssuesInputSchema,
	signozGetRuleInputSchema,
	signozListRulesInputSchema,
	signozQueryRangeInputSchema,
} from "@isolate/integrations";
import type { ConnectorToolName } from "@isolate/mastra";
import { PlatformError, zodIssueSummary } from "@isolate/shared";
import type { z } from "zod";

/**
 * Per-tool argument schemas (W18).
 *
 * Model-produced tool arguments are untrusted. Before a call is queued for a
 * device, it is parsed with the *adapter's own* input schema, so the worker
 * enforces exactly the contract the device-side tool will enforce: strict
 * objects (unknown keys rejected), bounded strings, enums and id patterns.
 *
 * Every one of the ten adapters already exports a strict input schema, so no
 * schema is duplicated here. `pagerduty.acknowledge` and `pagerduty.resolve`
 * share the adapter's write schema (`{ incidentId }`).
 *
 * Failures never echo the offending value: only the Zod issue path/code
 * summary is attached, which is safe for logs and model feedback.
 */

/** The adapter input schema for each of the 31 connector tool names. */
export const CONNECTOR_TOOL_ARGUMENT_SCHEMAS: Readonly<
	Record<ConnectorToolName, z.ZodType>
> = {
	"sentry.list_issues": sentryListIssuesInputSchema,
	"sentry.get_issue": sentryGetIssueInputSchema,
	"sentry.latest_event": sentryLatestEventInputSchema,
	"grafana.query_metrics": grafanaQueryMetricsInputSchema,
	"grafana.query_logs": grafanaQueryLogsInputSchema,
	"grafana.get_alert_rule": grafanaGetAlertRuleInputSchema,
	"pagerduty.list_incidents": pagerDutyListIncidentsInputSchema,
	"pagerduty.get_incident": pagerDutyGetIncidentInputSchema,
	"pagerduty.list_log_entries": pagerDutyListLogEntriesInputSchema,
	"pagerduty.acknowledge": pagerDutyWriteInputSchema,
	"pagerduty.resolve": pagerDutyWriteInputSchema,
	"k8s.list_events": k8sListEventsInputSchema,
	"k8s.get_pod": k8sGetPodInputSchema,
	"k8s.get_deployment": k8sGetDeploymentInputSchema,
	"k8s.logs_tail": k8sLogsTailInputSchema,
	"datadog.query_metrics": datadogQueryMetricsInputSchema,
	"datadog.search_logs": datadogSearchLogsInputSchema,
	"datadog.get_incident": datadogGetIncidentInputSchema,
	"datadog.get_monitor": datadogGetMonitorInputSchema,
	"axiom.query_apl": axiomQueryAplInputSchema,
	"axiom.get_monitor": axiomGetMonitorInputSchema,
	"axiom.list_datasets": axiomListDatasetsInputSchema,
	"signoz.query_range": signozQueryRangeInputSchema,
	"signoz.get_rule": signozGetRuleInputSchema,
	"signoz.list_rules": signozListRulesInputSchema,
	"newrelic.run_nrql": newRelicRunNrqlInputSchema,
	"newrelic.get_entity": newRelicGetEntityInputSchema,
	"newrelic.list_alert_policies": newRelicListAlertPoliciesInputSchema,
	"honeycomb.run_query": honeycombRunQueryInputSchema,
	"honeycomb.get_trigger": honeycombGetTriggerInputSchema,
	"honeycomb.list_slos": honeycombListSlosInputSchema,
};

/** Schema-validated, detached argument object ready for the device queue. */
export type ValidatedConnectorToolArguments = {
	readonly ok: true;
	readonly data: Record<string, unknown>;
};

/** The call is refused before a credential is resolved or a call enqueued. */
export type InvalidConnectorToolArguments = {
	readonly ok: false;
	readonly error: PlatformError;
};

export type ConnectorToolArgumentsResult =
	| ValidatedConnectorToolArguments
	| InvalidConnectorToolArguments;

function invalidArguments(summary: string): InvalidConnectorToolArguments {
	const detail = summary.length > 0 ? `: ${summary}` : "";
	return {
		ok: false,
		error: new PlatformError(
			"VALIDATION_FAILED",
			`connector tool arguments are invalid${detail}`,
		),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses untrusted tool arguments against the adapter schema for `name`.
 *
 * Returns the detached parsed object (adapter defaults `.trim()` etc. are
 * already applied) or a fixed `VALIDATION_FAILED` error. An unknown tool name
 * fails closed here, before any broker, credential or queue work, and its
 * text is never echoed back.
 */
export function validateConnectorToolArguments(
	name: string,
	args: unknown,
): ConnectorToolArgumentsResult {
	if (!Object.hasOwn(CONNECTOR_TOOL_ARGUMENT_SCHEMAS, name)) {
		return {
			ok: false,
			error: new PlatformError(
				"VALIDATION_FAILED",
				"connector tool is not recognized",
			),
		};
	}
	const schema = CONNECTOR_TOOL_ARGUMENT_SCHEMAS[name as ConnectorToolName];
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		return invalidArguments(zodIssueSummary(parsed.error));
	}
	if (!isRecord(parsed.data)) {
		return invalidArguments("");
	}
	try {
		// Detach the value from any caller-held reference before it is queued.
		return {
			ok: true,
			data: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
		};
	} catch {
		return invalidArguments("");
	}
}
