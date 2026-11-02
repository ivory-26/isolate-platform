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
import { failure, withDependencies } from "./shared";

/**
 * Datadog handlers: API key + scoped application key, both resolved from the
 * paired secret store first (a paired entry may hold `apiKey`/`appKey`) and the
 * legacy env vars second.
 */
export function createDatadogHandlers(
	config: DatadogVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): DatadogContextDependencies | null => {
		const apiKey = resolveVendorSecret(
			config.secretEnv,
			"apiKey",
			env,
			credentialRef,
			secretStore,
		);
		const appKey = resolveVendorSecret(
			config.secretEnv,
			"appKey",
			env,
			credentialRef,
			secretStore,
		);
		if (apiKey === null || appKey === null) return null;
		return {
			baseUrl: config.baseUrl,
			apiKey,
			appKey,
			fetchImpl,
			...(config.logsEnabled === undefined
				? {}
				: { logsEnabled: config.logsEnabled }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"datadog.query_metrics": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				queryDatadogMetrics(deps, params),
			),
		"datadog.search_logs": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				searchDatadogLogs(deps, params),
			),
		"datadog.get_incident": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getDatadogIncident(deps, params),
			),
		"datadog.get_monitor": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
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
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchDatadogContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					monitorId: ref.monitorId,
				}),
			);
		},
	};
}
