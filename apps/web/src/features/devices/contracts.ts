import { z } from "zod";

/**
 * Client-safe contracts for the device and connector surfaces (W20).
 *
 * The browser never holds a vendor key. A connect request carries only the
 * opaque device-side keychain name (`credentialRef`); the device daemon reads
 * the secret from its own keychain. Response parsers cap sizes so a malformed
 * or oversized payload fails closed instead of reaching the UI.
 */

/* -------------------------------------------------------------------------- */
/* Connector catalog (closed union, mirrors the server's ten connectors)      */
/* -------------------------------------------------------------------------- */

export const CONNECTOR_IDS = [
	"github",
	"sentry",
	"grafana",
	"pagerduty",
	"kubernetes",
	"datadog",
	"newrelic",
	"honeycomb",
	"axiom",
	"signoz",
] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export const CONNECTOR_LABELS: Record<ConnectorId, string> = {
	github: "GitHub",
	sentry: "Sentry",
	grafana: "Grafana",
	pagerduty: "PagerDuty",
	kubernetes: "Kubernetes",
	datadog: "Datadog",
	newrelic: "New Relic",
	honeycomb: "Honeycomb",
	axiom: "Axiom",
	signoz: "SigNoz",
};

export function connectorLabel(id: string): string {
	return CONNECTOR_LABELS[id as ConnectorId] ?? id;
}

export const CONNECTOR_AUTH_KINDS = [
	"api_key",
	"oauth_client_credentials",
	"oauth_authorization_code",
	"service_account_json",
	"bot_token",
	"self_host_url_token",
] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const AUTH_KIND_LABELS: Record<ConnectorAuthKind, string> = {
	api_key: "API key",
	oauth_client_credentials: "OAuth client credentials",
	oauth_authorization_code: "OAuth authorization code",
	service_account_json: "Service account JSON",
	bot_token: "Bot token",
	self_host_url_token: "Self-hosted URL + token",
};

export function authKindLabel(kind: string): string {
	return AUTH_KIND_LABELS[kind as ConnectorAuthKind] ?? kind;
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                           */
/* -------------------------------------------------------------------------- */

export const deviceStatusSchema = z.enum(["pending", "active", "revoked"]);
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
	pending: "Pending",
	active: "Active",
	revoked: "Revoked",
};

export function deviceStatusLabel(status: string): string {
	return DEVICE_STATUS_LABELS[status as DeviceStatus] ?? status;
}

export const deviceViewSchema = z.strictObject({
	id: z.uuid(),
	displayName: z.string().min(1).max(100),
	status: deviceStatusSchema,
	lastSeenAt: z.string().nullable(),
});
export type DeviceView = z.infer<typeof deviceViewSchema>;

export const deviceListResponseSchema = z.strictObject({
	devices: z.array(deviceViewSchema).max(500),
});

/** Returned exactly once; the UI must clear it when the dialog closes. */
export const issuedDeviceTokenSchema = z.strictObject({
	deviceId: z.uuid(),
	token: z.string().min(16).max(512),
	expiresAt: z.string().min(1),
});
export type IssuedDeviceToken = z.infer<typeof issuedDeviceTokenSchema>;

export const revokedDeviceSchema = z.strictObject({
	deviceId: z.uuid(),
	status: z.literal("revoked"),
});

export const connectorCredentialStatusSchema = z.enum([
	"pending_validation",
	"active",
	"invalid",
	"revoked",
]);
export type ConnectorCredentialStatus = z.infer<
	typeof connectorCredentialStatusSchema
>;

export const CONNECTOR_STATUS_LABELS: Record<
	ConnectorCredentialStatus,
	string
> = {
	pending_validation: "Pending validation",
	active: "Active",
	invalid: "Invalid",
	revoked: "Revoked",
};

export function connectorStatusLabel(status: string): string {
	return CONNECTOR_STATUS_LABELS[status as ConnectorCredentialStatus] ?? status;
}

export const connectorCredentialSchema = z.strictObject({
	id: z.uuid(),
	deviceId: z.uuid(),
	connectorId: z.string().min(1).max(32),
	displayName: z.string().min(1).max(100),
	authKind: z.enum(CONNECTOR_AUTH_KINDS),
	credentialRef: z.string().min(1).max(200),
	scopes: z.array(z.string().min(1).max(64)).max(32),
	status: connectorCredentialStatusSchema,
	freeTierProfile: z.strictObject({
		requestsPerMinute: z.number().nullable(),
		requestsPerDay: z.number().nullable(),
		eventsPerMonth: z.number().nullable(),
		retentionDays: z.number().nullable(),
	}),
	metadata: z.record(z.string(), z.unknown()),
	lastValidatedAt: z.string().nullable(),
	lastUsedAt: z.string().nullable(),
});
export type ConnectorCredentialView = z.infer<typeof connectorCredentialSchema>;

export const connectorListResponseSchema = z.strictObject({
	credentials: z.array(connectorCredentialSchema).max(500),
});

export const connectorConnectReceiptSchema = z.strictObject({
	credentialId: z.uuid(),
});

export const connectorRevokeReceiptSchema = z.strictObject({
	credentialId: z.uuid(),
	status: z.literal("revoked"),
});

/* -------------------------------------------------------------------------- */
/* Request validation                                                         */
/* -------------------------------------------------------------------------- */

export const MAX_DEVICE_NAME_CHARS = 100;
export const MAX_CREDENTIAL_REF_CHARS = 200;
export const MAX_CONNECTOR_SCOPES = 32;

const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9._:/~-]+$/;
const SCOPE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * Mirrors the server's secret detector closely enough to stop a pasted vendor
 * key at the form. The server re-checks and remains authoritative.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]/i,
	/github_pat_[A-Za-z0-9_]/i,
	/xox[bp]-[A-Za-z0-9-]/i,
	/AKIA[0-9A-Z]{16}/i,
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/i,
];

export function looksLikeCredentialSecret(value: string): boolean {
	if (value.length > 256) return true;
	return CREDENTIAL_SHAPES.some((pattern) => pattern.test(value));
}

export type ValidationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

export function validateDeviceName(input: string): ValidationResult<string> {
	const value = input.trim();
	if (value.length < 1 || value.length > MAX_DEVICE_NAME_CHARS) {
		return {
			ok: false,
			error: "Enter a device name of 1 to 100 characters.",
		};
	}
	return { ok: true, value };
}

export type ScopeParseResult =
	| { readonly ok: true; readonly scopes: string[] }
	| { readonly ok: false; readonly error: string };

/** Scopes are whitespace- or comma-separated provider tokens. */
export function parseScopeTokens(input: string): ScopeParseResult {
	const tokens = input
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	const unique = [...new Set(tokens)];
	if (unique.length > MAX_CONNECTOR_SCOPES) {
		return { ok: false, error: "Add at most 32 scopes." };
	}
	if (unique.some((token) => !SCOPE_TOKEN_PATTERN.test(token))) {
		return {
			ok: false,
			error:
				"Scopes use letters, digits, dots, underscores, colons or hyphens.",
		};
	}
	return { ok: true, scopes: unique };
}

export const connectConnectorFormSchema = z.strictObject({
	deviceId: z.uuid(),
	connectorId: z.enum(CONNECTOR_IDS),
	displayName: z.string().trim().min(1).max(100),
	authKind: z.enum(CONNECTOR_AUTH_KINDS),
	credentialRef: z.string().trim().min(1).max(MAX_CREDENTIAL_REF_CHARS),
});
export type ConnectConnectorForm = z.infer<typeof connectConnectorFormSchema>;

export type ConnectConnectorInput = ConnectConnectorForm & {
	readonly scopes: string[];
};

export type ConnectConnectorValues = {
	readonly deviceId: string;
	readonly connectorId: string;
	readonly displayName: string;
	readonly authKind: string;
	readonly credentialRef: string;
	readonly scopesText: string;
};

/**
 * Validates the connect form without ever forwarding a secret. Field-specific
 * messages are fixed text; submitted values are not echoed back.
 */
export function buildConnectInput(
	values: ConnectConnectorValues,
): ValidationResult<ConnectConnectorInput> {
	if (values.deviceId.length === 0) {
		return { ok: false, error: "Select an active device." };
	}
	if (!(CONNECTOR_IDS as readonly string[]).includes(values.connectorId)) {
		return { ok: false, error: "Choose one of the ten supported connectors." };
	}
	if (!(CONNECTOR_AUTH_KINDS as readonly string[]).includes(values.authKind)) {
		return { ok: false, error: "Choose an authentication kind." };
	}
	if (values.displayName.trim().length === 0) {
		return { ok: false, error: "Give the connection a display name." };
	}
	const credentialRef = values.credentialRef.trim();
	if (credentialRef.length === 0) {
		return {
			ok: false,
			error:
				"Enter the keychain item name that holds the credential on the device.",
		};
	}
	if (looksLikeCredentialSecret(credentialRef)) {
		return {
			ok: false,
			error:
				"That value looks like a vendor secret. Enter the keychain item name only; the key never leaves the device.",
		};
	}
	if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
		return {
			ok: false,
			error:
				"The keychain name may use letters, digits, dot, slash, colon, underscore, tilde and hyphen.",
		};
	}
	const scopes = parseScopeTokens(values.scopesText);
	if (!scopes.ok) return scopes;

	const parsed = connectConnectorFormSchema.safeParse({
		deviceId: values.deviceId,
		connectorId: values.connectorId,
		displayName: values.displayName,
		authKind: values.authKind,
		credentialRef,
	});
	if (!parsed.success) {
		return {
			ok: false,
			error: "Check the device, connector, auth kind and display name.",
		};
	}
	return {
		ok: true,
		value: { ...parsed.data, scopes: scopes.scopes },
	};
}

/* -------------------------------------------------------------------------- */
/* Fixed API failure text                                                     */
/* -------------------------------------------------------------------------- */

export type DeviceApiFailureKind =
	| "auth"
	| "forbidden"
	| "invalid"
	| "not-found"
	| "rate-limited"
	| "unavailable"
	| "unknown";

export const API_FAILURE_MESSAGES: Record<DeviceApiFailureKind, string> = {
	auth: "Sign in to continue.",
	forbidden:
		"Your role cannot perform this action. Owners and admins manage devices and connectors.",
	invalid: "The request is invalid. Check the values and try again.",
	"not-found": "That device or connector was not found in this organization.",
	"rate-limited": "Too many requests. Try again in a moment.",
	unavailable:
		"Device management is not enabled for this deployment, or live data is unavailable.",
	unknown: "The request could not be completed. Try again.",
};

export function failureKindForStatus(status: number): DeviceApiFailureKind {
	if (status === 401) return "auth";
	if (status === 403) return "forbidden";
	if (status === 404) return "not-found";
	if (status === 429) return "rate-limited";
	if (status === 503) return "unavailable";
	if (status === 400 || status === 413 || status === 415) return "invalid";
	return "unknown";
}

/** Display name for a device id, without inventing a device that is not listed. */
export function deviceNameFor(
	devices: readonly DeviceView[],
	deviceId: string,
): string {
	return (
		devices.find((device) => device.id === deviceId)?.displayName ??
		"Unknown device"
	);
}
