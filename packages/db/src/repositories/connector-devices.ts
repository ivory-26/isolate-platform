import { timingSafeEqual } from "node:crypto";
import {
	type ConnectorDeviceStatus,
	type ConnectorDeviceSummary,
	connectorDeviceStatusSchema,
	connectorDisplayNameSchema,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Tenant-scoped device registry (migration 0010, `connector_devices`).
 *
 * A device is the user-owned execution proxy: it holds the provider secret in
 * its OS keychain and authenticates to the platform with a bearer token. The
 * database stores only the sha256 hex of that token. `verifyByTokenHash`
 * re-compares the stored hash in constant time before returning a summary, so
 * a query-level match is never the sole control.
 *
 * Every method carries `organization_id`; a foreign row is indistinguishable
 * from a missing one. Summaries never carry the token hash.
 */

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DEVICE_ID_CHARS = 128;
const MAX_USER_ID_CHARS = 128;

export type CreateConnectorDeviceInput = {
	organizationId: OrganizationId;
	userId?: string | null;
	displayName: string;
	/** sha256 hex of the device auth token; never the token itself. */
	tokenHash: string;
	status?: ConnectorDeviceStatus;
	/** Token expiry; undefined/null means a legacy non-expiring token. */
	expiresAt?: Date | null;
};

export type ConnectorDeviceRecord = {
	id: string;
	organizationId: OrganizationId;
	userId: string | null;
	displayName: string;
	tokenHash: string;
	status: ConnectorDeviceStatus;
	lastSeenAt: Date | null;
	expiresAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface ConnectorDeviceRepository {
	create(input: CreateConnectorDeviceInput): Promise<ConnectorDeviceSummary>;
	/** Returns only an `active` device whose stored hash matches. */
	verifyByTokenHash(
		organizationId: OrganizationId,
		tokenHash: string,
	): Promise<ConnectorDeviceSummary | null>;
	touchSeen(
		organizationId: OrganizationId,
		deviceId: string,
		seenAt?: Date,
	): Promise<ConnectorDeviceSummary | null>;
	revoke(
		organizationId: OrganizationId,
		deviceId: string,
	): Promise<ConnectorDeviceSummary | null>;
	listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorDeviceSummary[]>;
}

const DEVICE_COLUMNS = `id, organization_id, user_id, display_name, token_hash, status, last_seen_at, expires_at, created_at, updated_at`;

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function requireNotEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw validationError(`${field} must be a non-empty string`);
	}
	return value;
}

function requireDeviceId(value: unknown): string {
	const id = requireNotEmpty(value, "deviceId");
	if (id.length > MAX_DEVICE_ID_CHARS) {
		throw validationError("deviceId is too long");
	}
	return id;
}

function requireUserId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const id = requireNotEmpty(value, "userId");
	if (id.length > MAX_USER_ID_CHARS) {
		throw validationError("userId is too long");
	}
	return id;
}

/** sha256 hex of the device token; the value itself never reaches this layer. */
export function normalizeConnectorDeviceTokenHash(value: unknown): string {
	if (typeof value !== "string" || !TOKEN_HASH_PATTERN.test(value)) {
		throw validationError("tokenHash is invalid");
	}
	return value;
}

/**
 * Constant-time equality for two validated sha256 hex digests. Any malformed
 * input is a non-match rather than an error, so an auth check fails closed.
 */
export function constantTimeEqualTokenHash(
	provided: unknown,
	stored: unknown,
): boolean {
	if (
		typeof provided !== "string" ||
		!TOKEN_HASH_PATTERN.test(provided) ||
		typeof stored !== "string" ||
		!TOKEN_HASH_PATTERN.test(stored)
	) {
		return false;
	}
	const left = Buffer.from(provided, "hex");
	const right = Buffer.from(stored, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeConnectorDeviceCreate(
	input: CreateConnectorDeviceInput,
): {
	organizationId: OrganizationId;
	userId: string | null;
	displayName: string;
	tokenHash: string;
	status: ConnectorDeviceStatus;
	expiresAt: Date | null;
} {
	const organizationId = requireNotEmpty(
		input.organizationId,
		"organizationId",
	) as OrganizationId;
	const displayName = connectorDisplayNameSchema.safeParse(input.displayName);
	if (!displayName.success) throw validationError("displayName is invalid");
	const status = connectorDeviceStatusSchema.safeParse(
		input.status ?? "pending",
	);
	if (!status.success) {
		throw validationError(
			`status is invalid: ${zodIssueSummary(status.error)}`,
		);
	}
	return {
		organizationId,
		userId: requireUserId(input.userId),
		displayName: displayName.data,
		tokenHash: normalizeConnectorDeviceTokenHash(input.tokenHash),
		status: status.data,
		expiresAt: normalizeExpiresAt(input.expiresAt),
	};
}

function normalizeExpiresAt(value: Date | null | undefined): Date | null {
	if (value === undefined || value === null) return null;
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw validationError("expiresAt must be a valid Date");
	}
	return new Date(value.getTime());
}

function toDate(value: unknown, field: string): Date {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return new Date(value.getTime());
	}
	const parsed = new Date(String(value));
	if (Number.isNaN(parsed.getTime())) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			`connector device ${field} column is invalid`,
		);
	}
	return parsed;
}

export function mapConnectorDeviceRow(
	row: Record<string, unknown>,
): ConnectorDeviceRecord {
	const tokenHash = row.token_hash;
	if (typeof tokenHash !== "string" || !TOKEN_HASH_PATTERN.test(tokenHash)) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			"connector device token hash column is invalid",
		);
	}
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		userId: row.user_id === null ? null : String(row.user_id),
		displayName: String(row.display_name),
		tokenHash,
		status: row.status as ConnectorDeviceStatus,
		lastSeenAt:
			row.last_seen_at === null
				? null
				: toDate(row.last_seen_at, "last_seen_at"),
		expiresAt:
			row.expires_at === null || row.expires_at === undefined
				? null
				: toDate(row.expires_at, "expires_at"),
		createdAt: toDate(row.created_at, "created_at"),
		updatedAt: toDate(row.updated_at, "updated_at"),
	};
}

/** Drops the token hash: summaries leave the repository as plain metadata. */
export function toConnectorDeviceSummary(
	record: ConnectorDeviceRecord,
): ConnectorDeviceSummary {
	return {
		id: record.id,
		organizationId: record.organizationId,
		userId: record.userId,
		displayName: record.displayName,
		status: record.status,
		lastSeenAt: record.lastSeenAt === null ? null : new Date(record.lastSeenAt),
		expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt),
		createdAt: new Date(record.createdAt),
		updatedAt: new Date(record.updatedAt),
	};
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
	insert: `INSERT INTO connector_devices (
		organization_id, user_id, display_name, token_hash, status, expires_at
	) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
	RETURNING ${DEVICE_COLUMNS}`,
	list: `SELECT ${DEVICE_COLUMNS} FROM connector_devices
		WHERE organization_id = $1
		ORDER BY display_name ASC, id ASC`,
	verify: `SELECT ${DEVICE_COLUMNS} FROM connector_devices
		WHERE organization_id = $1 AND token_hash = $2 AND status = 'active'
		AND (expires_at IS NULL OR expires_at > now())`,
	touchSeen: `UPDATE connector_devices
		SET last_seen_at = $3::timestamptz, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${DEVICE_COLUMNS}`,
	revoke: `UPDATE connector_devices
		SET status = 'revoked', updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${DEVICE_COLUMNS}`,
} as const;

export class PostgresConnectorDeviceRepository
	implements ConnectorDeviceRepository
{
	constructor(private readonly sql: PgSql) {}

	async create(
		input: CreateConnectorDeviceInput,
	): Promise<ConnectorDeviceSummary> {
		const normalized = normalizeConnectorDeviceCreate(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.userId,
			normalized.displayName,
			normalized.tokenHash,
			normalized.status,
			normalized.expiresAt === null ? null : normalized.expiresAt.toISOString(),
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new PlatformError(
				"DB_UNAVAILABLE",
				"connector device insert returned no row",
			);
		}
		return toConnectorDeviceSummary(mapConnectorDeviceRow(rows[0]));
	}

	async verifyByTokenHash(
		organizationId: OrganizationId,
		tokenHash: string,
	): Promise<ConnectorDeviceSummary | null> {
		const hash = normalizeConnectorDeviceTokenHash(tokenHash);
		const rows = (await this.sql.unsafe(STMT.verify, [
			requireNotEmpty(organizationId, "organizationId"),
			hash,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return null;
		const record = mapConnectorDeviceRow(rows[0]);
		if (
			record.status !== "active" ||
			!constantTimeEqualTokenHash(hash, record.tokenHash)
		) {
			return null;
		}
		return toConnectorDeviceSummary(record);
	}

	async touchSeen(
		organizationId: OrganizationId,
		deviceId: string,
		seenAt?: Date,
	): Promise<ConnectorDeviceSummary | null> {
		const rows = (await this.sql.unsafe(STMT.touchSeen, [
			requireNotEmpty(organizationId, "organizationId"),
			requireDeviceId(deviceId),
			requireOptionalTimestamp(seenAt, "seenAt"),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorDeviceSummary(mapConnectorDeviceRow(rows[0]));
	}

	async revoke(
		organizationId: OrganizationId,
		deviceId: string,
	): Promise<ConnectorDeviceSummary | null> {
		const rows = (await this.sql.unsafe(STMT.revoke, [
			requireNotEmpty(organizationId, "organizationId"),
			requireDeviceId(deviceId),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0
			? null
			: toConnectorDeviceSummary(mapConnectorDeviceRow(rows[0]));
	}

	async listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorDeviceSummary[]> {
		const rows = (await this.sql.unsafe(STMT.list, [
			requireNotEmpty(organizationId, "organizationId"),
		])) as unknown as Record<string, unknown>[];
		return rows.map((row) =>
			toConnectorDeviceSummary(mapConnectorDeviceRow(row)),
		);
	}
}
