import { type OrganizationId, PlatformError } from "@isolate/shared";
import { z } from "zod";
import {
	type ConnectorCredentialSummary,
	connectorIdSchema,
	connectorScopesSchema,
} from "../../../shared/src/types/connector";
import {
	type ConnectorCredentialCrypto,
	unpackConnectorCredentialEnvelope,
} from "./credential-crypto";

/**
 * Server-side credential broker.
 *
 * The worker asks the broker for `(organizationId, connectorId)` and receives
 * the decrypted material only inside a callback; the broker never returns it
 * and never logs it. Only rows with `status = 'active'` are eligible; a
 * missing, revoked, invalid or cross-tenant row fails closed as
 * `INTEGRATION_UNAVAILABLE`.
 *
 * `allowEnvFallback` is opt-in and never the default: a single-tenant
 * deployment may pass a caller-supplied lookup for its own bridge credential,
 * but the broker hardcodes no vendor name or value, and a shared/demo key can
 * never appear by accident.
 */

const MAX_SECRET_CHARS = 12288;
const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MAX_CONFIG_ENTRIES = 32;
const MAX_CONFIG_KEY_CHARS = 64;
const MAX_CONFIG_VALUE_CHARS = 4096;

const payloadSchema = z.strictObject({
	secret: z.string().min(1).max(MAX_SECRET_CHARS),
	config: z
		.record(
			z.string().min(1).max(MAX_CONFIG_KEY_CHARS),
			z.string().max(MAX_CONFIG_VALUE_CHARS),
		)
		.optional(),
});

export type ConnectorCredentialMaterial = {
	secret: string;
	config: Readonly<Record<string, string>>;
	scopes: readonly string[];
};

export type ConnectorEnvCredentialLookup = (
	connectorId: string,
) =>
	| ConnectorCredentialMaterial
	| null
	| Promise<ConnectorCredentialMaterial | null>;

/** Ciphertext shape returned by the repository's separate `getSecret` path. */
export type ConnectorStoredSecret = {
	credential: ConnectorCredentialSummary;
	encryptedPayload: Uint8Array;
	wrappedDek: Uint8Array;
	keyVersion: number;
};

/**
 * Narrow structural view of `ConnectorCredentialRepository`. Declared here so
 * the integrations package does not import the database package; the Postgres
 * repository and the in-memory fake satisfy it structurally.
 */
export interface ConnectorCredentialReader {
	listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]>;
	getSecret(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorStoredSecret | null>;
}

export type ConnectorCredentialBrokerOptions = {
	credentials: ConnectorCredentialReader;
	crypto: ConnectorCredentialCrypto;
	/** Never defaulted to true; single-tenant bridges must opt in. */
	allowEnvFallback?: boolean;
	envLookup?: ConnectorEnvCredentialLookup;
};

export type ConnectorCredentialUse<T> = (
	material: ConnectorCredentialMaterial,
) => T | Promise<T>;

export interface ConnectorCredentialBroker {
	resolve<T>(
		organizationId: OrganizationId,
		connectorId: string,
		use: ConnectorCredentialUse<T>,
	): Promise<T>;
}

function unavailable(connectorId: string, reason: string): PlatformError {
	return new PlatformError(
		"INTEGRATION_UNAVAILABLE",
		`connector "${connectorId}" ${reason}`,
	);
}

function requireOrganizationId(value: unknown): OrganizationId {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PlatformError("VALIDATION_FAILED", "organizationId is required");
	}
	return value as OrganizationId;
}

function requireConnectorId(value: unknown): string {
	const parsed = connectorIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new PlatformError("VALIDATION_FAILED", "connectorId is invalid");
	}
	return parsed.data;
}

function requireMaterial(
	connectorId: string,
	candidate: ConnectorCredentialMaterial | null,
): ConnectorCredentialMaterial {
	if (candidate === null || typeof candidate !== "object") {
		throw unavailable(connectorId, "is not configured");
	}
	if (typeof candidate.secret !== "string" || candidate.secret.length === 0) {
		throw unavailable(connectorId, "credential material is invalid");
	}
	const config = candidate.config ?? {};
	if (config === null || typeof config !== "object" || Array.isArray(config)) {
		throw unavailable(connectorId, "credential config is invalid");
	}
	const scopes = connectorScopesSchema.safeParse(candidate.scopes ?? []);
	if (!scopes.success) {
		throw unavailable(connectorId, "credential scopes are invalid");
	}
	return {
		secret: candidate.secret,
		config: { ...config },
		scopes: [...scopes.data],
	};
}

function decodePayload(
	plaintext: string,
): { secret: string; config: Record<string, string> } | null {
	if (plaintext.length > MAX_PLAINTEXT_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		return null;
	}
	const payload = payloadSchema.safeParse(parsed);
	if (!payload.success) return null;
	const config = payload.data.config ?? {};
	if (Object.keys(config).length > MAX_CONFIG_ENTRIES) return null;
	return { secret: payload.data.secret, config: { ...config } };
}

/**
 * Deterministic pick when more than one row is active for the same connector:
 * display name, then id. The service is expected to keep one active row per
 * connector; the ordering only removes run-to-run nondeterminism.
 */
function selectActive(
	rows: readonly ConnectorCredentialSummary[],
	organizationId: OrganizationId,
	connectorId: string,
): ConnectorCredentialSummary | null {
	const candidates = rows
		.filter(
			(row) =>
				row.organizationId === organizationId &&
				row.connectorId === connectorId &&
				row.status === "active",
		)
		.sort((left, right) => {
			const byName = left.displayName.localeCompare(right.displayName);
			return byName !== 0 ? byName : left.id.localeCompare(right.id);
		});
	return candidates[0] ?? null;
}

export function createConnectorCredentialBroker(
	options: ConnectorCredentialBrokerOptions,
): ConnectorCredentialBroker {
	const allowEnvFallback = options.allowEnvFallback === true;
	if (allowEnvFallback && typeof options.envLookup !== "function") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"env credential fallback requires an envLookup function",
		);
	}

	return {
		async resolve(organizationId, connectorId, use) {
			const org = requireOrganizationId(organizationId);
			const connector = requireConnectorId(connectorId);
			if (typeof use !== "function") {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"credential consumer must be a function",
				);
			}

			const rows = await options.credentials.listByOrganization(org);
			const selected = selectActive(rows, org, connector);
			if (selected === null) {
				if (!allowEnvFallback || options.envLookup === undefined) {
					throw unavailable(connector, "has no active credential");
				}
				const envMaterial = requireMaterial(
					connector,
					await options.envLookup(connector),
				);
				return use(envMaterial);
			}

			const stored = await options.credentials.getSecret(org, selected.id);
			if (stored === null) {
				throw unavailable(connector, "credential is not decryptable");
			}
			if (
				stored.credential.organizationId !== org ||
				stored.credential.connectorId !== connector ||
				stored.credential.id !== selected.id ||
				stored.credential.status !== "active" ||
				stored.keyVersion !== stored.credential.keyVersion
			) {
				throw unavailable(connector, "credential is not usable");
			}

			const envelope = unpackConnectorCredentialEnvelope({
				encryptedPayload: stored.encryptedPayload,
				wrappedDek: stored.wrappedDek,
				keyVersion: stored.keyVersion,
			});
			const plaintext = await options.crypto.open({
				organizationId: org,
				connectorId: connector,
				displayName: stored.credential.displayName,
				envelope,
			});
			const payload = decodePayload(plaintext);
			if (payload === null) {
				throw unavailable(connector, "credential payload is invalid");
			}

			return use({
				secret: payload.secret,
				config: payload.config,
				scopes: [...stored.credential.scopes],
			});
		},
	};
}
