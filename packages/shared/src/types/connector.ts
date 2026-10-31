import { z } from "zod";
import type { OrganizationId } from "./ids";

/**
 * Per-organization connector credential contracts (wave 16).
 *
 * A connector is connected by the user, for their own organization, with their
 * own account. The stored row carries the ciphertext envelope and bounded
 * metadata only; a `ConnectorCredentialSummary` is the read shape and never
 * carries a secret, a ciphertext fragment or a wrapped key.
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
 * Read shape returned by every repository list/get. Deliberately omits
 * `encryptedPayload`, `wrappedDek`, nonces and tags: ciphertext leaves the
 * repository only through the separate `getSecret` path.
 */
export type ConnectorCredentialSummary = {
	readonly id: string;
	readonly organizationId: OrganizationId;
	readonly connectorId: string;
	readonly displayName: string;
	readonly authKind: ConnectorAuthKind;
	readonly scopes: readonly string[];
	readonly status: ConnectorCredentialStatus;
	readonly freeTierProfile: Readonly<FreeTierProfile>;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly keyVersion: number;
	readonly lastValidatedAt: Date | null;
	readonly lastUsedAt: Date | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
};
