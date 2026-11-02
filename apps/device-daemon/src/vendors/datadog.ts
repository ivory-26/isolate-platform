import {
	type DatadogContextDependencies,
	fetchDatadogContext,
	getDatadogIncident,
	getDatadogMonitor,
	queryDatadogMetrics,
	searchDatadogLogs,
} from "@isolate/integrations";
import {
	type DatadogVendorConfig,
	type Env,
	resolveVendorSecret,
	type SecretLookup,
} from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { resolveRequiredSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

/**
 * Datadog settings: API key + scoped application key, both from the paired
 * store first, then the legacy env vars. The site origin is a required selector
 * so a paired credential works with no `vendors.datadog` entry.
 */
export function resolveDatadogSettings(
	config: DatadogVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<DatadogContextDependencies> {
	const apiKey = resolveVendorSecret(
		config?.secretEnv,
		"apiKey",
		env,
		credentialRef,
		secretStore,
	);
	const appKey = resolveVendorSecret(
		config?.secretEnv,
		"appKey",
		env,
		credentialRef,
		secretStore,
	);
	if (apiKey === null || appKey === null) {
		return settingsFailure("CONFIG_REQUIRED");
	}
	const baseUrl = resolveRequiredSelector({
		connectorId: "datadog",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	return settingsOk({
		baseUrl: baseUrl.value,
		apiKey,
		appKey,
		fetchImpl,
		...(config?.logsEnabled === undefined
			? {}
			: { logsEnabled: config.logsEnabled }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** Datadog handlers: paired fields > static config > legacy env. */
export function createDatadogHandlers(
	config: DatadogVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveDatadogSettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"datadog.query_metrics": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				queryDatadogMetrics(deps, params),
			),
		"datadog.search_logs": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				searchDatadogLogs(deps, params),
			),
		"datadog.get_incident": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getDatadogIncident(deps, params),
			),
		"datadog.get_monitor": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getDatadogMonitor(deps, params),
			),
		"datadog.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"datadog",
			);
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchDatadogContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					monitorId: ref.monitorId,
				}),
			);
		},
	};
}
