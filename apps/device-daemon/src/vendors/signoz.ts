import {
	fetchSignozContext,
	getSignozRule,
	listSignozRules,
	querySignozRange,
	type SignozContextDependencies,
} from "@isolate/integrations";
import { type Env, resolveSecret, type SignozVendorConfig } from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { failure, withDependencies } from "./shared";

/** SigNoz handlers: self-hosted instance URL plus a read-only API key. */
export function createSignozHandlers(
	config: SignozVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): SignozContextDependencies | null => {
		const apiKey = resolveSecret(config.secretEnv, "apiKey", env);
		if (apiKey === null) return null;
		return {
			baseUrl: config.baseUrl,
			apiKey,
			fetchImpl,
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"signoz.query_range": (params) =>
			withDependencies(dependencies(), (deps) =>
				querySignozRange(deps, params),
			),
		"signoz.get_rule": (params) =>
			withDependencies(dependencies(), (deps) => getSignozRule(deps, params)),
		"signoz.list_rules": (params) =>
			withDependencies(dependencies(), (deps) => listSignozRules(deps, params)),
		"signoz.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "signoz");
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			return withDependencies(dependencies(), (deps) =>
				fetchSignozContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					ruleId: ref.ruleId,
				}),
			);
		},
	};
}
