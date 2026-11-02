import {
	acknowledgePagerDutyIncident,
	fetchPagerDutyContext,
	type PagerDutyToolDependencies,
	type PagerDutyWriteDependencies,
	pagerDutyReadFunctions,
	resolvePagerDutyIncident,
} from "@isolate/integrations";
import {
	type Env,
	type PagerDutyVendorConfig,
	resolveVendorSecret,
	type SecretLookup,
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
 * PagerDuty settings. The token comes from the paired store; the sender address
 * and API origin resolve from the paired selectors, the static config, then the
 * legacy `PAGERDUTY_FROM_EMAIL` env var. The write path additionally requires a
 * sender address but the daemon never widens a token scope itself.
 */
export function resolvePagerDutyReadSettings(
	config: PagerDutyVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<PagerDutyToolDependencies> {
	const token = resolveVendorSecret(
		config?.secretEnv,
		"token",
		env,
		credentialRef,
		secretStore,
	);
	if (token === null) return settingsFailure("CONFIG_REQUIRED");
	const fromEmail = resolveOptionalSelector({
		connectorId: "pagerduty",
		key: "fromEmail",
		credentialRef,
		store: secretStore,
		configValue: config?.fromEmail,
		envValue: env.PAGERDUTY_FROM_EMAIL,
	});
	if (!fromEmail.ok) return settingsFailure(fromEmail.reason);
	const baseUrl = resolveOptionalSelector({
		connectorId: "pagerduty",
		key: "baseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.baseUrl,
	});
	if (!baseUrl.ok) return settingsFailure(baseUrl.reason);
	return settingsOk({
		token,
		fetchImpl,
		...(fromEmail.value === undefined ? {} : { fromEmail: fromEmail.value }),
		...(baseUrl.value === undefined ? {} : { baseUrl: baseUrl.value }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

export function resolvePagerDutyWriteSettings(
	config: PagerDutyVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<PagerDutyWriteDependencies> {
	const read = resolvePagerDutyReadSettings(
		config,
		env,
		fetchImpl,
		credentialRef,
		secretStore,
	);
	if (!read.ok) return read;
	const email = read.deps.fromEmail;
	if (email === undefined || email.length === 0) {
		return settingsFailure("CONFIG_REQUIRED");
	}
	return settingsOk({
		token: read.deps.token,
		fromEmail: email,
		// The platform audit trail is written by the worker, not the device.
		audit: () => undefined,
		...(read.deps.baseUrl === undefined ? {} : { baseUrl: read.deps.baseUrl }),
		...(read.deps.timeoutMs === undefined
			? {}
			: { timeoutMs: read.deps.timeoutMs }),
	});
}

/** PagerDuty handlers; acknowledge/resolve stay `scoped_write`. */
export function createPagerDutyHandlers(
	config: PagerDutyVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const readSettings = (credentialRef: string) =>
		resolvePagerDutyReadSettings(
			config,
			env,
			fetchImpl,
			credentialRef,
			secretStore,
		);
	const writeSettings = (credentialRef: string) =>
		resolvePagerDutyWriteSettings(
			config,
			env,
			fetchImpl,
			credentialRef,
			secretStore,
		);

	return {
		"pagerduty.list_incidents": (params, context) =>
			runWithSettings(readSettings(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.listIncidents(deps, params),
			),
		"pagerduty.get_incident": (params, context) =>
			runWithSettings(readSettings(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.getIncident(deps, params),
			),
		"pagerduty.list_log_entries": (params, context) =>
			runWithSettings(readSettings(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.listLogEntries(deps, params),
			),
		"pagerduty.acknowledge": (params, context) =>
			runWithSettings(writeSettings(context.credentialRef), (deps) =>
				acknowledgePagerDutyIncident(deps, params),
			),
		"pagerduty.resolve": (params, context) =>
			runWithSettings(writeSettings(context.credentialRef), (deps) =>
				resolvePagerDutyIncident(deps, params),
			),
		"pagerduty.context.fetch": async (params, context) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"pagerduty",
			);
			if (ref === null) return failure("VALIDATION_FAILED");
			return runWithSettings(readSettings(context.credentialRef), (deps) =>
				fetchPagerDutyContext(deps, {
					incidentId: ref.incidentId,
					incidentFingerprint: parsed.incidentFingerprint,
				}),
			);
		},
	};
}
