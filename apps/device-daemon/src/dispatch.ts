import type { DeviceConfig, Env } from "./config";
import {
	DEVICE_MAX_PARAMS_BYTES,
	type DeviceCall,
	type DeviceDispatcher,
	type DispatchOutcome,
	jsonByteLength,
	type ToolHandler,
} from "./contracts";
import { createAxiomHandlers } from "./vendors/axiom";
import { createDatadogHandlers } from "./vendors/datadog";
import { createGrafanaHandlers } from "./vendors/grafana";
import { createHoneycombHandlers } from "./vendors/honeycomb";
import {
	createKubernetesHandlers,
	type KubernetesClientFactory,
} from "./vendors/kubernetes";
import { createKubernetesHttpsClient } from "./vendors/kubernetes-client";
import { createNewRelicHandlers } from "./vendors/newrelic";
import { createPagerDutyHandlers } from "./vendors/pagerduty";
import { createSentryHandlers } from "./vendors/sentry";
import { failure } from "./vendors/shared";
import { createSignozHandlers } from "./vendors/signoz";

/**
 * The daemon's complete connector tool table.
 *
 * Every name in `CONNECTOR_TOOL_RISKS` has an entry whether or not the vendor
 * is configured, plus one `*.context.fetch` preloading tool per vendor (nine
 * names the model cannot request). A configured vendor builds its adapter
 * dependencies from the device-local config/env on each call; an unconfigured
 * vendor fails closed as `INTEGRATION_UNAVAILABLE` without touching the
 * network. A name outside this table fails `VALIDATION_FAILED` without
 * executing.
 */

export const DEVICE_TOOL_NAMES_BY_VENDOR = {
	sentry: [
		"sentry.list_issues",
		"sentry.get_issue",
		"sentry.latest_event",
		"sentry.context.fetch",
	],
	grafana: [
		"grafana.query_metrics",
		"grafana.query_logs",
		"grafana.get_alert_rule",
		"grafana.context.fetch",
	],
	pagerduty: [
		"pagerduty.list_incidents",
		"pagerduty.get_incident",
		"pagerduty.list_log_entries",
		"pagerduty.acknowledge",
		"pagerduty.resolve",
		"pagerduty.context.fetch",
	],
	kubernetes: [
		"k8s.list_events",
		"k8s.get_pod",
		"k8s.get_deployment",
		"k8s.logs_tail",
		"k8s.context.fetch",
	],
	datadog: [
		"datadog.query_metrics",
		"datadog.search_logs",
		"datadog.get_incident",
		"datadog.get_monitor",
		"datadog.context.fetch",
	],
	axiom: [
		"axiom.query_apl",
		"axiom.get_monitor",
		"axiom.list_datasets",
		"axiom.context.fetch",
	],
	signoz: [
		"signoz.query_range",
		"signoz.get_rule",
		"signoz.list_rules",
		"signoz.context.fetch",
	],
	newrelic: [
		"newrelic.run_nrql",
		"newrelic.get_entity",
		"newrelic.list_alert_policies",
		"newrelic.context.fetch",
	],
	honeycomb: [
		"honeycomb.run_query",
		"honeycomb.get_trigger",
		"honeycomb.list_slos",
		"honeycomb.context.fetch",
	],
} as const satisfies Record<string, readonly string[]>;

export type DispatcherOptions = {
	config: DeviceConfig;
	env: Env;
	fetchImpl?: typeof fetch;
	/** Injected in tests; the default speaks HTTPS to the cluster. */
	kubernetesClientFactory?: KubernetesClientFactory;
};

function unavailableStubs(
	names: readonly string[],
): Record<string, ToolHandler> {
	const handlers: Record<string, ToolHandler> = {};
	for (const name of names) {
		handlers[name] = async () => failure("INTEGRATION_UNAVAILABLE");
	}
	return handlers;
}

/** Builds the 40-entry table; config decides which vendors are live. */
export function createHandlerTable(
	options: DispatcherOptions,
): Record<string, ToolHandler> {
	const env = options.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const clientFactory =
		options.kubernetesClientFactory ?? createKubernetesHttpsClient;
	const vendors = options.config.vendors;

	return {
		...(vendors.sentry === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.sentry)
			: createSentryHandlers(vendors.sentry, env, fetchImpl)),
		...(vendors.grafana === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.grafana)
			: createGrafanaHandlers(vendors.grafana, env, fetchImpl)),
		...(vendors.pagerduty === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.pagerduty)
			: createPagerDutyHandlers(vendors.pagerduty, env, fetchImpl)),
		...(vendors.kubernetes === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.kubernetes)
			: createKubernetesHandlers(vendors.kubernetes, env, clientFactory)),
		...(vendors.datadog === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.datadog)
			: createDatadogHandlers(vendors.datadog, env, fetchImpl)),
		...(vendors.axiom === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.axiom)
			: createAxiomHandlers(vendors.axiom, env, fetchImpl)),
		...(vendors.signoz === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.signoz)
			: createSignozHandlers(vendors.signoz, env, fetchImpl)),
		...(vendors.newrelic === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.newrelic)
			: createNewRelicHandlers(vendors.newrelic, env, fetchImpl)),
		...(vendors.honeycomb === undefined
			? unavailableStubs(DEVICE_TOOL_NAMES_BY_VENDOR.honeycomb)
			: createHoneycombHandlers(vendors.honeycomb, env, fetchImpl)),
	};
}

/**
 * Dispatcher used by the poll loop. Parameters are capped before dispatch and
 * the handler table is resolved once, so a call can never select an adapter
 * behaviour outside the table.
 */
export function createDispatcher(options: DispatcherOptions): DeviceDispatcher {
	const handlers = createHandlerTable(options);
	return async (call: DeviceCall): Promise<DispatchOutcome> => {
		if (jsonByteLength(call.params) > DEVICE_MAX_PARAMS_BYTES) {
			return failure("VALIDATION_FAILED");
		}
		const handler = handlers[call.toolName];
		if (handler === undefined) return failure("VALIDATION_FAILED");
		return handler(call.params);
	};
}
