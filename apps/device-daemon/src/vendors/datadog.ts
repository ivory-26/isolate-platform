import {
	type DatadogContextDependencies,
	fetchDatadogContext,
	getDatadogIncident,
	getDatadogMonitor,
	queryDatadogMetrics,
	searchDatadogLogs,
} from "@isolate/integrations";
import { type DatadogVendorConfig, type Env, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { failure, withDependencies } from "./shared";

/** Datadog handlers: API key + scoped application key, both device-local. */
export function createDatadogHandlers(
	config: DatadogVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): DatadogContextDependencies | null => {
		const apiKey = resolveSecret(config.secretEnv, "apiKey", env);
		const appKey = resolveSecret(config.secretEnv, "appKey", env);
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
		"datadog.query_metrics": (params) =>
			withDependencies(dependencies(), (deps) =>
				queryDatadogMetrics(deps, params),
			),
		"datadog.search_logs": (params) =>
			withDependencies(dependencies(), (deps) =>
				searchDatadogLogs(deps, params),
			),
		"datadog.get_incident": (params) =>
			withDependencies(dependencies(), (deps) =>
				getDatadogIncident(deps, params),
			),
		"datadog.get_monitor": (params) =>
			withDependencies(dependencies(), (deps) =>
				getDatadogMonitor(deps, params),
			),
		"datadog.context.fetch": async (params) => {
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
			return withDependencies(dependencies(), (deps) =>
				fetchDatadogContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					monitorId: ref.monitorId,
				}),
			);
		},
	};
}
