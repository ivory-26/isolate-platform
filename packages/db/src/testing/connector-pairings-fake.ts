import type { OrganizationId } from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import {
	type ConnectorPairingRecord,
	type ConnectorPairingRepository,
	type ConnectorPairingSummary,
	type CreateConnectorPairingInput,
	normalizeConnectorPairingCodeHash,
	normalizeConnectorPairingCreate,
	toConnectorPairingSummary,
} from "../repositories/connector-pairings";

/**
 * Offline twin of `PostgresConnectorPairingRepository`. Same contract and the
 * same pure normalizers: tenant-scoped reads, summaries without the code hash,
 * a one-shot atomic claim and conditional complete/cancel/expire transitions.
 */
export class InMemoryConnectorPairingRepository
	implements ConnectorPairingRepository
{
	private readonly rows = new Map<string, ConnectorPairingRecord>();

	async create(
		input: CreateConnectorPairingInput,
	): Promise<ConnectorPairingSummary> {
		const normalized = normalizeConnectorPairingCreate(input);
		for (const row of this.rows.values()) {
			if (row.codeHash === normalized.codeHash) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"this pairing code is already registered",
				);
			}
		}
		const now = new Date();
		const record: ConnectorPairingRecord = {
			id: crypto.randomUUID(),
			organizationId: normalized.organizationId,
			deviceId: normalized.deviceId,
			connectorId: normalized.connectorId,
			displayName: normalized.displayName,
			authKind: normalized.authKind,
			credentialRef: normalized.credentialRef,
			scopes: [...normalized.scopes],
			metadata: { ...normalized.metadata },
			codeHash: normalized.codeHash,
			status: "pending",
			createdBy: normalized.createdBy,
			expiresAt: new Date(normalized.expiresAt),
			claimedAt: null,
			completedAt: null,
			createdAt: now,
			updatedAt: now,
		};
		this.rows.set(record.id, record);
		return toConnectorPairingSummary(record);
	}

	async get(
		organizationId: OrganizationId,
		pairingId: string,
	): Promise<ConnectorPairingSummary | null> {
		const row = this.rows.get(pairingId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		return toConnectorPairingSummary(row);
	}

	async findByOrganization(
		organizationId: OrganizationId,
		limit = 50,
	): Promise<ConnectorPairingSummary[]> {
		const bounded = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
		return [...this.rows.values()]
			.filter((row) => row.organizationId === organizationId)
			.sort((left, right) => {
				const byCreated = right.createdAt.getTime() - left.createdAt.getTime();
				return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
			})
			.slice(0, Math.min(bounded, 100))
			.map((row) => toConnectorPairingSummary(row));
	}

	async claimByCodeHash(
		organizationId: OrganizationId,
		deviceId: string,
		codeHash: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const hash = normalizeConnectorPairingCodeHash(codeHash);
		for (const row of this.rows.values()) {
			if (
				row.organizationId === organizationId &&
				row.deviceId === deviceId &&
				row.codeHash === hash &&
				row.status === "pending" &&
				row.expiresAt.getTime() > now.getTime()
			) {
				row.status = "claimed";
				row.claimedAt = new Date(now.getTime());
				row.updatedAt = new Date(now.getTime());
				return toConnectorPairingSummary(row);
			}
		}
		return null;
	}

	async complete(
		organizationId: OrganizationId,
		pairingId: string,
		metadata: Record<string, unknown> = {},
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const row = this.rows.get(pairingId);
		if (
			row === undefined ||
			row.organizationId !== organizationId ||
			row.status !== "claimed"
		) {
			return null;
		}
		row.status = "completed";
		row.completedAt = new Date(now.getTime());
		row.metadata = { ...row.metadata, ...metadata };
		row.updatedAt = new Date(now.getTime());
		return toConnectorPairingSummary(row);
	}

	async cancel(
		organizationId: OrganizationId,
		pairingId: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const row = this.rows.get(pairingId);
		if (
			row === undefined ||
			row.organizationId !== organizationId ||
			(row.status !== "pending" && row.status !== "claimed")
		) {
			return null;
		}
		row.status = "cancelled";
		row.updatedAt = new Date(now.getTime());
		return toConnectorPairingSummary(row);
	}

	async expire(
		organizationId: OrganizationId,
		pairingId: string,
		now: Date = new Date(),
	): Promise<ConnectorPairingSummary | null> {
		const row = this.rows.get(pairingId);
		if (
			row === undefined ||
			row.organizationId !== organizationId ||
			(row.status !== "pending" && row.status !== "claimed") ||
			row.expiresAt.getTime() > now.getTime()
		) {
			return null;
		}
		row.status = "expired";
		row.updatedAt = new Date(now.getTime());
		return toConnectorPairingSummary(row);
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
