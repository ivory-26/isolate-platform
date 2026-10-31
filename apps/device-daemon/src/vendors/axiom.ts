import {
	type AxiomContextDependencies,
	getAxiomMonitor,
	listAxiomDatasets,
	queryAxiomApl,
} from "@isolate/integrations";
import { type AxiomVendorConfig, type Env, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import { withDependencies } from "./shared";

/**
 * Axiom handlers. The dataset allowlist is configuration; the model can only
 * pick a dataset that is already permitted.
 */
export function createAxiomHandlers(
	config: AxiomVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): AxiomContextDependencies | null => {
		const token = resolveSecret(config.secretEnv, "token", env);
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
		"axiom.query_apl": (params) =>
			withDependencies(dependencies(), (deps) => queryAxiomApl(deps, params)),
		"axiom.get_monitor": (params) =>
			withDependencies(dependencies(), (deps) => getAxiomMonitor(deps, params)),
		"axiom.list_datasets": (params) =>
			withDependencies(dependencies(), (deps) =>
				listAxiomDatasets(deps, params),
			),
	};
}
