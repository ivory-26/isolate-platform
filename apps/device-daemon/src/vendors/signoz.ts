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
import { failure, withDependencies } from "./shared";

/**
 * SigNoz handlers: self-hosted instance URL plus a read-only API key resolved
 * from the paired store first, then the legacy env var.
 */
export function createSignozHandlers(
	config: SignozVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): SignozContextDependencies | null => {
		const apiKey = resolveVendorSecret(
			config.secretEnv,
			"apiKey",
			env,
			credentialRef,
			secretStore,
		);
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
		"signoz.query_range": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				querySignozRange(deps, params),
			),
		"signoz.get_rule": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getSignozRule(deps, params),
			),
		"signoz.list_rules": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
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
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchSignozContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					service,
					ruleId: ref.ruleId,
				}),
			);
		},
	};
}
