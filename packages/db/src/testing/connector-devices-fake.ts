import type { ConnectorDeviceSummary, OrganizationId } from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import {
	type ConnectorDeviceRecord,
	type ConnectorDeviceRepository,
	type CreateConnectorDeviceInput,
	constantTimeEqualTokenHash,
	normalizeConnectorDeviceCreate,
	normalizeConnectorDeviceTokenHash,
	normalizeRotationExpiry,
	toConnectorDeviceSummary,
} from "../repositories/connector-devices";

/**
 * Offline twin of `PostgresConnectorDeviceRepository`. Same contract and the
 * same pure normalizers: tenant-scoped reads, summaries without the token
 * hash, globally unique token hashes and per-tenant unique display names.
 */
export class InMemoryConnectorDeviceRepository
	implements ConnectorDeviceRepository
{
	private readonly rows = new Map<string, ConnectorDeviceRecord>();

	async create(
		input: CreateConnectorDeviceInput,
	): Promise<ConnectorDeviceSummary> {
		const normalized = normalizeConnectorDeviceCreate(input);
		for (const row of this.rows.values()) {
			if (
				row.organizationId === normalized.organizationId &&
				row.displayName === normalized.displayName
			) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"a connector device with this display name already exists",
				);
			}
			if (row.tokenHash === normalized.tokenHash) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"this connector device token is already registered",
				);
			}
		}
		const now = new Date();
		const record: ConnectorDeviceRecord = {
			id: crypto.randomUUID(),
			organizationId: normalized.organizationId,
			userId: normalized.userId,
			displayName: normalized.displayName,
			tokenHash: normalized.tokenHash,
			status: normalized.status,
			lastSeenAt: null,
			expiresAt: normalized.expiresAt,
			createdAt: now,
			updatedAt: now,
		};
		this.rows.set(record.id, record);
		return toConnectorDeviceSummary(record);
	}

	async verifyByTokenHash(
		organizationId: OrganizationId,
		tokenHash: string,
	): Promise<ConnectorDeviceSummary | null> {
		const hash = normalizeConnectorDeviceTokenHash(tokenHash);
		for (const row of this.rows.values()) {
			if (
				row.organizationId === organizationId &&
				row.status === "active" &&
				(row.expiresAt === null || row.expiresAt.getTime() > Date.now()) &&
				constantTimeEqualTokenHash(hash, row.tokenHash)
			) {
				return toConnectorDeviceSummary(row);
			}
		}
		return null;
	}

	async touchSeen(
		organizationId: OrganizationId,
		deviceId: string,
		seenAt?: Date,
	): Promise<ConnectorDeviceSummary | null> {
		const row = this.rows.get(deviceId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		const at = seenAt ?? new Date();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "seenAt is invalid");
		}
		row.lastSeenAt = new Date(at.getTime());
		row.updatedAt = new Date();
		return toConnectorDeviceSummary(row);
	}

	async revoke(
		organizationId: OrganizationId,
		deviceId: string,
	): Promise<ConnectorDeviceSummary | null> {
		const row = this.rows.get(deviceId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		row.status = "revoked";
		row.updatedAt = new Date();
		return toConnectorDeviceSummary(row);
	}

	async rotateToken(
		organizationId: OrganizationId,
		deviceId: string,
		tokenHash: string,
		expiresAt: Date,
	): Promise<ConnectorDeviceSummary | null> {
		const hash = normalizeConnectorDeviceTokenHash(tokenHash);
		const expiry = normalizeRotationExpiry(expiresAt);
		const row = this.rows.get(deviceId);
		if (
			row === undefined ||
			row.organizationId !== organizationId ||
			row.status === "revoked"
		) {
			return null;
		}
		// Mirrors the global unique index on `token_hash`.
		for (const other of this.rows.values()) {
			if (other.id !== row.id && other.tokenHash === hash) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"this connector device token is already registered",
				);
			}
		}
		row.tokenHash = hash;
		row.expiresAt = expiry;
		row.status = "active";
		row.updatedAt = new Date();
		return toConnectorDeviceSummary(row);
	}

	async listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorDeviceSummary[]> {
		return [...this.rows.values()]
			.filter((row) => row.organizationId === organizationId)
			.sort((left, right) => {
				const byName = left.displayName.localeCompare(right.displayName);
				return byName !== 0 ? byName : left.id.localeCompare(right.id);
			})
			.map((row) => toConnectorDeviceSummary(row));
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
