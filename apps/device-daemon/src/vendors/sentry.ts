import {
	fetchSentryContext,
	getSentryIssue,
	getSentryLatestEvent,
	listSentryIssues,
	type SentryToolDependencies,
} from "@isolate/integrations";
import {
	type Env,
	resolveVendorSecret,
	type SecretLookup,
	type SentryVendorConfig,
} from "../config";
import type { ToolHandler } from "../contracts";
import { parseContextFingerprint, readContextParams } from "./context";
import { failure, withDependencies } from "./shared";

/**
 * Sentry handlers: the token resolves from the paired secret store first, then
 * the legacy env var; the optional origin is non-secret config.
 */
export function createSentryHandlers(
	config: SentryVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const dependencies = (
		credentialRef: string,
	): SentryToolDependencies | null => {
		const token = resolveVendorSecret(
			config.secretEnv,
			"token",
			env,
			credentialRef,
			secretStore,
		);
		if (token === null) return null;
		return {
			token,
			fetchImpl,
			...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"sentry.list_issues": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				listSentryIssues(deps, params),
			),
		"sentry.get_issue": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getSentryIssue(deps, params),
			),
		"sentry.latest_event": (params, context) =>
			withDependencies(dependencies(context.credentialRef), (deps) =>
				getSentryLatestEvent(deps, params),
			),
		"sentry.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "sentry");
			if (ref === null) return failure("VALIDATION_FAILED");
			return withDependencies(dependencies(context.credentialRef), (deps) =>
				fetchSentryContext(deps, {
					orgSlug: ref.orgSlug,
					issueId: ref.issueId,
				}),
			);
		},
	};
}
