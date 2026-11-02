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
import { resolveOptionalSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

/**
 * Sentry settings. A paired credential works with no `vendors.sentry` entry:
 * the token comes from the encrypted store, the optional origin from the paired
 * selector, the static config or the adapter default. The legacy env var is the
 * last fallback only.
 */
export function resolveSentrySettings(
	config: SentryVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<SentryToolDependencies> {
	const token = resolveVendorSecret(
		config?.secretEnv,
		"token",
		env,
		credentialRef,
		secretStore,
	);
	if (token === null) return settingsFailure("CONFIG_REQUIRED");
	const baseUrl = resolveOptionalSelector({
		connectorId: "sentry",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	return settingsOk({
		token,
		fetchImpl,
		...(baseUrl.value === undefined ? {} : { baseUrl: baseUrl.value }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** Sentry handlers: paired store > static config > legacy env. */
export function createSentryHandlers(
	config: SentryVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveSentrySettings(config, env, fetchImpl, credentialRef, secretStore);

	return {
		"sentry.list_issues": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				listSentryIssues(deps, params),
			),
		"sentry.get_issue": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getSentryIssue(deps, params),
			),
		"sentry.latest_event": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getSentryLatestEvent(deps, params),
			),
		"sentry.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(parsed.incidentFingerprint, "sentry");
			if (ref === null) return failure("VALIDATION_FAILED");
			return runWithSettings(settings(context.credentialRef), (deps) =>
				fetchSentryContext(deps, {
					orgSlug: ref.orgSlug,
					issueId: ref.issueId,
				}),
			);
		},
	};
}
