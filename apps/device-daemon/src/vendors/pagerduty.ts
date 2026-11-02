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
import { failure, withDependencies } from "./shared";

/**
 * PagerDuty handlers. Reads use the paired token (or the legacy env var);
 * acknowledge/resolve are `scoped_write` and additionally need a valid `From`
 * address. The write token should carry `incidents.write`; the daemon does not
 * widen anything itself.
 */
export function createPagerDutyHandlers(
	config: PagerDutyVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const fromEmail = (): string | null => {
		if (config.fromEmail !== undefined) return config.fromEmail;
		const fallback = env.PAGERDUTY_FROM_EMAIL?.trim();
		return fallback !== undefined && fallback.length > 0 ? fallback : null;
	};
	const tokenFor = (credentialRef: string): string | null =>
		resolveVendorSecret(
			config.secretEnv,
			"token",
			env,
			credentialRef,
			secretStore,
		);
	const readDependencies = (
		credentialRef: string,
	): PagerDutyToolDependencies | null => {
		const token = tokenFor(credentialRef);
		if (token === null) return null;
		const email = fromEmail();
		return {
			token,
			fetchImpl,
			...(email === null ? {} : { fromEmail: email }),
			...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	const writeDependencies = (
		credentialRef: string,
	): PagerDutyWriteDependencies | null => {
		const token = tokenFor(credentialRef);
		const email = fromEmail();
		if (token === null || email === null) return null;
		return {
			token,
			fromEmail: email,
			// The platform audit trail is written by the worker, not the device.
			audit: () => undefined,
			...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
			...(config.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		};
	};
	return {
		"pagerduty.list_incidents": (params, context) =>
			withDependencies(readDependencies(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.listIncidents(deps, params),
			),
		"pagerduty.get_incident": (params, context) =>
			withDependencies(readDependencies(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.getIncident(deps, params),
			),
		"pagerduty.list_log_entries": (params, context) =>
			withDependencies(readDependencies(context.credentialRef), (deps) =>
				pagerDutyReadFunctions.listLogEntries(deps, params),
			),
		"pagerduty.acknowledge": (params, context) =>
			withDependencies(writeDependencies(context.credentialRef), (deps) =>
				acknowledgePagerDutyIncident(deps, params),
			),
		"pagerduty.resolve": (params, context) =>
			withDependencies(writeDependencies(context.credentialRef), (deps) =>
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
			return withDependencies(readDependencies(context.credentialRef), (deps) =>
				fetchPagerDutyContext(deps, {
					incidentId: ref.incidentId,
					incidentFingerprint: parsed.incidentFingerprint,
				}),
			);
		},
	};
}
