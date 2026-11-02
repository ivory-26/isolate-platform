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
import { failure, withDependencies } from "./shared";

/**
 * Grafana handlers. The datasource UIDs are configuration, not tool input: the
 * model cannot select another datasource or compose a query. The token resolves
 * from the paired store first, then the legacy env var.
 */
export function createGrafanaHandlers(
	config: GrafanaVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): GrafanaContextDependencies | null => {
		const token = resolveVendorSecret(
			config.secretEnv,
			"token",
			env,
			credentialRef,
			secretStore,
		);
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
		"grafana.query_metrics": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				queryGrafanaMetrics(deps, params),
			),
		"grafana.query_logs": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				queryGrafanaLogs(deps, params),
			),
		"grafana.get_alert_rule": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
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
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchGrafanaContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					alertRuleUid: ref.ruleUid,
				}),
			);
		},
	};
}
