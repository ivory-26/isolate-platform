import {
	assertNoCredentialMaterial,
	CONNECTOR_ID_PATTERN,
} from "@isolate/shared";
import { z } from "zod";
import type { SecretLookup } from "../config";

/**
 * Per-connector pairing fields and non-secret selectors.
 *
 * This is the single vocabulary for three places:
 * - the loopback pairing page renders the labelled inputs from it;
 * - the pairing POST parser accepts exactly these keys and validates them;
 * - each vendor handler resolves the same keys, with the paired value winning
 *   over the static `vendors.<vendor>` config and the legacy env fallback.
 *
 * Secrets are never validated by shape beyond "non-empty and bounded": the
 * provider decides what a token looks like. Selectors are non-secret and are
 * rejected when they look like credential material, because a pasted key in a
 * URL field would otherwise be stored outside the encrypted secret fields.
 */

export const MAX_PAIRING_SECRET_CHARS = 8_192;
export const MAX_PAIRING_URL_CHARS = 512;
export const MAX_PAIRING_PATH_CHARS = 1_024;
export const MAX_PAIRING_NAME_CHARS = 128;
export const MAX_PAIRING_HELP_URL_CHARS = 512;

export const PAIRING_FIELD_ERROR_CODES = [
	"UNKNOWN_CONNECTOR",
	"UNKNOWN_FIELD",
	"MISSING_REQUIRED",
	"INVALID_VALUE",
	"CREDENTIAL_IN_SELECTOR",
] as const;
export type PairingFieldErrorCode = (typeof PAIRING_FIELD_ERROR_CODES)[number];

export type PairingSecretField = {
	readonly key: string;
	readonly label: string;
	readonly required: boolean;
	readonly hint?: string;
	/** Static "where to get this" link; validated as a public https URL. */
	readonly helpUrl?: string;
};

export type SelectorFieldKind =
	| "https-origin"
	| "https-url"
	| "digits"
	| "uid"
	| "email"
	| "rfc1123-label"
	| "cluster-id"
	| "bounded-name"
	| "file-path";

export type PairingSelectorField = {
	readonly key: string;
	readonly label: string;
	readonly required: boolean;
	readonly kind: SelectorFieldKind;
	/** `url` renders as `<input type="url">`; `text` is the safe default. */
	readonly inputType: "text" | "url";
	readonly hint?: string;
	readonly placeholder?: string;
	/** Static "where to find this" link; validated as a public https URL. */
	readonly helpUrl?: string;
	/** Upper bound for `digits`; ignored by other kinds. */
	readonly maxDigits?: number;
};

export type VendorPairingSpec = {
	readonly connectorId: string;
	/** Human vendor name used by the guided panel copy. */
	readonly vendorName: string;
	readonly summary: string;
	/** Static vendor key/console page shown in step 1 of the panel. */
	readonly keyPageUrl?: string;
	readonly secrets: readonly PairingSecretField[];
	readonly selectors: readonly PairingSelectorField[];
};

export type ParsedPairingFields = {
	readonly fields: Record<string, string>;
	readonly selectors: Record<string, string>;
};

export type ParsePairingResult =
	| { readonly ok: true; readonly value: ParsedPairingFields }
	| { readonly ok: false; readonly code: PairingFieldErrorCode };

/* -------------------------------------------------------------------------- */
/* Bounded selector normalizers                                               */
/* -------------------------------------------------------------------------- */

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function normalizeHttpsUrl(value: string, originOnly: boolean): string | null {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_PAIRING_URL_CHARS) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username !== "" || url.password !== "") return null;
	if (url.search !== "" || url.hash !== "") return null;
	if (originOnly) {
		if (url.pathname !== "/" && url.pathname !== "") return null;
		return url.origin;
	}
	if (url.pathname === "/" || url.pathname === "") return url.origin;
	return url.toString();
}

const emailSchema = z.email().max(254);
const RFC1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLUSTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A help link is static vendor documentation, never user input. It must still be
 * a public https URL with no embedded credentials, because the pairing page
 * renders it as a real anchor and a bad constant would become a live link.
 */
export function isSafeHelpUrl(value: string): boolean {
	if (
		value.length === 0 ||
		value.length > MAX_PAIRING_HELP_URL_CHARS ||
		hasControlCharacters(value)
	) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	if (url.username !== "" || url.password !== "") return false;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".local")) return false;
	return host.includes(".");
}

function normalizeBoundedName(value: string): string | null {
	const trimmed = value.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_PAIRING_NAME_CHARS ||
		hasControlCharacters(trimmed)
	) {
		return null;
	}
	return trimmed;
}

export function normalizeSelectorValue(
	field: PairingSelectorField,
	value: string,
): string | null {
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	switch (field.kind) {
		case "https-origin":
			return normalizeHttpsUrl(trimmed, true);
		case "https-url":
			return normalizeHttpsUrl(trimmed, false);
		case "digits": {
			const max = field.maxDigits ?? 20;
			return new RegExp(`^\\d{1,${max}}$`).test(trimmed) ? trimmed : null;
		}
		case "uid":
			return UID_PATTERN.test(trimmed) ? trimmed : null;
		case "email": {
			const parsed = emailSchema.safeParse(trimmed);
			return parsed.success ? parsed.data : null;
		}
		case "rfc1123-label":
			return RFC1123_LABEL.test(trimmed) ? trimmed : null;
		case "cluster-id":
			return CLUSTER_ID_PATTERN.test(trimmed) ? trimmed : null;
		case "bounded-name":
			return normalizeBoundedName(trimmed);
		case "file-path":
			if (
				trimmed.length > MAX_PAIRING_PATH_CHARS ||
				hasControlCharacters(trimmed)
			) {
				return null;
			}
			return trimmed;
	}
}

/* -------------------------------------------------------------------------- */
/* Vendor specs                                                               */
/* -------------------------------------------------------------------------- */

function secret(
	key: string,
	label: string,
	options: { hint?: string; required?: boolean; helpUrl?: string } = {},
): PairingSecretField {
	return {
		key,
		label,
		required: options.required ?? true,
		...(options.hint === undefined ? {} : { hint: options.hint }),
		...(options.helpUrl === undefined ? {} : { helpUrl: options.helpUrl }),
	};
}

function selector(
	key: string,
	label: string,
	kind: SelectorFieldKind,
	options: {
		required?: boolean;
		hint?: string;
		placeholder?: string;
		helpUrl?: string;
		maxDigits?: number;
	} = {},
): PairingSelectorField {
	const inputType =
		kind === "https-origin" || kind === "https-url" ? "url" : "text";
	return {
		key,
		label,
		required: options.required ?? false,
		kind,
		inputType,
		...(options.hint === undefined ? {} : { hint: options.hint }),
		...(options.helpUrl === undefined ? {} : { helpUrl: options.helpUrl }),
		...(options.placeholder === undefined
			? {}
			: { placeholder: options.placeholder }),
		...(options.maxDigits === undefined
			? {}
			: { maxDigits: options.maxDigits }),
	};
}

const SENTRY_SPEC: VendorPairingSpec = {
	connectorId: "sentry",
	vendorName: "Sentry",
	keyPageUrl: "https://sentry.io/settings/developer-settings/",
	summary: "Sentry auth token and optional self-hosted origin.",
	secrets: [
		secret("token", "Sentry auth token", {
			helpUrl: "https://docs.sentry.io/account/auth-tokens/",
		}),
	],
	selectors: [
		selector("baseUrl", "Sentry URL", "https-origin", {
			hint: "Leave blank for https://sentry.io; self-hosted instances use their own https origin.",
			placeholder: "https://sentry.io",
		}),
	],
};

const GRAFANA_SPEC: VendorPairingSpec = {
	connectorId: "grafana",
	vendorName: "Grafana",
	keyPageUrl:
		"https://grafana.com/docs/grafana/latest/administration/service-accounts/",
	summary: "Grafana stack URL plus a service-account token.",
	secrets: [
		secret("token", "Grafana service-account token", {
			helpUrl:
				"https://grafana.com/docs/grafana/latest/administration/service-accounts/",
		}),
	],
	selectors: [
		selector("baseUrl", "Grafana URL", "https-origin", {
			required: true,
			hint: "The stack origin, for example https://acme.grafana.net.",
			placeholder: "https://acme.grafana.net",
		}),
		selector("orgId", "Organization id", "digits", {
			hint: "Optional; only when the stack has more than one organization.",
			placeholder: "1",
			maxDigits: 10,
		}),
		selector("metricsDatasourceUid", "Metrics datasource UID", "uid", {
			hint: "Optional; the adapter uses the stack default when blank.",
			helpUrl: "https://grafana.com/docs/grafana/latest/datasources/",
		}),
		selector("logsDatasourceUid", "Logs datasource UID", "uid", {
			hint: "Optional; the adapter uses the stack default when blank.",
			helpUrl: "https://grafana.com/docs/grafana/latest/datasources/",
		}),
	],
};

const PAGERDUTY_SPEC: VendorPairingSpec = {
	connectorId: "pagerduty",
	vendorName: "PagerDuty",
	keyPageUrl: "https://docs.pagerduty.com/account-admin/api-access-keys",
	summary: "PagerDuty API token and optional sender address.",
	secrets: [
		secret("token", "PagerDuty API token", {
			helpUrl: "https://docs.pagerduty.com/account-admin/api-access-keys",
		}),
	],
	selectors: [
		selector("fromEmail", "From email", "email", {
			hint: "Optional for reads; required before acknowledge or resolve.",
			placeholder: "oncall@example.com",
		}),
		selector("baseUrl", "PagerDuty API URL", "https-origin", {
			hint: "Leave blank for https://api.pagerduty.com.",
			placeholder: "https://api.pagerduty.com",
		}),
	],
};

const KUBERNETES_SPEC: VendorPairingSpec = {
	connectorId: "kubernetes",
	vendorName: "Kubernetes",
	keyPageUrl:
		"https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/",
	summary:
		"Cluster API URL, namespace and the local service-account token file.",
	secrets: [
		secret("serviceAccountTokenFile", "Service-account token file", {
			hint: "Path on this relay to the mounted token file, for example /var/run/secrets/kubernetes.io/serviceaccount/token.",
			helpUrl:
				"https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/",
		}),
		secret("caFile", "Cluster CA file", {
			hint: "Optional path on this relay to the cluster CA certificate.",
			required: false,
		}),
	],
	selectors: [
		selector("apiUrl", "Kubernetes API URL", "https-url", {
			required: true,
			hint: "https only, for example https://10.0.0.1:6443.",
			placeholder: "https://cluster.example.com:6443",
		}),
		selector("namespace", "Namespace", "rfc1123-label", {
			required: true,
			hint: "The one namespace this credential may read.",
			placeholder: "production",
		}),
		selector("clusterId", "Cluster id", "cluster-id", {
			hint: "Optional display label for the cluster.",
		}),
	],
};

const DATADOG_SPEC: VendorPairingSpec = {
	connectorId: "datadog",
	vendorName: "Datadog",
	keyPageUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
	summary: "Datadog API key and scoped application key.",
	secrets: [
		secret("apiKey", "Datadog API key", {
			helpUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
		}),
		secret("appKey", "Datadog application key", {
			helpUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
		}),
	],
	selectors: [
		selector("baseUrl", "Datadog API site", "https-origin", {
			required: true,
			hint: "The API origin for your site, for example https://api.datadoghq.com.",
			placeholder: "https://api.datadoghq.com",
			helpUrl: "https://docs.datadoghq.com/getting_started/site/",
		}),
	],
};

const NEWRELIC_SPEC: VendorPairingSpec = {
	connectorId: "newrelic",
	vendorName: "New Relic",
	keyPageUrl:
		"https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/",
	summary: "New Relic user API key and account id.",
	secrets: [
		secret("apiKey", "New Relic user API key", {
			helpUrl:
				"https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/",
		}),
	],
	selectors: [
		selector("accountId", "Account id", "digits", {
			required: true,
			hint: "Numeric account id from New Relic.",
			maxDigits: 20,
			helpUrl:
				"https://docs.newrelic.com/docs/accounts/accounts-billing/account-structure/account-id/",
		}),
		selector("endpoint", "GraphQL endpoint", "https-url", {
			hint: "Leave blank for https://api.newrelic.com/graphql; EU accounts use the EU host.",
			placeholder: "https://api.newrelic.com/graphql",
		}),
	],
};

const HONEYCOMB_SPEC: VendorPairingSpec = {
	connectorId: "honeycomb",
	vendorName: "Honeycomb",
	keyPageUrl:
		"https://docs.honeycomb.io/configure/environments/manage-api-keys/",
	summary: "Honeycomb configuration key and environment dataset.",
	secrets: [
		secret("apiKey", "Honeycomb configuration API key", {
			helpUrl:
				"https://docs.honeycomb.io/configure/environments/manage-api-keys/",
		}),
	],
	selectors: [
		selector("dataset", "Dataset", "bounded-name", {
			required: true,
			hint: "The environment dataset this credential may read.",
			placeholder: "production",
		}),
		selector("apiBaseUrl", "API base URL", "https-origin", {
			hint: "Leave blank for https://api.honeycomb.io; EU environments use their own host.",
			placeholder: "https://api.honeycomb.io",
		}),
	],
};

const AXIOM_SPEC: VendorPairingSpec = {
	connectorId: "axiom",
	vendorName: "Axiom",
	keyPageUrl: "https://axiom.co/docs/reference/tokens",
	summary: "Axiom API token, API origin and default dataset.",
	secrets: [
		secret("token", "Axiom API token", {
			helpUrl: "https://axiom.co/docs/reference/tokens",
		}),
	],
	selectors: [
		selector("baseUrl", "Axiom API URL", "https-origin", {
			required: true,
			hint: "For example https://api.axiom.co.",
			placeholder: "https://api.axiom.co",
		}),
		selector("dataset", "Dataset", "bounded-name", {
			required: true,
			hint: "The default dataset this credential may query.",
			placeholder: "production",
		}),
	],
};

const SIGNOZ_SPEC: VendorPairingSpec = {
	connectorId: "signoz",
	vendorName: "SigNoz",
	keyPageUrl: "https://signoz.io/docs/userguide/authentication/",
	summary: "Self-hosted SigNoz URL and a read-only API key.",
	secrets: [
		secret("apiKey", "SigNoz API key", {
			helpUrl: "https://signoz.io/docs/userguide/authentication/",
		}),
	],
	selectors: [
		selector("baseUrl", "SigNoz URL", "https-origin", {
			required: true,
			hint: "The SigNoz instance origin, for example https://signoz.example.com.",
			placeholder: "https://signoz.example.com",
			helpUrl: "https://signoz.io/docs/install/",
		}),
	],
};

const SPECS: readonly VendorPairingSpec[] = [
	SENTRY_SPEC,
	GRAFANA_SPEC,
	PAGERDUTY_SPEC,
	KUBERNETES_SPEC,
	DATADOG_SPEC,
	NEWRELIC_SPEC,
	HONEYCOMB_SPEC,
	AXIOM_SPEC,
	SIGNOZ_SPEC,
];

const SPEC_BY_CONNECTOR = new Map(
	SPECS.map((spec) => [spec.connectorId, spec]),
);

/** Every connector with a guided pairing form, in canonical order. */
export const VENDOR_PAIRING_SPECS: readonly VendorPairingSpec[] = SPECS;

/** The guided form for a connector, or `null` for the generic fallback. */
export function getPairingSpec(
	connectorId: string | null | undefined,
): VendorPairingSpec | null {
	if (typeof connectorId !== "string") return null;
	if (!CONNECTOR_ID_PATTERN.test(connectorId)) return null;
	return SPEC_BY_CONNECTOR.get(connectorId) ?? null;
}

export function findSecretField(
	spec: VendorPairingSpec,
	key: string,
): PairingSecretField | null {
	return spec.secrets.find((field) => field.key === key) ?? null;
}

export function findSelectorField(
	spec: VendorPairingSpec,
	key: string,
): PairingSelectorField | null {
	return spec.selectors.find((field) => field.key === key) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Submission parser                                                          */
/* -------------------------------------------------------------------------- */

export type PairingSubmission = {
	readonly secretFields: Readonly<Record<string, string | undefined>>;
	readonly selectorFields: Readonly<Record<string, string | undefined>>;
};

function failed(code: PairingFieldErrorCode): ParsePairingResult {
	return { ok: false, code };
}

/**
 * Validates one connector's submitted prefixed fields.
 *
 * Rejects an unknown key, an empty required value, a selector that is not a
 * valid bounded shape, and a selector that looks like a credential. Empty
 * optional values are omitted rather than stored as blank strings.
 */
export function parsePairingSubmission(
	connectorId: string,
	submission: PairingSubmission,
): ParsePairingResult {
	const spec = getPairingSpec(connectorId);
	if (spec === null) return failed("UNKNOWN_CONNECTOR");

	const fields: Record<string, string> = Object.create(null);
	for (const key of Object.keys(submission.secretFields)) {
		const field = findSecretField(spec, key);
		if (field === null) return failed("UNKNOWN_FIELD");
		const value = submission.secretFields[key]?.trim() ?? "";
		if (value.length === 0) continue;
		if (value.length > MAX_PAIRING_SECRET_CHARS) {
			return failed("INVALID_VALUE");
		}
		fields[key] = value;
	}
	for (const field of spec.secrets) {
		if (field.required && fields[field.key] === undefined) {
			return failed("MISSING_REQUIRED");
		}
	}
	if (Object.keys(fields).length === 0) return failed("MISSING_REQUIRED");

	const selectors: Record<string, string> = Object.create(null);
	for (const key of Object.keys(submission.selectorFields)) {
		const field = findSelectorField(spec, key);
		if (field === null) return failed("UNKNOWN_FIELD");
		const raw = submission.selectorFields[key]?.trim() ?? "";
		if (raw.length === 0) continue;
		const normalized = normalizeSelectorValue(field, raw);
		if (normalized === null) return failed("INVALID_VALUE");
		selectors[key] = normalized;
	}
	for (const field of spec.selectors) {
		if (field.required && selectors[field.key] === undefined) {
			return failed("MISSING_REQUIRED");
		}
	}
	if (Object.keys(selectors).length > 0) {
		try {
			assertNoCredentialMaterial(selectors, { maxDepth: 2 });
		} catch {
			return failed("CREDENTIAL_IN_SELECTOR");
		}
	}

	return { ok: true, value: { fields, selectors } };
}

/* -------------------------------------------------------------------------- */
/* Call-time selector resolution                                              */
/* -------------------------------------------------------------------------- */

export type SelectorLookupOptions = {
	readonly connectorId: string;
	readonly key: string;
	readonly credentialRef: string;
	readonly store?: SecretLookup;
	/** Static `vendors.<vendor>` value from `~/.isolate/connectors.json`. */
	readonly configValue?: string | number | null;
	/** Legacy env fallback, only where the daemon documented one. */
	readonly envValue?: string | null;
};

export type OptionalSelectorResolution =
	| { readonly ok: true; readonly value: string | undefined }
	| { readonly ok: false; readonly reason: "INVALID_SELECTOR" };

export type RequiredSelectorResolution =
	| { readonly ok: true; readonly value: string }
	| {
			readonly ok: false;
			readonly reason: "CONFIG_REQUIRED" | "INVALID_SELECTOR";
	  };

const INVALID_SELECTOR: OptionalSelectorResolution = {
	ok: false,
	reason: "INVALID_SELECTOR",
};

function storedSelectorValue(options: SelectorLookupOptions): string | null {
	const selectors =
		options.store?.getSelectors?.(options.credentialRef) ?? null;
	if (selectors === null) return null;
	const value = selectors[options.key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function normalizeCandidate(
	options: SelectorLookupOptions,
	value: string,
): OptionalSelectorResolution {
	const spec = getPairingSpec(options.connectorId);
	if (spec === null) return INVALID_SELECTOR;
	const field = findSelectorField(spec, options.key);
	if (field === null) return INVALID_SELECTOR;
	const normalized = normalizeSelectorValue(field, value);
	if (normalized === null) return INVALID_SELECTOR;
	return { ok: true, value: normalized };
}

/**
 * Precedence: paired selector for this credential ref, then the static vendor
 * config, then the legacy env fallback. A malformed stored value fails closed
 * instead of silently falling back to a broader configuration.
 */
export function resolveOptionalSelector(
	options: SelectorLookupOptions,
): OptionalSelectorResolution {
	const stored = storedSelectorValue(options);
	if (stored !== null) return normalizeCandidate(options, stored);
	if (
		options.configValue !== undefined &&
		options.configValue !== null &&
		String(options.configValue).trim().length > 0
	) {
		return normalizeCandidate(options, String(options.configValue));
	}
	if (
		options.envValue !== undefined &&
		options.envValue !== null &&
		options.envValue.trim().length > 0
	) {
		return normalizeCandidate(options, options.envValue);
	}
	return { ok: true, value: undefined };
}

export function resolveRequiredSelector(
	options: SelectorLookupOptions,
): RequiredSelectorResolution {
	const resolved = resolveOptionalSelector(options);
	if (!resolved.ok) return resolved;
	if (resolved.value === undefined) {
		return { ok: false, reason: "CONFIG_REQUIRED" };
	}
	return { ok: true, value: resolved.value };
}

/** True when the connector has a guided form (used by the pairing page). */
export function hasGuidedPairing(connectorId: string): boolean {
	return getPairingSpec(connectorId) !== null;
}
