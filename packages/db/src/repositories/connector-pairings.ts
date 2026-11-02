import {
	assertNoCredentialMaterial,
	type ConnectorAuthKind,
	connectorAuthKindSchema,
	connectorCredentialRefSchema,
	connectorDisplayNameSchema,
	connectorIdSchema,
	connectorScopesSchema,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";

/**
 * One-time browser <-> relay pairing sessions (migration 0016,
 * `connector_pairings`).
 *
 * SECURITY: the pairing code itself never reaches this layer. The browser
 * generates a 256-bit code, the server hashes it with sha256 and stores only
 * the hex digest. There is no secret column and no method that returns the
 * digest to a caller: `ConnectorPairingSummary` drops it, exactly like the
 * device repository drops the token hash.
 *
 * Every method carries `organization_id`; a foreign row is indistinguishable
 * from a missing one. The claim is a single conditional UPDATE
 * (`pending` -> `claimed`, not expired), so two relays presenting the same
 * code cannot both win.
 */

export const CONNECTOR_PAIRING_STATUSES = [
	"pending",
	"claimed",
	"completed",
	"expired",
	"cancelled",
] as const;
export type ConnectorPairingStatus =
	(typeof CONNECTOR_PAIRING_STATUSES)[number];

export const CONNECTOR_PAIRING_CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const CONNECTOR_PAIRING_METADATA_MAX_BYTES = 4 * 1024;
export const CONNECTOR_PAIRING_LIST_DEFAULT = 50;
export const CONNECTOR_PAIRING_LIST_MAX = 100;
const MAX_PAIRING_ID_CHARS = 128;
const MAX_USER_ID_CHARS = 128;

export type CreateConnectorPairingInput = {
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	/** Opaque device-side name for the stored secret; never the secret. */
	credentialRef: string;
	scopes?: readonly string[];
	/** Per-pairing bookkeeping (for example the completed credential id). */
	metadata?: Record<string, unknown>;
	/** sha256 hex of the one-time pairing code. */
	codeHash: string;
	createdBy?: string | null;
	expiresAt: Date;
};

export type ConnectorPairingRecord = {
	id: string;
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	credentialRef: string;
	scopes: string[];
	metadata: Record<string, unknown>;
	codeHash: string;
	status: ConnectorPairingStatus;
	createdBy: string | null;
	expiresAt: Date;
	claimedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

/** Read shape: everything a caller may see except the code hash. */
export type ConnectorPairingSummary = {
	readonly id: string;
	readonly organizationId: OrganizationId;
	readonly deviceId: string;
	readonly connectorId: string;
	readonly displayName: string;
	readonly authKind: ConnectorAuthKind;
	readonly credentialRef: string;
	readonly scopes: readonly string[];
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly status: ConnectorPairingStatus;
	readonly createdBy: string | null;
	readonly expiresAt: Date;
	readonly claimedAt: Date | null;
	readonly completedAt: Date | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
};

export interface ConnectorPairingRepository {
	create(input: CreateConnectorPairingInput): Promise<ConnectorPairingSummary>;
	get(
		organizationId: OrganizationId,
		pairingId: string,
	): Promise<ConnectorPairingSummary | null>;
	findByOrganization(
		organizationId: OrganizationId,
		limit?: number,
	): Promise<ConnectorPairingSummary[]>;
	/**
	 * Atomically moves one `pending`, unexpired code to `claimed`. The device id
	 * is part of the predicate, so a different relay presenting the code gets
	 * nothing. Returns null for wrong, expired, already-claimed or foreign codes.
	 */
	claimByCodeHash(
		organizationId: OrganizationId,
		deviceId: string,
		codeHash: string,
		now?: Date,
	): Promise<ConnectorPairingSummary | null>;
	/** Moves one `claimed` pairing to `completed` and merges metadata. */
	complete(
		organizationId: OrganizationId,
		pairingId: string,
		metadata?: Record<string, unknown>,
		now?: Date,
	): Promise<ConnectorPairingSummary | null>;
	/** Cancels a `pending` or `claimed` pairing. */
	cancel(
		organizationId: OrganizationId,
		pairingId: string,
		now?: Date,
	): Promise<ConnectorPairingSummary | null>;
	/** Marks a `pending` or `claimed` pairing `expired` once its time is up. */
	expire(
		organizationId: OrganizationId,
		pairingId: string,
		now?: Date,
	): Promise<ConnectorPairingSummary | null>;
}

const COLUMNS = `id, organization_id, device_id, connector_id, display_name, auth_kind, credential_ref, scopes, metadata, code_hash, status, created_by, expires_at, claimed_at, completed_at, created_at, updated_at`;

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
	if (id.length > maxChars) throw validationError(`${field} is too long`);
	return id;
}

function requireTimestamp(value: Date | undefined, field: string): string {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw validationError(`${field} must be a valid Date`);
	}
	return value.toISOString();
}

function requireOptionalUserId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const id = requireNotEmpty(value, "createdBy");
	if (id.length > MAX_USER_ID_CHARS) {
		throw validationError("createdBy is too long");
	}
	return id;
}

/** sha256 hex of the pairing code; the code itself never reaches this layer. */
export function normalizeConnectorPairingCodeHash(value: unknown): string {
	if (
		typeof value !== "string" ||
		!CONNECTOR_PAIRING_CODE_HASH_PATTERN.test(value)
	) {
		throw validationError("codeHash is invalid");
	}
	return value;
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

/**
 * Pairing metadata is bookkeeping only (the completed credential id). It is
 * bounded and credential-scanned so a caller cannot use it to smuggle a secret
 * into the pairing row.
 */
function normalizePairingMetadata(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw validationError("metadata must be an object");
	}
	let text: string;
	try {
		text = JSON.stringify(value) ?? "{}";
	} catch {
		throw validationError("metadata must be JSON");
	}
	if (byteLength(text) > CONNECTOR_PAIRING_METADATA_MAX_BYTES) {
		throw validationError(
			`metadata exceeds ${CONNECTOR_PAIRING_METADATA_MAX_BYTES} bytes`,
		);
	}
	try {
		assertNoCredentialMaterial(value, { maxDepth: 4 });
	} catch {
		throw validationError("metadata must not contain credential material");
	}
	return JSON.parse(text) as Record<string, unknown>;
}

export function normalizeConnectorPairingCreate(
	input: CreateConnectorPairingInput,
): {
	organizationId: OrganizationId;
	deviceId: string;
	connectorId: string;
	displayName: string;
	authKind: ConnectorAuthKind;
	credentialRef: string;
	scopes: string[];
	metadata: Record<string, unknown>;
	codeHash: string;
	createdBy: string | null;
	expiresAt: string;
} {
	const organizationId = requireNotEmpty(
		input.organizationId,
		"organizationId",
	) as OrganizationId;
	const deviceId = requireBoundedId(input.deviceId, "deviceId", 128);
	const connectorId = connectorIdSchema.safeParse(input.connectorId);
	if (!connectorId.success) {
		throw validationError(
			`connectorId is invalid: ${zodIssueSummary(connectorId.error)}`,
		);
	}
	const displayName = connectorDisplayNameSchema.safeParse(input.displayName);
	if (!displayName.success) throw validationError("displayName is invalid");
	const authKind = connectorAuthKindSchema.safeParse(input.authKind);
	if (!authKind.success) throw validationError("authKind is invalid");
	const credentialRef = connectorCredentialRefSchema.safeParse(
		input.credentialRef,
	);
	if (!credentialRef.success) throw validationError("credentialRef is invalid");
	const scopes = connectorScopesSchema.safeParse(input.scopes ?? []);
	if (!scopes.success) throw validationError("scopes are invalid");
	return {
		organizationId,
		deviceId,
		connectorId: connectorId.data,
		displayName: displayName.data,
		authKind: authKind.data,
		credentialRef: credentialRef.data,
		scopes: [...scopes.data],
		metadata: normalizePairingMetadata(input.metadata ?? {}),
		codeHash: normalizeConnectorPairingCodeHash(input.codeHash),
		createdBy: requireOptionalUserId(input.createdBy),
		expiresAt: requireTimestamp(input.expiresAt, "expiresAt"),
	};
}

function toDate(value: unknown, field: string): Date {
	const parsed =
		value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
	if (Number.isNaN(parsed.getTime())) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			`connector pairing ${field} column is invalid`,
		);
	}
	return parsed;
}

function toNullableDate(value: unknown, field: string): Date | null {
	if (value === null || value === undefined) return null;
	return toDate(value, field);
}

export function mapConnectorPairingRow(
	row: Record<string, unknown>,
): ConnectorPairingRecord {
	const codeHash = row.code_hash;
	if (
		typeof codeHash !== "string" ||
		!CONNECTOR_PAIRING_CODE_HASH_PATTERN.test(codeHash)
	) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			"connector pairing code hash column is invalid",
		);
	}
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		deviceId: String(row.device_id),
		connectorId: String(row.connector_id),
		displayName: String(row.display_name),
		authKind: row.auth_kind as ConnectorAuthKind,
		credentialRef: String(row.credential_ref),
		scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
		metadata: parseJsonbColumn<Record<string, unknown>>(row.metadata) ?? {},
		codeHash,
		status: row.status as ConnectorPairingStatus,
		createdBy: row.created_by === null ? null : String(row.created_by),
		expiresAt: toDate(row.expires_at, "expires_at"),
		claimedAt: toNullableDate(row.claimed_at, "claimed_at"),
		completedAt: toNullableDate(row.completed_at, "completed_at"),
		createdAt: toDate(row.created_at, "created_at"),
		updatedAt: toDate(row.updated_at, "updated_at"),
	};
}

/** Drops the code hash: summaries leave the repository as plain metadata. */
export function toConnectorPairingSummary(
	record: ConnectorPairingRecord,
): ConnectorPairingSummary {
	return {
		id: record.id,
		organizationId: record.organizationId,
		deviceId: record.deviceId,
		connectorId: record.connectorId,
		displayName: record.displayName,
		authKind: record.authKind,
		credentialRef: record.credentialRef,
		scopes: [...record.scopes],
		metadata: { ...record.metadata },
		status: record.status,
		createdBy: record.createdBy,
		expiresAt: new Date(record.expiresAt),
		claimedAt: record.claimedAt === null ? null : new Date(record.claimedAt),
		completedAt:
			record.completedAt === null ? null : new Date(record.completedAt),
		createdAt: new Date(record.createdAt),
		updatedAt: new Date(record.updatedAt),
	};
}

const STMT = {
	insert: `INSERT INTO connector_pairings (
		organization_id, device_id, connector_id, display_name, auth_kind,
		credential_ref, scopes, metadata, code_hash, created_by, expires_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::text::jsonb, $9, $10,
		$11::timestamptz)
	RETURNING ${COLUMNS}`,
	get: `SELECT ${COLUMNS} FROM connector_pairings
		WHERE organization_id = $1 AND id = $2`,
	list: `SELECT ${COLUMNS} FROM connector_pairings
		WHERE organization_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2`,
	claim: `UPDATE connector_pairings
		SET status = 'claimed', claimed_at = $4::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND device_id = $2 AND code_hash = $3
		AND status = 'pending' AND expires_at > $4::timestamptz
		RETURNING ${COLUMNS}`,
	complete: `UPDATE connector_pairings
		SET status = 'completed', completed_at = $3::timestamptz,
			metadata = metadata || $4::text::jsonb, updated_at = now()
		WHERE organization_id = $1 AND id = $2 AND status = 'claimed'
		RETURNING ${COLUMNS}`,
	cancel: `UPDATE connector_pairings
		SET status = 'cancelled', updated_at = $3::timestamptz
		WHERE organization_id = $1 AND id = $2
		AND status IN ('pending', 'claimed')
		RETURNING ${COLUMNS}`,
	expire: `UPDATE connector_pairings
		SET status = 'expired', updated_at = $3::timestamptz
		WHERE organization_id = $1 AND id = $2
		AND status IN ('pending', 'claimed') AND expires_at <= $3::timestamptz
		RETURNING ${COLUMNS}`,
} as const;

function clampListLimit(value: number | undefined): number {
	if (value === undefined) return CONNECTOR_PAIRING_LIST_DEFAULT;
	if (!Number.isSafeInteger(value) || value < 1) {
		return CONNECTOR_PAIRING_LIST_DEFAULT;
	}
	return Math.min(value, CONNECTOR_PAIRING_LIST_MAX);
}

export class PostgresConnectorPairingRepository
	implements ConnectorPairingRepository
{
	constructor(private readonly sql: PgSql) {}

	async create(
		input: CreateConnectorPairingInput,
	): Promise<ConnectorPairingSummary> {
		const normalized = normalizeConnectorPairingCreate(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.deviceId,
			normalized.connectorId,
			normalized.displayName,
			normalized.authKind,
			normalized.credentialRef,
			normalized.scopes,
			JSON.stringify(normalized.metadata),
			normalized.codeHash,
			normalized.createdBy,
			normalized.expiresAt,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new PlatformError(
				"DB_UNAVAILABLE",
				"connector pairing insert returned no row",
			);
		}
		return toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}

	async get(
		organizationId: OrganizationId,
		pairingId: string,
	): Promise<ConnectorPairingSummary | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			requireNotEmpty(organizationId, "organizationId"),
			requireBoundedId(pairingId, "pairingId", MAX_PAIRING_ID_CHARS),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}

	async findByOrganization(
		organizationId: OrganizationId,
		limit?: number,
	): Promise<ConnectorPairingSummary[]> {
		const rows = (await this.sql.unsafe(STMT.list, [
			requireNotEmpty(organizationId, "organizationId"),
			clampListLimit(limit),
		])) as unknown as Record<string, unknown>[];
		return rows.map((row) =>
			toConnectorPairingSummary(mapConnectorPairingRow(row)),
		);
	}

	async claimByCodeHash(
		organizationId: OrganizationId,
		deviceId: string,
		codeHash: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const rows = (await this.sql.unsafe(STMT.claim, [
			requireNotEmpty(organizationId, "organizationId"),
			requireBoundedId(deviceId, "deviceId", 128),
			normalizeConnectorPairingCodeHash(codeHash),
			requireTimestamp(now, "now"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}

	async complete(
		organizationId: OrganizationId,
		pairingId: string,
		metadata: Record<string, unknown> = {},
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const rows = (await this.sql.unsafe(STMT.complete, [
			requireNotEmpty(organizationId, "organizationId"),
			requireBoundedId(pairingId, "pairingId", MAX_PAIRING_ID_CHARS),
			requireTimestamp(now, "now"),
			JSON.stringify(normalizePairingMetadata(metadata)),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}

	async cancel(
		organizationId: OrganizationId,
		pairingId: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const rows = (await this.sql.unsafe(STMT.cancel, [
			requireNotEmpty(organizationId, "organizationId"),
			requireBoundedId(pairingId, "pairingId", MAX_PAIRING_ID_CHARS),
			requireTimestamp(now, "now"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}

	async expire(
		organizationId: OrganizationId,
		pairingId: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const rows = (await this.sql.unsafe(STMT.expire, [
			requireNotEmpty(organizationId, "organizationId"),
			requireBoundedId(pairingId, "pairingId", MAX_PAIRING_ID_CHARS),
			requireTimestamp(now, "now"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorPairingSummary(mapConnectorPairingRow(rows[0]));
	}
}
