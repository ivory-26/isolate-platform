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
import { failure, withDependencies } from "./shared";

/**
 * Axiom handlers. The dataset allowlist is configuration; the model can only
 * pick a dataset that is already permitted. The token resolves from the paired
 * store first, then the legacy env var.
 */
export function createAxiomHandlers(
	config: AxiomVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): AxiomContextDependencies | null => {
		const token = resolveVendorSecret(
			config.secretEnv,
			"token",
			env,
			credentialRef,
			secretStore,
		);
		if (token === null) return null;
		const allowed = config.allowedDatasets ?? [config.dataset];
		return {
			baseUrl: config.baseUrl,
			token,
			dataset: config.dataset,
			allowedDatasets: allowed.includes(config.dataset)
				? allowed
				: [config.dataset, ...allowed],
			fetchImpl,
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"axiom.query_apl": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				queryAxiomApl(deps, params),
			),
		"axiom.get_monitor": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getAxiomMonitor(deps, params),
			),
		"axiom.list_datasets": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
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
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchAxiomIncidentContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					monitorId: ref.monitorId,
				}),
			);
		},
	};
}
