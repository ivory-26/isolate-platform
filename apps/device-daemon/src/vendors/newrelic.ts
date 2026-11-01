import {
	fetchNewRelicContext,
	getNewRelicEntity,
	listNewRelicAlertPolicies,
	type NewRelicContextDependencies,
	runNewRelicNrql,
} from "@isolate/integrations";
import { type Env, type NewRelicVendorConfig, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { failure, withDependencies } from "./shared";

/** New Relic handlers: one user API key and the configured account id. */
export function createNewRelicHandlers(
	config: NewRelicVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): NewRelicContextDependencies | null => {
		const apiKey = resolveSecret(config.secretEnv, "apiKey", env);
		if (apiKey === null) return null;
		return {
			apiKey,
			accountId: config.accountId,
			fetchImpl,
			...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"newrelic.run_nrql": (params) =>
			withDependencies(dependencies(), (deps) => runNewRelicNrql(deps, params)),
		"newrelic.get_entity": (params) =>
			withDependencies(dependencies(), (deps) =>
				getNewRelicEntity(deps, params),
			),
		"newrelic.list_alert_policies": (params) =>
			withDependencies(dependencies(), (deps) =>
				listNewRelicAlertPolicies(deps, params),
			),
		"newrelic.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"newrelic",
			);
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return withDependencies(dependencies(), (deps) =>
				fetchNewRelicContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
				}),
			);
		},
	};
}
