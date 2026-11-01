import {
	fetchSentryContext,
	getSentryIssue,
	getSentryLatestEvent,
	listSentryIssues,
	type SentryToolDependencies,
} from "@isolate/integrations";
import { type Env, resolveSecret, type SentryVendorConfig } from "../config";
import type { ToolHandler } from "../contracts";
import { parseContextFingerprint, readContextParams } from "./context";
import { failure, withDependencies } from "./shared";

/** Sentry handlers: token and optional origin come from device-local config. */
export function createSentryHandlers(
	config: SentryVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const dependencies = (): SentryToolDependencies | null => {
		const token = resolveSecret(config.secretEnv, "token", env);
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
		"sentry.list_issues": (params) =>
			withDependencies(dependencies(), (deps) =>
				listSentryIssues(deps, params),
			),
		"sentry.get_issue": (params) =>
			withDependencies(dependencies(), (deps) => getSentryIssue(deps, params)),
		"sentry.latest_event": (params) =>
			withDependencies(dependencies(), (deps) =>
				getSentryLatestEvent(deps, params),
			),
		"sentry.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "sentry");
			if (ref === null) return failure("VALIDATION_FAILED");
			return withDependencies(dependencies(), (deps) =>
				fetchSentryContext(deps, {
					orgSlug: ref.orgSlug,
					issueId: ref.issueId,
				}),
			);
		},
	};
}
