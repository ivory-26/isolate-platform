import type {
	ConnectorCredentialStatus,
	ConnectorCredentialSummary,
} from "@isolate/shared";
import { type OrganizationId, PlatformError } from "@isolate/shared";
import {
	type ConnectorCredentialRecord,
	type ConnectorCredentialRepository,
	type CreateConnectorCredentialInput,
	normalizeConnectorCredentialCreate,
	toConnectorCredentialSummary,
} from "../repositories/connector-credentials";

/**
 * Offline twin of `PostgresConnectorCredentialRepository`. Same contract and
 * the same pure normalizers: tenant-scoped reads, metadata-only summaries and
 * no secret path at all. Revocation flips status and keeps the row; there is
 * nothing to zero because the secret never reaches this layer.
 */
export class InMemoryConnectorCredentialRepository
	implements ConnectorCredentialRepository
{
	private readonly rows = new Map<string, ConnectorCredentialRecord>();

	async create(
		input: CreateConnectorCredentialInput,
	): Promise<ConnectorCredentialSummary> {
		const normalized = normalizeConnectorCredentialCreate(input);
		for (const row of this.rows.values()) {
			if (
				row.organizationId === normalized.organizationId &&
				row.connectorId === normalized.connectorId &&
				row.displayName === normalized.displayName
			) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"a connector credential with this display name already exists",
				);
			}
			if (
				row.deviceId === normalized.deviceId &&
				row.connectorId === normalized.connectorId &&
				row.credentialRef === normalized.credentialRef
			) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"this credential ref is already registered for the device",
				);
			}
		}
		const record: ConnectorCredentialRecord = {
			id: crypto.randomUUID(),
			organizationId: normalized.organizationId,
			deviceId: normalized.deviceId,
			connectorId: normalized.connectorId,
			displayName: normalized.displayName,
			authKind: normalized.authKind,
			credentialRef: normalized.credentialRef,
			scopes: [...normalized.scopes],
			status: normalized.status,
			freeTierProfile: { ...normalized.freeTierProfile },
			metadata: { ...normalized.metadata },
			lastValidatedAt: null,
			lastUsedAt: null,
		};
		this.rows.set(record.id, record);
		return toConnectorCredentialSummary(record);
	}

	async listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]> {
		return [...this.rows.values()]
			.filter((row) => row.organizationId === organizationId)
			.sort((left, right) => {
				const byConnector = left.connectorId.localeCompare(right.connectorId);
				if (byConnector !== 0) return byConnector;
				const byName = left.displayName.localeCompare(right.displayName);
				if (byName !== 0) return byName;
				return left.id.localeCompare(right.id);
			})
			.map((row) => toConnectorCredentialSummary(row));
	}

	async get(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		return toConnectorCredentialSummary(row);
	}

	async setStatus(
		organizationId: OrganizationId,
		credentialId: string,
		status: ConnectorCredentialStatus,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		row.status = status;
		return toConnectorCredentialSummary(row);
	}

	async touchValidated(
		organizationId: OrganizationId,
		credentialId: string,
		validatedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		const at = validatedAt ?? new Date();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "validatedAt is invalid");
		}
		row.lastValidatedAt = new Date(at.getTime());
		return toConnectorCredentialSummary(row);
	}

	async touchUsed(
		organizationId: OrganizationId,
		credentialId: string,
		usedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		const at = usedAt ?? new Date();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "usedAt is invalid");
		}
		row.lastUsedAt = new Date(at.getTime());
		return toConnectorCredentialSummary(row);
	}

	async revoke(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return null;
		}
		row.status = "revoked";
		return toConnectorCredentialSummary(row);
	}

	async delete(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<boolean> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.organizationId !== organizationId) {
			return false;
		}
		return this.rows.delete(credentialId);
	}

	/**
	 * Testing-only identity lookup for the usage-ledger fake; it mirrors the
	 * `INSERT ... SELECT` join the Postgres consume statement performs.
	 */
	identityOf(credentialId: string): {
		organizationId: OrganizationId;
		connectorId: string;
	} | null {
		const row = this.rows.get(credentialId);
		return row === undefined
			? null
			: {
					organizationId: row.organizationId,
					connectorId: row.connectorId,
				};
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
