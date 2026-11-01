import {
	fetchGrafanaContext,
	type GrafanaContextDependencies,
	getGrafanaAlertRule,
	queryGrafanaLogs,
	queryGrafanaMetrics,
} from "@isolate/integrations";
import { type Env, type GrafanaVendorConfig, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { failure, withDependencies } from "./shared";

/**
 * Grafana handlers. The datasource UIDs are configuration, not tool input: the
 * model cannot select another datasource or compose a query.
 */
export function createGrafanaHandlers(
	config: GrafanaVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): GrafanaContextDependencies | null => {
		const token = resolveSecret(config.secretEnv, "token", env);
		if (token === null) return null;
		return {
			baseUrl: config.baseUrl,
			token,
			fetchImpl,
			...(config.orgId === undefined ? {} : { orgId: config.orgId }),
			...(config.metricsDatasourceUid === undefined
				? {}
				: { metricsDatasourceUid: config.metricsDatasourceUid }),
			...(config.logsDatasourceUid === undefined
				? {}
				: { logsDatasourceUid: config.logsDatasourceUid }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"grafana.query_metrics": (params) =>
			withDependencies(dependencies(), (deps) =>
				queryGrafanaMetrics(deps, params),
			),
		"grafana.query_logs": (params) =>
			withDependencies(dependencies(), (deps) =>
				queryGrafanaLogs(deps, params),
			),
		"grafana.get_alert_rule": (params) =>
			withDependencies(dependencies(), (deps) =>
				getGrafanaAlertRule(deps, params),
			),
		"grafana.context.fetch": async (params) => {
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
			return withDependencies(dependencies(), (deps) =>
				fetchGrafanaContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					alertRuleUid: ref.ruleUid,
				}),
			);
		},
	};
}
