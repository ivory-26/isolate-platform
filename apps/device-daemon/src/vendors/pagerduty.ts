import {
	acknowledgePagerDutyIncident,
	fetchPagerDutyContext,
	type PagerDutyToolDependencies,
	type PagerDutyWriteDependencies,
	pagerDutyReadFunctions,
	resolvePagerDutyIncident,
} from "@isolate/integrations";
import { type Env, type PagerDutyVendorConfig, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import { parseContextFingerprint, readContextParams } from "./context";
import { failure, withDependencies } from "./shared";

/**
 * PagerDuty handlers. Reads use the configured token; acknowledge/resolve are
 * `scoped_write` and additionally need a valid `From` address. The write token
 * should carry `incidents.write`; the daemon does not widen anything itself.
 */
export function createPagerDutyHandlers(
	config: PagerDutyVendorConfig,
	env: Env,
	fetchImpl: typeof fetch,
): Record<string, ToolHandler> {
	const fromEmail = (): string | null => {
		if (config.fromEmail !== undefined) return config.fromEmail;
		const fallback = env.PAGERDUTY_FROM_EMAIL?.trim();
		return fallback !== undefined && fallback.length > 0 ? fallback : null;
	};
	const readDependencies = (): PagerDutyToolDependencies | null => {
		const token = resolveSecret(config.secretEnv, "token", env);
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
	const writeDependencies = (): PagerDutyWriteDependencies | null => {
		const token = resolveSecret(config.secretEnv, "token", env);
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
		"pagerduty.list_incidents": (params) =>
			withDependencies(readDependencies(), (deps) =>
				pagerDutyReadFunctions.listIncidents(deps, params),
			),
		"pagerduty.get_incident": (params) =>
			withDependencies(readDependencies(), (deps) =>
				pagerDutyReadFunctions.getIncident(deps, params),
			),
		"pagerduty.list_log_entries": (params) =>
			withDependencies(readDependencies(), (deps) =>
				pagerDutyReadFunctions.listLogEntries(deps, params),
			),
		"pagerduty.acknowledge": (params) =>
			withDependencies(writeDependencies(), (deps) =>
				acknowledgePagerDutyIncident(deps, params),
			),
		"pagerduty.resolve": (params) =>
			withDependencies(writeDependencies(), (deps) =>
				resolvePagerDutyIncident(deps, params),
			),
		"pagerduty.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"pagerduty",
			);
			if (ref === null) return failure("VALIDATION_FAILED");
			return withDependencies(readDependencies(), (deps) =>
				fetchPagerDutyContext(deps, {
					incidentId: ref.incidentId,
					incidentFingerprint: parsed.incidentFingerprint,
				}),
			);
		},
	};
}
