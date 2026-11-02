import {
	fetchSignozContext,
	getSignozRule,
	listSignozRules,
	querySignozRange,
	type SignozContextDependencies,
} from "@isolate/integrations";
import {
	type Env,
	resolveVendorSecret,
	type SecretLookup,
	type SignozVendorConfig,
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
 * SigNoz settings: a self-hosted instance origin plus a read-only API key. The
 * API key resolves from the paired store first, then the legacy env var; the
 * origin is a required selector, so a paired credential needs no
 * `vendors.signoz` entry.
 */
export function resolveSignozSettings(
	config: SignozVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<SignozContextDependencies> {
	const apiKey = resolveVendorSecret(
		config?.secretEnv,
		"apiKey",
		env,
		credentialRef,
		secretStore,
	);
	if (apiKey === null) return settingsFailure("CONFIG_REQUIRED");
	const baseUrl = resolveRequiredSelector({
		connectorId: "signoz",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	return settingsOk({
		baseUrl: baseUrl.value,
		apiKey,
		fetchImpl,
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** SigNoz handlers: paired selectors > static config > legacy env. */
export function createSignozHandlers(
	config: SignozVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveSignozSettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"signoz.query_range": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				querySignozRange(deps, params),
			),
		"signoz.get_rule": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getSignozRule(deps, params),
			),
		"signoz.list_rules": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				listSignozRules(deps, params),
			),
		"signoz.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "signoz");
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchSignozContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					ruleId: ref.ruleId,
				}),
			);
		},
	};
}
