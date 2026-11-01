import { z } from "zod";
import type { OrganizationId } from "./ids";

/**
 * Per-organization connector contracts (waves 16–17).
 *
 * SECURITY: user provider keys are never stored on the server. The secret lives
 * on the user's device (OS keychain / browser storage). The server stores only
 * connector metadata, a device registration, a sha256 hash of the device auth
 * token, and an opaque `credentialRef` that names the device-side keychain
 * item. A summary therefore never carries a secret, a ciphertext fragment, a
 * token or a wrapped key.
 *
 * All patterns and caps are enforced at the boundary (Zod) and again in the
 * database migration, so neither layer can widen the other.
 */

export const CONNECTOR_AUTH_KINDS = [
	"api_key",
	"oauth_client_credentials",
	"oauth_authorization_code",
	"service_account_json",
	"bot_token",
	"self_host_url_token",
] as const;
export const connectorAuthKindSchema = z.enum(CONNECTOR_AUTH_KINDS);
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const CONNECTOR_CREDENTIAL_STATUSES = [
	"pending_validation",
	"active",
	"invalid",
	"revoked",
] as const;
export const connectorCredentialStatusSchema = z.enum(
	CONNECTOR_CREDENTIAL_STATUSES,
);
export type ConnectorCredentialStatus =
	(typeof CONNECTOR_CREDENTIAL_STATUSES)[number];

export const CONNECTOR_DEVICE_STATUSES = [
	"pending",
	"active",
	"revoked",
] as const;
export const connectorDeviceStatusSchema = z.enum(CONNECTOR_DEVICE_STATUSES);
export type ConnectorDeviceStatus = (typeof CONNECTOR_DEVICE_STATUSES)[number];

/** Lowercase token; mirrors the `connector_credentials.connector_id` CHECK. */
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_CONNECTOR_ID_CHARS = 32;
export const connectorIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_CONNECTOR_ID_CHARS)
	.regex(CONNECTOR_ID_PATTERN, "lowercase connector id required");

export const MIN_CONNECTOR_DISPLAY_NAME_CHARS = 1;
export const MAX_CONNECTOR_DISPLAY_NAME_CHARS = 100;
export const connectorDisplayNameSchema = z
	.string()
	.trim()
	.min(MIN_CONNECTOR_DISPLAY_NAME_CHARS)
	.max(MAX_CONNECTOR_DISPLAY_NAME_CHARS);

/**
 * Opaque device-side reference to a credential (keychain item name, browser
 * storage key, ...). It names the secret; it is never the secret. Bounded to
 * the migration CHECK and free of control characters.
 */
export const MAX_CONNECTOR_CREDENTIAL_REF_CHARS = 200;

/** Rejects ASCII control characters without embedding them in a regex. */
function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export const connectorCredentialRefSchema = z
	.string()
	.min(1)
	.max(MAX_CONNECTOR_CREDENTIAL_REF_CHARS)
	.refine(
		(value) => value.trim().length > 0,
		"credential ref must not be blank",
	)
	.refine((value) => !hasControlCharacters(value), "invalid credential ref");

/** Scopes are provider-defined tokens, bounded in both count and length. */
export const MAX_CONNECTOR_SCOPES = 32;
export const MAX_CONNECTOR_SCOPE_CHARS = 64;
export const CONNECTOR_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const connectorScopeSchema = z
	.string()
	.min(1)
	.max(MAX_CONNECTOR_SCOPE_CHARS)
	.regex(CONNECTOR_SCOPE_PATTERN, "invalid scope token");
export const connectorScopesSchema = z
	.array(connectorScopeSchema)
	.max(MAX_CONNECTOR_SCOPES);

/**
 * Verified free-tier limits copied from the connector catalog, never from a
 * user session. `null` means "not verified" and must never be read as
 * unlimited.
 */
export const freeTierProfileSchema = z.strictObject({
	requestsPerMinute: z.number().int().nonnegative().nullable(),
	requestsPerDay: z.number().int().nonnegative().nullable(),
	eventsPerMonth: z.number().int().nonnegative().nullable(),
	retentionDays: z.number().int().nonnegative().nullable(),
});
export type FreeTierProfile = z.infer<typeof freeTierProfileSchema>;

export function emptyFreeTierProfile(): FreeTierProfile {
	return {
		requestsPerMinute: null,
		requestsPerDay: null,
		eventsPerMonth: null,
		retentionDays: null,
	};
}

/**
 * Read shape returned by every credential repository list/get. Deliberately
 * excludes secrets, ciphertext, key versions and token hashes: the server has
 * no material to return.
 */
export type ConnectorCredentialSummary = {
	readonly id: string;
	readonly organizationId: OrganizationId;
	readonly deviceId: string;
	readonly connectorId: string;
	readonly displayName: string;
	readonly authKind: ConnectorAuthKind;
	readonly credentialRef: string;
	readonly scopes: readonly string[];
	readonly status: ConnectorCredentialStatus;
	readonly freeTierProfile: Readonly<FreeTierProfile>;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly lastValidatedAt: Date | null;
	readonly lastUsedAt: Date | null;
};

/**
 * Read shape returned by the device repository. The sha256 token hash stays
 * inside the repository: summaries never carry it.
 */
export type ConnectorDeviceSummary = {
	readonly id: string;
	readonly organizationId: OrganizationId;
	readonly userId: string | null;
	readonly displayName: string;
	readonly status: ConnectorDeviceStatus;
	readonly lastSeenAt: Date | null;
	/** Token expiry; null only for legacy rows created before 0014. */
	readonly expiresAt: Date | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
};
