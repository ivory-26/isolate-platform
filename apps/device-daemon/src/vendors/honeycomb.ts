import {
	getHoneycombTrigger,
	type HoneycombToolDependencies,
	listHoneycombSlos,
	runHoneycombQuery,
} from "@isolate/integrations";
import { type Env, type HoneycombVendorConfig, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import { withDependencies } from "./shared";

/** Honeycomb handlers: environment-scoped key bound to one dataset. */
export function createHoneycombHandlers(
	config: HoneycombVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): HoneycombToolDependencies | null => {
		const apiKey = resolveSecret(config.secretEnv, "apiKey", env);
		if (apiKey === null) return null;
		return {
			apiKey,
			dataset: config.dataset,
			fetchImpl,
			...(config.apiBaseUrl === undefined
				? {}
				: { apiBaseUrl: config.apiBaseUrl }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"honeycomb.run_query": (params) =>
			withDependencies(dependencies(), (deps) =>
				runHoneycombQuery(deps, params),
			),
		"honeycomb.get_trigger": (params) =>
			withDependencies(dependencies(), (deps) =>
				getHoneycombTrigger(deps, params),
			),
		"honeycomb.list_slos": (params) =>
			withDependencies(dependencies(), (deps) =>
				listHoneycombSlos(deps, params),
			),
	};
}
