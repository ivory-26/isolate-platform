import {
	type AxiomContextDependencies,
	fetchAxiomIncidentContext,
	getAxiomMonitor,
	listAxiomDatasets,
	queryAxiomApl,
} from "@isolate/integrations";
import {
	type AxiomVendorConfig,
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
 * Axiom settings. The default dataset allowlist is configuration; the model can
 * only pick a dataset that is already permitted. The token resolves from the
 * paired store first; the origin and dataset are required selectors, so a
 * paired credential works with no `vendors.axiom` entry.
 */
export function resolveAxiomSettings(
	config: AxiomVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<AxiomContextDependencies> {
	const token = resolveVendorSecret(
		config?.secretEnv,
		"token",
		env,
		credentialRef,
		secretStore,
	);
	if (token === null) return settingsFailure("CONFIG_REQUIRED");
	const baseUrl = resolveRequiredSelector({
		connectorId: "axiom",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	const dataset = resolveRequiredSelector({
		connectorId: "axiom",
		key: "dataset",
		credentialRef,
		store: secretStore,
		configValue: config?.dataset,
	});
	if (!dataset.ok) return settingsFailure(dataset.reason);
	const allowed = config?.allowedDatasets ?? [dataset.value];
	return settingsOk({
		baseUrl: baseUrl.value,
		token,
		dataset: dataset.value,
		allowedDatasets: allowed.includes(dataset.value)
			? allowed
			: [dataset.value, ...allowed],
		fetchImpl,
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** Axiom handlers: paired selectors > static config > legacy env. */
export function createAxiomHandlers(
	config: AxiomVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveAxiomSettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"axiom.query_apl": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				queryAxiomApl(deps, params),
			),
		"axiom.get_monitor": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getAxiomMonitor(deps, params),
			),
		"axiom.list_datasets": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				listAxiomDatasets(deps, params),
			),
		"axiom.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "axiom");
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchAxiomIncidentContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					monitorId: ref.monitorId,
				}),
			);
		},
	};
}
