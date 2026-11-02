import {
	fetchNewRelicContext,
	getNewRelicEntity,
	listNewRelicAlertPolicies,
	type NewRelicContextDependencies,
	runNewRelicNrql,
} from "@isolate/integrations";
import {
	type Env,
	type NewRelicVendorConfig,
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
 * New Relic handlers: one user API key from the paired store first, then the
 * legacy env var; the account id is non-secret configuration.
 */
export function createNewRelicHandlers(
	config: NewRelicVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): NewRelicContextDependencies | null => {
		const apiKey = resolveVendorSecret(
			config.secretEnv,
			"apiKey",
			env,
			credentialRef,
			secretStore,
		);
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
		"newrelic.run_nrql": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				runNewRelicNrql(deps, params),
			),
		"newrelic.get_entity": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getNewRelicEntity(deps, params),
			),
		"newrelic.list_alert_policies": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				listNewRelicAlertPolicies(deps, params),
			),
		"newrelic.context.fetch": async (params, context) => {
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
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchNewRelicContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
				}),
			);
		},
	};
}
