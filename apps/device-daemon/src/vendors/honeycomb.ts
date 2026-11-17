import {
	fetchHoneycombIncidentContext,
	getHoneycombTrigger,
	HONEYCOMB_TRIGGER_INCIDENT_KIND,
	type HoneycombToolDependencies,
	listHoneycombSlos,
	runHoneycombQuery,
} from "@isolate/integrations";
import {
	type Env,
	type HoneycombVendorConfig,
	resolveVendorSecret,
	type SecretLookup,
} from "../config";
import type { ToolHandler } from "../contracts";
import {
	parseContextFingerprint,
	readContextParams,
	requiredService,
} from "./context";
import { resolveOptionalSelector, resolveRequiredSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

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

/**
 * The adapter's own normalizer emits `trigger_triggered` as the incident kind.
 * That is an incident classification, not a query kind; forwarding it verbatim
 * used to fail the whole evidence call `VALIDATION_FAILED` even though the
 * query template is fixed. It maps to the adapter default (`latency`); any
 * other unknown kind is still an explicit sender error.
 */
const HONEYCOMB_SIGNAL_KIND_QUERY_KIND: Readonly<
	Record<string, HoneycombQueryKind>
> = {
	[HONEYCOMB_TRIGGER_INCIDENT_KIND]: "latency",
};

function honeycombAlertState(value: string): HoneycombAlertState | null {
	return (
		HONEYCOMB_ALERT_STATES.find((candidate) => candidate === value) ?? null
	);
}

function honeycombQueryKind(value: string): HoneycombQueryKind | null {
	return HONEYCOMB_QUERY_KINDS.find((candidate) => candidate === value) ?? null;
}

/**
 * Honeycomb settings: paired key first, legacy env var second. The dataset is a
 * required selector and the API base is optional; both may come only from the
 * paired entry, so no `vendors.honeycomb` config is required.
 */
export function resolveHoneycombSettings(
	config: HoneycombVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<HoneycombToolDependencies> {
	const apiKey = resolveVendorSecret(
		config?.secretEnv,
		"apiKey",
		env,
		credentialRef,
		secretStore,
	);
	if (apiKey === null) return settingsFailure("CONFIG_REQUIRED");
	const dataset = resolveRequiredSelector({
		connectorId: "honeycomb",
		key: "dataset",
		credentialRef,
		store: secretStore,
		configValue: config?.dataset,
	});
	if (!dataset.ok) return settingsFailure(dataset.reason);
	const apiBaseUrl = resolveOptionalSelector({
		connectorId: "honeycomb",
		key: "apiBaseUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.apiBaseUrl,
	});
	if (!apiBaseUrl.ok) return settingsFailure(apiBaseUrl.reason);
	return settingsOk({
		apiKey,
		dataset: dataset.value,
		fetchImpl,
		...(apiBaseUrl.value === undefined ? {} : { apiBaseUrl: apiBaseUrl.value }),
		...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
	});
}

/** Honeycomb handlers: paired fields > static config > legacy env. */
export function createHoneycombHandlers(
	config: HoneycombVendorConfig | undefined,
	env: Env,
	fetchImpl: typeof fetch,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveHoneycombSettings(
			config,
			env,
			fetchImpl,
			credentialRef,
			secretStore,
		);

	return {
		"honeycomb.run_query": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				runHoneycombQuery(deps, params),
			),
		"honeycomb.get_trigger": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				getHoneycombTrigger(deps, params),
			),
		"honeycomb.list_slos": (params, context) =>
			runWithSettings(settings(context.credentialRef), (deps) =>
				listHoneycombSlos(deps, params),
			),
		"honeycomb.context.fetch": async (params, context) => {
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
				const requested =
					honeycombQueryKind(parsed.kind) ??
					HONEYCOMB_SIGNAL_KIND_QUERY_KIND[parsed.kind] ??
					null;
				if (requested === null) return failure("VALIDATION_FAILED");
				kind = requested;
			}
			return runWithSettings(settings(context.credentialRef), (deps) =>
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
