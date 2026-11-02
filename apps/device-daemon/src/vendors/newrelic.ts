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
import { resolveOptionalSelector, resolveRequiredSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

/**
 * New Relic settings: one user API key from the paired store first, then the
 * legacy env var. The account id is a required selector; the optional GraphQL
 * endpoint resolves from the paired selector or the static config.
 */
export function resolveNewRelicSettings(
	config: NewRelicVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<NewRelicContextDependencies> {
	const apiKey = resolveVendorSecret(
		config?.secretEnv,
		"apiKey",
		env,
		credentialRef,
		secretStore,
	);
	if (apiKey === null) return settingsFailure("CONFIG_REQUIRED");
	const accountId = resolveRequiredSelector({
		connectorId: "newrelic",
		key: "accountId",
		credentialRef,
		store: secretStore,
		configValue: config?.accountId,
	});
	if (!accountId.ok) return settingsFailure(accountId.reason);
	const endpoint = resolveOptionalSelector({
		connectorId: "newrelic",
		key: "endpoint",
		credentialRef,
		store: secretStore,
		configValue: config?.endpoint,
	});
	if (!endpoint.ok) return settingsFailure(endpoint.reason);
	return settingsOk({
		apiKey,
		accountId: accountId.value,
		fetchImpl,
		...(endpoint.value === undefined ? {} : { endpoint: endpoint.value }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** New Relic handlers: paired selectors > static config > legacy env. */
export function createNewRelicHandlers(
	config: NewRelicVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveNewRelicSettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"newrelic.run_nrql": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				runNewRelicNrql(deps, params),
			),
		"newrelic.get_entity": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getNewRelicEntity(deps, params),
			),
		"newrelic.list_alert_policies": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
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
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchNewRelicContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
				}),
			);
		},
	};
}
