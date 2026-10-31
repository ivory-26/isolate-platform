import type {
	ConnectorCredentialStatus,
	ConnectorCredentialSummary,
} from "@isolate/shared";
import { type OrganizationId, PlatformError } from "@isolate/shared";
import {
	type ConnectorCredentialCiphertext,
	type ConnectorCredentialRecord,
	type ConnectorCredentialRepository,
	type CreateConnectorCredentialInput,
	normalizeConnectorCredentialCreate,
	type StoredConnectorCredentialSecret,
	toConnectorCredentialSummary,
} from "../repositories/connector-credentials";

/**
 * Offline twin of `PostgresConnectorCredentialRepository`. Same contract and
 * the same pure normalizers: tenant-scoped reads, summaries without
 * ciphertext, ciphertext only through `getSecret`, and revocation zeroing both
 * bytea columns while keeping the row.
 */
type StoredRow = {
	record: ConnectorCredentialRecord;
	encryptedPayload: Uint8Array;
	wrappedDek: Uint8Array;
};

function copyBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

export class InMemoryConnectorCredentialRepository
	implements ConnectorCredentialRepository
{
	private readonly rows = new Map<string, StoredRow>();

	async create(
		input: CreateConnectorCredentialInput,
	): Promise<ConnectorCredentialSummary> {
		const normalized = normalizeConnectorCredentialCreate(input);
		const duplicate = [...this.rows.values()].some(
			(row) =>
				row.record.organizationId === normalized.organizationId &&
				row.record.connectorId === normalized.connectorId &&
				row.record.displayName === normalized.displayName,
		);
		if (duplicate) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"a connector credential with this display name already exists",
			);
		}
		const now = new Date();
		const record: ConnectorCredentialRecord = {
			id: crypto.randomUUID(),
			organizationId: normalized.organizationId,
			connectorId: normalized.connectorId,
			displayName: normalized.displayName,
			authKind: normalized.authKind,
			scopes: [...normalized.scopes],
			status: normalized.status,
			freeTierProfile: { ...normalized.freeTierProfile },
			metadata: { ...normalized.metadata },
			keyVersion: normalized.keyVersion,
			lastValidatedAt: null,
			lastUsedAt: null,
			createdBy: normalized.createdBy,
			createdAt: now,
			updatedAt: now,
		};
		const stored: StoredRow = {
			record,
			encryptedPayload: copyBytes(normalized.encryptedPayload),
			wrappedDek: copyBytes(normalized.wrappedDek),
		};
		this.rows.set(record.id, stored);
		return toConnectorCredentialSummary(record);
	}

	async listByOrganization(
		organizationId: OrganizationId,
	): Promise<ConnectorCredentialSummary[]> {
		return [...this.rows.values()]
			.filter((row) => row.record.organizationId === organizationId)
			.sort((left, right) => {
				const byConnector = left.record.connectorId.localeCompare(
					right.record.connectorId,
				);
				if (byConnector !== 0) return byConnector;
				const byName = left.record.displayName.localeCompare(
					right.record.displayName,
				);
				if (byName !== 0) return byName;
				return left.record.id.localeCompare(right.record.id);
			})
			.map((row) => toConnectorCredentialSummary(row.record));
	}

	async get(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return null;
		}
		return toConnectorCredentialSummary(row.record);
	}

	async setStatus(
		organizationId: OrganizationId,
		credentialId: string,
		status: ConnectorCredentialStatus,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return null;
		}
		row.record.status = status;
		row.record.updatedAt = new Date();
		return toConnectorCredentialSummary(row.record);
	}

	async touchValidated(
		organizationId: OrganizationId,
		credentialId: string,
		validatedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return null;
		}
		const at = validatedAt ?? new Date();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "validatedAt is invalid");
		}
		row.record.lastValidatedAt = new Date(at.getTime());
		row.record.updatedAt = new Date();
		return toConnectorCredentialSummary(row.record);
	}

	async touchUsed(
		organizationId: OrganizationId,
		credentialId: string,
		usedAt?: Date,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return null;
		}
		const at = usedAt ?? new Date();
		if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "usedAt is invalid");
		}
		row.record.lastUsedAt = new Date(at.getTime());
		row.record.updatedAt = new Date();
		return toConnectorCredentialSummary(row.record);
	}

	async revoke(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<ConnectorCredentialSummary | null> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return null;
		}
		row.record.status = "revoked";
		row.encryptedPayload = new Uint8Array(0);
		row.wrappedDek = new Uint8Array(0);
		row.record.updatedAt = new Date();
		return toConnectorCredentialSummary(row.record);
	}

	async delete(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<boolean> {
		const row = this.rows.get(credentialId);
		if (row === undefined || row.record.organizationId !== organizationId) {
			return false;
		}
		return this.rows.delete(credentialId);
	}

	async getSecret(
		organizationId: OrganizationId,
		credentialId: string,
	): Promise<StoredConnectorCredentialSecret | null> {
		const row = this.rows.get(credentialId);
		if (
			row === undefined ||
			row.record.organizationId !== organizationId ||
			row.record.status === "revoked" ||
			row.encryptedPayload.byteLength === 0 ||
			row.wrappedDek.byteLength === 0
		) {
			return null;
		}
		return {
			credential: toConnectorCredentialSummary(row.record),
			encryptedPayload: copyBytes(row.encryptedPayload),
			wrappedDek: copyBytes(row.wrappedDek),
			keyVersion: row.record.keyVersion,
		};
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
					organizationId: row.record.organizationId,
					connectorId: row.record.connectorId,
				};
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}

	/** Test-only ciphertext accessor to prove revocation cleared the bytes. */
	ciphertextOf(credentialId: string): ConnectorCredentialCiphertext | null {
		const row = this.rows.get(credentialId);
		return row === undefined
			? null
			: {
					encryptedPayload: copyBytes(row.encryptedPayload),
					wrappedDek: copyBytes(row.wrappedDek),
					keyVersion: row.record.keyVersion,
				};
	}
}
