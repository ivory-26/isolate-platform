import type { OrganizationId } from "@isolate/shared";
import {
	type ConnectorUsageLedgerRepository,
	type ConnectorUsageLedgerRow,
	type ConsumeConnectorUsageOptions,
	type ConsumeConnectorUsageResult,
	normalizeConsumeOptions,
	requireUsagePeriod,
} from "../repositories/connector-usage-ledger";

/**
 * Offline twin of `PostgresConnectorUsageLedgerRepository`.
 *
 * Consumption runs in one synchronous read-modify-write with no `await`
 * between the check and the increment, so concurrent callers (Promise.all)
 * observe the same serialized behavior as the SQL `ON CONFLICT` statement and
 * can never pass the limit.
 *
 * The credential identity join mirrors `INSERT ... SELECT` in the driver: an
 * unknown credential selects no row and consumes nothing.
 */
export type ConnectorCredentialIdentity = {
	organizationId: OrganizationId;
	connectorId: string;
};

export interface ConnectorCredentialIdentitySource {
	identityOf(credentialId: string): ConnectorCredentialIdentity | null;
}

type StoredRow = ConnectorUsageLedgerRow;

function keyOf(credentialId: string, period: string): string {
	return `${credentialId}:${period}`;
}

export class InMemoryConnectorUsageLedger
	implements ConnectorUsageLedgerRepository
{
	private readonly rows = new Map<string, StoredRow>();

	constructor(
		private readonly credentials: ConnectorCredentialIdentitySource | null = null,
	) {}

	async consume(
		credentialId: string,
		options: ConsumeConnectorUsageOptions,
	): Promise<ConsumeConnectorUsageResult> {
		const normalized = normalizeConsumeOptions(options);
		const key = keyOf(credentialId, normalized.period);
		const existing = this.rows.get(key);
		const identity = this.credentials?.identityOf(credentialId) ?? null;
		if (identity === null) {
			return {
				consumed: false,
				requestCount: existing?.requestCount ?? 0,
			};
		}
		if (
			existing !== undefined &&
			existing.requestCount >= normalized.limitPerPeriod
		) {
			return { consumed: false, requestCount: existing.requestCount };
		}
		const next: StoredRow =
			existing === undefined
				? {
						id: crypto.randomUUID(),
						organizationId: identity.organizationId,
						credentialId,
						connectorId: identity.connectorId,
						period: normalized.period,
						requestCount: 1,
						errorCount: 0,
						updatedAt: new Date(),
					}
				: {
						...existing,
						requestCount: existing.requestCount + 1,
						updatedAt: new Date(),
					};
		this.rows.set(key, next);
		return { consumed: true, requestCount: next.requestCount };
	}

	async get(
		credentialId: string,
		period: string,
	): Promise<ConnectorUsageLedgerRow | null> {
		const row = this.rows.get(keyOf(credentialId, requireUsagePeriod(period)));
		return row === undefined
			? null
			: { ...row, updatedAt: new Date(row.updatedAt) };
	}

	/** Test-only visibility; never part of the ledger contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
