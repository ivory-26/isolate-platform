import {
	fetchHoneycombIncidentContext,
	getHoneycombTrigger,
	type HoneycombToolDependencies,
	listHoneycombSlos,
	runHoneycombQuery,
} from "@isolate/integrations";
import { type Env, type HoneycombVendorConfig, resolveSecret } from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { failure, withDependencies } from "./shared";

/**
 * Honeycomb's fingerprint carries `dataset:trigger-id:alert-state`. The key is
 * environment-scoped to the configured dataset, so the fingerprint dataset is
 * informational; the trigger snapshot is rebuilt from the fingerprint and the
 * adapter re-validates it before use.
 */
const HONEYCOMB_ALERT_STATES = [
	"triggered",
	"firing",
	"critical",
	"warning",
	"ok",
	"resolved",
	"recovered",
] as const;
type HoneycombAlertState = (typeof HONEYCOMB_ALERT_STATES)[number];
const HONEYCOMB_QUERY_KINDS = ["latency", "error_rate", "saturation"] as const;
type HoneycombQueryKind = (typeof HONEYCOMB_QUERY_KINDS)[number];
const HONEYCOMB_TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function honeycombAlertState(value: string): HoneycombAlertState | null {
	return (
		HONEYCOMB_ALERT_STATES.find((candidate) => candidate === value) ?? null
	);
}

function honeycombQueryKind(value: string): HoneycombQueryKind | null {
	return HONEYCOMB_QUERY_KINDS.find((candidate) => candidate === value) ?? null;
}

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
		"honeycomb.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"honeycomb",
			);
			const service = requiredService(parsed);
			if (ref === null || service === null) {
				return failure("VALIDATION_FAILED");
			}
			if (!HONEYCOMB_TRIGGER_ID_PATTERN.test(ref.triggerId)) {
				return failure("VALIDATION_FAILED");
			}
			const state = honeycombAlertState(ref.state);
			if (state === null) return failure("VALIDATION_FAILED");
			let kind: HoneycombQueryKind | undefined;
			if (parsed.kind !== undefined) {
				const requested = honeycombQueryKind(parsed.kind);
				if (requested === null) return failure("VALIDATION_FAILED");
				kind = requested;
			}
			return withDependencies(dependencies(), (deps) =>
				fetchHoneycombIncidentContext(
					{
						...deps,
						trigger: { id: ref.triggerId, name: ref.triggerId, state },
					},
					{
						incidentFingerprint: parsed.incidentFingerprint,
						service,
						...(kind === undefined ? {} : { kind }),
					},
				),
			);
		},
	};
}
