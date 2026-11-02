import {
	fetchGrafanaContext,
	type GrafanaContextDependencies,
	getGrafanaAlertRule,
	queryGrafanaLogs,
	queryGrafanaMetrics,
} from "@isolate/integrations";
import {
	type Env,
	type GrafanaVendorConfig,
	resolveVendorSecret,
	type SecretLookup,
} from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { resolveOptionalSelector, resolveRequiredSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

/**
 * Grafana settings. The stack URL is required and may arrive only from the
 * paired selectors: a paired credential works with no `vendors.grafana` entry.
 * Datasource UIDs stay configuration so the model can never select another
 * datasource or compose a query.
 */
export function resolveGrafanaSettings(
	config: GrafanaVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<GrafanaContextDependencies> {
	const token = resolveVendorSecret(
		config?.secretEnv,
		"token",
		env,
		credentialRef,
		secretStore,
	);
	if (token === null) return settingsFailure("CONFIG_REQUIRED");
	const baseUrl = resolveRequiredSelector({
		connectorId: "grafana",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	const orgId = resolveOptionalSelector({
		connectorId: "grafana",
		key: "orgId",
		credentialRef,
		store: secretStore,
		configValue: config?.orgId,
	});
	if (!orgId.ok) return settingsFailure(orgId.reason);
	const metricsDatasourceUid = resolveOptionalSelector({
		connectorId: "grafana",
		key: "metricsDatasourceUid",
		credentialRef,
		store: secretStore,
		configValue: config?.metricsDatasourceUid,
	});
	if (!metricsDatasourceUid.ok) {
		return settingsFailure(metricsDatasourceUid.reason);
	}
	const logsDatasourceUid = resolveOptionalSelector({
		connectorId: "grafana",
		key: "logsDatasourceUid",
		credentialRef,
		store: secretStore,
		configValue: config?.logsDatasourceUid,
	});
	if (!logsDatasourceUid.ok) return settingsFailure(logsDatasourceUid.reason);
	return settingsOk({
		baseUrl: baseUrl.value,
		token,
		fetchImpl,
		...(orgId.value === undefined ? {} : { orgId: orgId.value }),
		...(metricsDatasourceUid.value === undefined
			? {}
			: { metricsDatasourceUid: metricsDatasourceUid.value }),
		...(logsDatasourceUid.value === undefined
			? {}
			: { logsDatasourceUid: logsDatasourceUid.value }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** Grafana handlers: paired selectors > static config > legacy env. */
export function createGrafanaHandlers(
	config: GrafanaVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveGrafanaSettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"grafana.query_metrics": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				queryGrafanaMetrics(deps, params),
			),
		"grafana.query_logs": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				queryGrafanaLogs(deps, params),
			),
		"grafana.get_alert_rule": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getGrafanaAlertRule(deps, params),
			),
		"grafana.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"grafana",
			);
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchGrafanaContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					alertRuleUid: ref.ruleUid,
				}),
			);
		},
	};
}
