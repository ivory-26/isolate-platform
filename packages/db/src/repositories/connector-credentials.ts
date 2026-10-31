import {
	type ConnectorAuthKind,
	type ConnectorCredentialStatus,
	type ConnectorCredentialSummary,
	connectorAuthKindSchema,
	connectorCredentialStatusSchema,
	connectorDisplayNameSchema,
	connectorIdSchema,
	connectorScopesSchema,
	emptyFreeTierProfile,
	type FreeTierProfile,
	freeTierProfileSchema,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";

/**
 * Tenant-scoped connector credential store (migration 0010).
 *
 * Every read carries `organization_id`; a foreign id is indistinguishable from
 * a missing one. Summaries exclude the ciphertext envelope, which is returned
 * only by `getSecret` — the single method the credential broker may use.
 *
 * The pure normalizers and row mapper below are shared with the in-memory fake
 * so the DB CHECKs and the fake cannot drift.
 */

export type ConnectorCredentialCiphertext = {
	/** Packed AEAD payload: nonce || tag || ciphertext. */
	readonly encryptedPayload: Uint8Array;
	/** DEK wrapped under the operator KEK. */
	readonly wrappedDek: Uint8Array;
	readonly keyVersion: number;
};

export type CreateConnectorCredentialInput = {
	organizationId: OrganizationId;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	ciphertext: ConnectorCredentialCiphertext;
	scopes?: readonly string[];
	status?: ConnectorCredentialStatus;
	freeTierProfile?: FreeTierProfile;
	metadata?: Record<string, unknown>;
	createdBy?: string | null;
};

export type StoredConnectorCredentialSecret = {
	credential: ConnectorCredentialSummary;
	encryptedPayload: Uint8Array;
	wrappedDek: Uint8Array;
	keyVersion: number;
};

export type ConnectorCredentialRecord = {
	id: string;
	organizationId: OrganizationId;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	scopes: string[];
	status: ConnectorCredentialStatus;
	freeTierProfile: FreeTierProfile;
	metadata: Record<string, unknown>;
	keyVersion: number;
	lastValidatedAt: Date | null;
	lastUsedAt: Date | null;
	createdBy: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface ConnectorCredentialRepository {
	create(
		input: CreateConnectorCredentialInput,
	): Promise<ConnectorCredentialSummary>;
	listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]>;
	get(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null>;
	setStatus(
		organizationId: OrganizationId,
		credentialId: string,
		status: ConnectorCredentialStatus,
	): Promise<ConnectorCredentialSummary | null>;
	touchValidated(
		organizationId: OrganizationId,
		credentialId: string,
		validatedAt?: Date,
	): Promise<ConnectorCredentialSummary | null>;
	touchUsed(
		organizationId: OrganizationId,
		credentialId: string,
		usedAt?: Date,
	): Promise<ConnectorCredentialSummary | null>;
	revoke(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null>;
	delete(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<boolean>;
	getSecret(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<StoredConnectorCredentialSecret | null>;
}

const SUMMARY_COLUMNS = `id, organization_id, connector_id, display_name, auth_kind, scopes, status, free_tier_profile, metadata, key_version, last_validated_at, last_used_at, created_by, created_at, updated_at`;

const MAX_ENCRYPTED_PAYLOAD_BYTES = 256 * 1024;
const MAX_WRAPPED_DEK_BYTES = 4096;
const MAX_CREDENTIAL_ID_CHARS = 128;

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function requireNotEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw validationError(`${field} must be a non-empty string`);
	}
	return value;
}

function readProfileNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/**
 * Picks the four verified free-tier numbers out of a stored profile. Catalog
 * profiles legitimately carry extra fields (availability, source, ...); those
 * are not part of the credential summary and are ignored, never trusted.
 */
export function normalizeFreeTierProfileValue(value: unknown): FreeTierProfile {
	const source =
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	return {
		requestsPerMinute: readProfileNumber(source.requestsPerMinute),
		requestsPerDay: readProfileNumber(source.requestsPerDay),
		eventsPerMonth: readProfileNumber(source.eventsPerMonth),
		retentionDays: readProfileNumber(source.retentionDays),
	};
}

function requireBytes(
	value: unknown,
	field: string,
	maxBytes: number,
): Uint8Array {
	if (!(value instanceof Uint8Array) || value.byteLength === 0) {
		throw validationError(`${field} must be a non-empty byte array`);
	}
	if (value.byteLength > maxBytes) {
		throw validationError(`${field} exceeds ${maxBytes} bytes`);
	}
	return new Uint8Array(value);
}

function requireKeyVersion(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw validationError("keyVersion must be a positive integer");
	}
	return value as number;
}

export function normalizeConnectorCredentialCreate(
	input: CreateConnectorCredentialInput,
): {
	organizationId: OrganizationId;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	encryptedPayload: Uint8Array;
	wrappedDek: Uint8Array;
	keyVersion: number;
	scopes: string[];
	status: ConnectorCredentialStatus;
	freeTierProfile: FreeTierProfile;
	metadata: Record<string, unknown>;
	createdBy: string | null;
} {
	const organizationId = requireNotEmpty(
		input.organizationId,
		"organizationId",
	) as OrganizationId;
	const connectorId = connectorIdSchema.safeParse(input.connectorId);
	if (!connectorId.success) throw validationError("connectorId is invalid");
	const displayName = connectorDisplayNameSchema.safeParse(input.displayName);
	if (!displayName.success) throw validationError("displayName is invalid");
	const authKind = connectorAuthKindSchema.safeParse(input.authKind);
	if (!authKind.success) throw validationError("authKind is invalid");
	const status = connectorCredentialStatusSchema.safeParse(
		input.status ?? "pending_validation",
	);
	if (!status.success) throw validationError("status is invalid");
	const scopes = connectorScopesSchema.safeParse(input.scopes ?? []);
	if (!scopes.success) {
		throw validationError(
			`scopes are invalid: ${zodIssueSummary(scopes.error)}`,
		);
	}
	const profile = freeTierProfileSchema.safeParse(
		input.freeTierProfile ?? emptyFreeTierProfile(),
	);
	if (!profile.success) {
		throw validationError(
			`freeTierProfile is invalid: ${zodIssueSummary(profile.error)}`,
		);
	}
	const metadata = input.metadata ?? {};
	if (
		metadata === null ||
		typeof metadata !== "object" ||
		Array.isArray(metadata)
	) {
		throw validationError("metadata must be an object");
	}
	return {
		organizationId,
		connectorId: connectorId.data,
		displayName: displayName.data,
		authKind: authKind.data,
		encryptedPayload: requireBytes(
			input.ciphertext?.encryptedPayload,
			"encryptedPayload",
			MAX_ENCRYPTED_PAYLOAD_BYTES,
		),
		wrappedDek: requireBytes(
			input.ciphertext?.wrappedDek,
			"wrappedDek",
			MAX_WRAPPED_DEK_BYTES,
		),
		keyVersion: requireKeyVersion(input.ciphertext?.keyVersion),
		scopes: [...scopes.data],
		status: status.data,
		freeTierProfile: profile.data,
		metadata: { ...metadata },
		createdBy:
			input.createdBy === undefined || input.createdBy === null
				? null
				: requireNotEmpty(input.createdBy, "createdBy"),
	};
}

function toDate(value: unknown): Date {
	return value instanceof Date
		? new Date(value.getTime())
		: new Date(String(value));
}

function toBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return new Uint8Array(value);
	throw new PlatformError(
		"DB_UNAVAILABLE",
		"connector credential ciphertext column is not a byte array",
	);
}

export function mapConnectorCredentialRow(
	row: Record<string, unknown>,
): ConnectorCredentialRecord {
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		connectorId: String(row.connector_id),
		displayName: String(row.display_name),
		authKind: row.auth_kind as ConnectorAuthKind,
		scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
		status: row.status as ConnectorCredentialStatus,
		freeTierProfile: normalizeFreeTierProfileValue(
			parseJsonbColumn<unknown>(row.free_tier_profile),
		),
		metadata: parseJsonbColumn<Record<string, unknown>>(row.metadata) ?? {},
		keyVersion: Number(row.key_version),
		lastValidatedAt:
			row.last_validated_at === null ? null : toDate(row.last_validated_at),
		lastUsedAt: row.last_used_at === null ? null : toDate(row.last_used_at),
		createdBy: row.created_by === null ? null : String(row.created_by),
		createdAt: toDate(row.created_at),
		updatedAt: toDate(row.updated_at),
	};
}

export function toConnectorCredentialSummary(
	record: ConnectorCredentialRecord,
): ConnectorCredentialSummary {
	return {
		id: record.id,
		organizationId: record.organizationId,
		connectorId: record.connectorId,
		displayName: record.displayName,
		authKind: record.authKind,
		scopes: [...record.scopes],
		status: record.status,
		freeTierProfile: { ...record.freeTierProfile },
		metadata: { ...record.metadata },
		keyVersion: record.keyVersion,
		lastValidatedAt:
			record.lastValidatedAt === null ? null : new Date(record.lastValidatedAt),
		lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
		createdAt: new Date(record.createdAt),
		updatedAt: new Date(record.updatedAt),
	};
}

function requireCredentialId(value: unknown): string {
	const id = requireNotEmpty(value, "credentialId");
	if (id.length > MAX_CREDENTIAL_ID_CHARS) {
		throw validationError("credentialId is too long");
	}
	return id;
}

function requireOptionalTimestamp(
	value: Date | undefined,
	field: string,
): string {
	if (value === undefined) return new Date().toISOString();
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw validationError(`${field} must be a valid Date`);
	}
	return value.toISOString();
}

const STMT = {
	insert: `INSERT INTO connector_credentials (
		organization_id, connector_id, display_name, auth_kind,
		encrypted_payload, wrapped_dek, key_version, scopes, status,
		free_tier_profile, metadata, created_by
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9,
		$10::text::jsonb, $11::text::jsonb, $12)
	RETURNING ${SUMMARY_COLUMNS}`,
	list: `SELECT ${SUMMARY_COLUMNS} FROM connector_credentials
		WHERE organization_id = $1
		ORDER BY connector_id ASC, display_name ASC, id ASC`,
	get: `SELECT ${SUMMARY_COLUMNS} FROM connector_credentials
		WHERE organization_id = $1 AND id = $2`,
	setStatus: `UPDATE connector_credentials
		SET status = $3, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUMMARY_COLUMNS}`,
	touchValidated: `UPDATE connector_credentials
		SET last_validated_at = $3::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUMMARY_COLUMNS}`,
	touchUsed: `UPDATE connector_credentials
		SET last_used_at = $3::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUMMARY_COLUMNS}`,
	revoke: `UPDATE connector_credentials
		SET status = 'revoked',
			encrypted_payload = ''::bytea,
			wrapped_dek = ''::bytea,
			updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUMMARY_COLUMNS}`,
	delete: `DELETE FROM connector_credentials
		WHERE organization_id = $1 AND id = $2
		RETURNING id`,
	getSecret: `SELECT ${SUMMARY_COLUMNS}, encrypted_payload, wrapped_dek
		FROM connector_credentials
		WHERE organization_id = $1
		  AND id = $2
		  AND status <> 'revoked'
		  AND octet_length(encrypted_payload) > 0
		  AND octet_length(wrapped_dek) > 0`,
} as const;

export class PostgresConnectorCredentialRepository
	implements ConnectorCredentialRepository
{
	constructor(private readonly sql: PgSql) {}

	async create(
		input: CreateConnectorCredentialInput,
	): Promise<ConnectorCredentialSummary> {
		const normalized = normalizeConnectorCredentialCreate(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.connectorId,
			normalized.displayName,
			normalized.authKind,
			normalized.encryptedPayload,
			normalized.wrappedDek,
			normalized.keyVersion,
			normalized.scopes,
			normalized.status,
			JSON.stringify(normalized.freeTierProfile),
			JSON.stringify(normalized.metadata),
			normalized.createdBy,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new PlatformError(
				"DB_UNAVAILABLE",
				"connector credential insert returned no row",
			);
		}
		return toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]> {
		const org = requireNotEmpty(organizationId, "organizationId");
		const rows = (await this.sql.unsafe(STMT.list, [org])) as unknown as Record<
			string,
			unknown
		>[];
		return rows.map((row) =>
			toConnectorCredentialSummary(mapConnectorCredentialRow(row)),
		);
	}

	async get(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async setStatus(
		organizationId: OrganizationId,
		credentialId: string,
		status: ConnectorCredentialStatus,
	): Promise<ConnectorCredentialSummary | null> {
		const parsed = connectorCredentialStatusSchema.safeParse(status);
		if (!parsed.success) throw validationError("status is invalid");
		const rows = (await this.sql.unsafe(STMT.setStatus, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
			parsed.data,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async touchValidated(
		organizationId: OrganizationId,
		credentialId: string,
		validatedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const rows = (await this.sql.unsafe(STMT.touchValidated, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
			requireOptionalTimestamp(validatedAt, "validatedAt"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async touchUsed(
		organizationId: OrganizationId,
		credentialId: string,
		usedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const rows = (await this.sql.unsafe(STMT.touchUsed, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
			requireOptionalTimestamp(usedAt, "usedAt"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async revoke(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const rows = (await this.sql.unsafe(STMT.revoke, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorCredentialSummary(mapConnectorCredentialRow(rows[0]));
	}

	async delete(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<boolean> {
		const rows = (await this.sql.unsafe(STMT.delete, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
		])) as unknown as Record<string, unknown>[];
		return rows.length > 0;
	}

	async getSecret(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<StoredConnectorCredentialSecret | null> {
		const rows = (await this.sql.unsafe(STMT.getSecret, [
			requireNotEmpty(organizationId, "organizationId"),
			requireCredentialId(credentialId),
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return null;
		const record = mapConnectorCredentialRow(rows[0]);
		return {
			credential: toConnectorCredentialSummary(record),
			encryptedPayload: toBytes(rows[0].encrypted_payload),
			wrappedDek: toBytes(rows[0].wrapped_dek),
			keyVersion: record.keyVersion,
		};
	}
}
