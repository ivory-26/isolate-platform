import { CONNECTOR_VERIFY_TOOL_NAME } from "@isolate/shared";
import type { DeviceConfig, Env, SecretLookup } from "./config";
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
import { createSignozHandlers } from "./vendors/signoz";
import { createConnectorVerifyHandler } from "./vendors/verify";

/**
 * The daemon's complete connector tool table: 41 entries.
 *
 * 31 agent tools (`CONNECTOR_TOOL_RISKS`), nine `*.context.fetch` preloading
 * tools the model cannot request, and one internal `connector.verify` call the
 * server enqueues after pairing. Every vendor handler is built for all nine
 * connectors whether or not `~/.isolate/connectors.json` has an entry: the
 * product path is the paired secret store plus paired selectors. A vendor with
 * no usable credential or selector fails closed as `INTEGRATION_UNAVAILABLE`
 * (or `VALIDATION_FAILED` for a malformed stored selector) without touching the
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

/** 31 agent tools + 9 context tools + `connector.verify`. */
export const DEVICE_HANDLER_COUNT = 41;

export type DispatcherOptions = {
	config: DeviceConfig;
	env: Env;
	fetchImpl?: typeof fetch;
	/** Injected in tests; the default speaks HTTPS to the cluster. */
	kubernetesClientFactory?: KubernetesClientFactory;
	/** Paired store first, legacy env-var secrets second. */
	secretStore?: SecretLookup;
};

/** Builds the 41-entry table; credentials decide which vendors are live. */
export function createHandlerTable(
	options: DispatcherOptions,
): Record<string, ToolHandler> {
	const env = options.env;
	const fetchImpl = options.fetchImpl ?? fetch;
	const clientFactory =
		options.kubernetesClientFactory ?? createKubernetesHttpsClient;
	const secretStore = options.secretStore;
	const vendors = options.config.vendors;

	return {
		...createSentryHandlers(vendors.sentry, env, fetchImpl, secretStore),
		...createGrafanaHandlers(vendors.grafana, env, fetchImpl, secretStore),
		...createPagerDutyHandlers(vendors.pagerduty, env, fetchImpl, secretStore),
		...createKubernetesHandlers(
			vendors.kubernetes,
			env,
			clientFactory,
			secretStore,
		),
		...createDatadogHandlers(vendors.datadog, env, fetchImpl, secretStore),
		...createAxiomHandlers(vendors.axiom, env, fetchImpl, secretStore),
		...createSignozHandlers(vendors.signoz, env, fetchImpl, secretStore),
		...createNewRelicHandlers(vendors.newrelic, env, fetchImpl, secretStore),
		...createHoneycombHandlers(vendors.honeycomb, env, fetchImpl, secretStore),
		[CONNECTOR_VERIFY_TOOL_NAME]: createConnectorVerifyHandler({
			config: options.config,
			env,
			fetchImpl,
			kubernetesClientFactory: clientFactory,
			secretStore,
		}),
	};
}

/**
 * Dispatcher used by the poll loop. Parameters are capped before dispatch and
 * the handler table is resolved once, so a call can never select an adapter
 * behaviour outside the table. The connector id is passed through for
 * `connector.verify`; every other handler ignores it.
 */
export function createDispatcher(options: DispatcherOptions): DeviceDispatcher {
	const handlers = createHandlerTable(options);
	return async (call: DeviceCall): Promise<DispatchOutcome> => {
		if (jsonByteLength(call.params) > DEVICE_MAX_PARAMS_BYTES) {
			return { ok: false, errorCode: "VALIDATION_FAILED" };
		}
		const handler = handlers[call.toolName];
		if (handler === undefined) {
			return { ok: false, errorCode: "VALIDATION_FAILED" };
		}
		return handler(call.params, {
			credentialRef: call.credentialRef,
			connectorId: call.connectorId,
		});
	};
}
