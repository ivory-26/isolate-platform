import {
	assertNoCredentialMaterial,
	type ConnectorAuthKind,
	type ConnectorCredentialStatus,
	type ConnectorCredentialSummary,
	connectorAuthKindSchema,
	connectorCredentialRefSchema,
	connectorCredentialStatusSchema,
	connectorDisplayNameSchema,
	connectorIdSchema,
	connectorScopesSchema,
	emptyFreeTierProfile,
	type FreeTierProfile,
	freeTierProfileSchema,
	MAX_CONNECTOR_SCOPES,
	MAX_CREDENTIAL_SCAN_DEPTH,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";

/**
 * Tenant-scoped connector credential metadata store (migration 0010).
 *
 * SECURITY: there is no server-side secret here. A row names the owning
 * device, an opaque `credential_ref` (keychain item name) and bounded metadata;
 * the provider secret stays on the user's device. This module has no
 * ciphertext column, no key version and no secret-returning method.
 *
 * Every read carries `organization_id`; a foreign id is indistinguishable from
 * a missing one. The pure normalizers and row mapper below are shared with the
 * in-memory fake so the DB CHECKs and the fake cannot drift.
 *
 * `displayName`, `credentialRef` and `metadata` are scanned recursively for
 * credential material before the row exists: a device that accidentally
 * reports its keychain item's *value* instead of its name is refused.
 */

/** Metadata is descriptive only; anything larger is a key-smuggling attempt. */
export const CONNECTOR_CREDENTIAL_METADATA_MAX_BYTES = 16 * 1024;

export type CreateConnectorCredentialInput = {
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	/** Device-side keychain item name; never the secret itself. */
	credentialRef: string;
	scopes?: readonly string[];
	status?: ConnectorCredentialStatus;
	freeTierProfile?: FreeTierProfile;
	metadata?: Record<string, unknown>;
	createdBy?: string | null;
};

export type ConnectorCredentialRecord = {
	id: string;
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	credentialRef: string;
	scopes: string[];
	status: ConnectorCredentialStatus;
	freeTierProfile: FreeTierProfile;
	metadata: Record<string, unknown>;
	lastValidatedAt: Date | null;
	lastUsedAt: Date | null;
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
}

const SELECT_COLUMNS = `id, organization_id, device_id, connector_id, display_name, auth_kind, credential_ref, scopes, status, free_tier_profile, metadata, last_validated_at, last_used_at`;

const MAX_CREDENTIAL_ID_CHARS = 128;
const MAX_DEVICE_ID_CHARS = 128;

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function requireNotEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw validationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireBoundedId(
	value: unknown,
	field: string,
	maxChars: number,
): string {
	const id = requireNotEmpty(value, field);
	if (id.length > maxChars) {
		throw validationError(`${field} is too long`);
	}
	return id;
}

function readProfileNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/**
 * Metadata is bounded, JSON-only and credential-free. The returned object is a
 * detached clone so a caller cannot mutate a stored row through its input.
 */
function normalizeCredentialMetadata(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw validationError("metadata must be an object");
	}
	let text: string;
	try {
		text = JSON.stringify(value) ?? "{}";
	} catch {
		throw validationError("metadata must be JSON");
	}
	if (byteLength(text) > CONNECTOR_CREDENTIAL_METADATA_MAX_BYTES) {
		throw validationError(
			`metadata exceeds ${CONNECTOR_CREDENTIAL_METADATA_MAX_BYTES} bytes`,
		);
	}
	assertNoCredentialMaterial(value, {
		// Metadata is not depth-capped by a schema; scan to the hard ceiling.
		maxDepth: MAX_CREDENTIAL_SCAN_DEPTH * 2,
	});
	return JSON.parse(text) as Record<string, unknown>;
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

export function normalizeConnectorCredentialCreate(
	input: CreateConnectorCredentialInput,
): {
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	credentialRef: string;
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
	const deviceId = requireBoundedId(
		input.deviceId,
		"deviceId",
		MAX_DEVICE_ID_CHARS,
	);
	const connectorId = connectorIdSchema.safeParse(input.connectorId);
	if (!connectorId.success) throw validationError("connectorId is invalid");
	const displayName = connectorDisplayNameSchema.safeParse(input.displayName);
	if (!displayName.success) throw validationError("displayName is invalid");
	// A name is metadata, but it must never be a pasted secret.
	assertNoCredentialMaterial(displayName.data);
	const authKind = connectorAuthKindSchema.safeParse(input.authKind);
	if (!authKind.success) throw validationError("authKind is invalid");
	const credentialRef = connectorCredentialRefSchema.safeParse(
		input.credentialRef,
	);
	if (!credentialRef.success) {
		throw validationError(
			`credentialRef is invalid: ${zodIssueSummary(credentialRef.error)}`,
		);
	}
	// The ref names a keychain item; a token-shaped ref is a leaked secret.
	assertNoCredentialMaterial(credentialRef.data);
	const status = connectorCredentialStatusSchema.safeParse(
		input.status ?? "pending_validation",
	);
	if (!status.success) {
		throw validationError(
			`status is invalid: ${zodIssueSummary(status.error)}`,
		);
	}
	const scopes = connectorScopesSchema.safeParse(input.scopes ?? []);
	if (!scopes.success) {
		throw validationError(
			`scopes are invalid: ${zodIssueSummary(scopes.error)}`,
		);
	}
	// Zod caps the array at MAX_CONNECTOR_SCOPES; keep the count check explicit
	// so the cap survives a future schema change.
	if (scopes.data.length > MAX_CONNECTOR_SCOPES) {
		throw validationError(`scopes exceed ${MAX_CONNECTOR_SCOPES} entries`);
	}
	const profile = freeTierProfileSchema.safeParse(
		input.freeTierProfile ?? emptyFreeTierProfile(),
	);
	if (!profile.success) {
		throw validationError(
			`freeTierProfile is invalid: ${zodIssueSummary(profile.error)}`,
		);
	}
	const metadata = normalizeCredentialMetadata(input.metadata ?? {});
	return {
		organizationId,
		deviceId,
		connectorId: connectorId.data,
		displayName: displayName.data,
		authKind: authKind.data,
		credentialRef: credentialRef.data,
		scopes: [...scopes.data],
		status: status.data,
		freeTierProfile: profile.data,
		metadata,
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

export function mapConnectorCredentialRow(
	row: Record<string, unknown>,
): ConnectorCredentialRecord {
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		deviceId: String(row.device_id),
		connectorId: String(row.connector_id),
		displayName: String(row.display_name),
		authKind: row.auth_kind as ConnectorAuthKind,
		credentialRef: String(row.credential_ref),
		scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
		status: row.status as ConnectorCredentialStatus,
		freeTierProfile: normalizeFreeTierProfileValue(
			parseJsonbColumn<unknown>(row.free_tier_profile),
		),
		metadata: parseJsonbColumn<Record<string, unknown>>(row.metadata) ?? {},
		lastValidatedAt:
			row.last_validated_at === null ? null : toDate(row.last_validated_at),
		lastUsedAt: row.last_used_at === null ? null : toDate(row.last_used_at),
	};
}

/** Drops every non-summary column; there is no secret column to drop. */
export function toConnectorCredentialSummary(
	record: ConnectorCredentialRecord,
): ConnectorCredentialSummary {
	return {
		id: record.id,
		organizationId: record.organizationId,
		deviceId: record.deviceId,
		connectorId: record.connectorId,
		displayName: record.displayName,
		authKind: record.authKind,
		credentialRef: record.credentialRef,
		scopes: [...record.scopes],
		status: record.status,
		freeTierProfile: { ...record.freeTierProfile },
		metadata: { ...record.metadata },
		lastValidatedAt:
			record.lastValidatedAt === null ? null : new Date(record.lastValidatedAt),
		lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt),
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
		organization_id, device_id, connector_id, display_name, auth_kind,
		credential_ref, scopes, status, free_tier_profile, metadata, created_by
	) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8,
		$9::text::jsonb, $10::text::jsonb, $11)
	RETURNING ${SELECT_COLUMNS}`,
	list: `SELECT ${SELECT_COLUMNS} FROM connector_credentials
		WHERE organization_id = $1
		ORDER BY connector_id ASC, display_name ASC, id ASC`,
	get: `SELECT ${SELECT_COLUMNS} FROM connector_credentials
		WHERE organization_id = $1 AND id = $2`,
	setStatus: `UPDATE connector_credentials
		SET status = $3, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SELECT_COLUMNS}`,
	touchValidated: `UPDATE connector_credentials
		SET last_validated_at = $3::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SELECT_COLUMNS}`,
	touchUsed: `UPDATE connector_credentials
		SET last_used_at = $3::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SELECT_COLUMNS}`,
	// Revocation keeps the metadata row and only flips status; the secret was
	// never here to clear.
	revoke: `UPDATE connector_credentials
		SET status = 'revoked', updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SELECT_COLUMNS}`,
	delete: `DELETE FROM connector_credentials
		WHERE organization_id = $1 AND id = $2
		RETURNING id`,
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
			normalized.deviceId,
			normalized.connectorId,
			normalized.displayName,
			normalized.authKind,
			normalized.credentialRef,
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
}
