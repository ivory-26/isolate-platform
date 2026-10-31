import type { OrganizationId } from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * Durable free-tier ledger (migration 0010).
 *
 * `consume` is one SQL statement: the INSERT seeds the period row and the
 * `ON CONFLICT ... DO UPDATE ... WHERE request_count < limit` arm increments
 * only while headroom remains. Two concurrent calls therefore serialize on
 * the unique `(credential_id, period)` row and the (limit + 1)th call returns
 * no row — the limit is never exceeded in application memory.
 *
 * A period is a UTC calendar date (`YYYY-MM-DD`); the caller derives it from
 * the credential's verified free-tier profile.
 */

const PERIOD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CREDENTIAL_ID_CHARS = 128;

export type ConsumeConnectorUsageOptions = {
	/** Calls allowed in the period; the platform guard, not the provider limit. */
	limitPerPeriod: number;
	/** UTC calendar date, `YYYY-MM-DD`. */
	period: string;
};

export type ConsumeConnectorUsageResult = {
	consumed: boolean;
	/** Resulting count when consumed, current count when refused. */
	requestCount: number;
};

export type ConnectorUsageLedgerRow = {
	id: string;
	organizationId: OrganizationId;
	credentialId: string;
	connectorId: string;
	period: string;
	requestCount: number;
	errorCount: number;
	updatedAt: Date;
};

export interface ConnectorUsageLedgerRepository {
	consume(
		credentialId: string,
		options: ConsumeConnectorUsageOptions,
	): Promise<ConsumeConnectorUsageResult>;
	get(
		credentialId: string,
		period: string,
	): Promise<ConnectorUsageLedgerRow | null>;
}

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function requireCredentialId(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw validationError("credentialId must be a non-empty string");
	}
	if (value.length > MAX_CREDENTIAL_ID_CHARS) {
		throw validationError("credentialId is too long");
	}
	return value;
}

export function requireUsagePeriod(value: unknown): string {
	if (typeof value !== "string" || !PERIOD_PATTERN.test(value)) {
		throw validationError("period must be a YYYY-MM-DD date");
	}
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(parsed)) {
		throw validationError("period must be a valid calendar date");
	}
	if (new Date(parsed).toISOString().slice(0, 10) !== value) {
		throw validationError("period must be a valid calendar date");
	}
	return value;
}

export function normalizeConsumeOptions(
	options: ConsumeConnectorUsageOptions,
): ConsumeConnectorUsageOptions {
	if (
		!Number.isSafeInteger(options.limitPerPeriod) ||
		options.limitPerPeriod < 1
	) {
		throw validationError("limitPerPeriod must be a positive integer");
	}
	return {
		limitPerPeriod: options.limitPerPeriod,
		period: requireUsagePeriod(options.period),
	};
}

export function mapConnectorUsageLedgerRow(
	row: Record<string, unknown>,
): ConnectorUsageLedgerRow {
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		credentialId: String(row.credential_id),
		connectorId: String(row.connector_id),
		period: String(row.period).slice(0, 10),
		requestCount: Number(row.request_count),
		errorCount: Number(row.error_count),
		updatedAt:
			row.updated_at instanceof Date
				? new Date(row.updated_at.getTime())
				: new Date(String(row.updated_at)),
	};
}

const STMT = {
	// Single atomic statement: a missing credential selects no source row, so
	// nothing is inserted and `consumed` is false for that case too.
	consume: `INSERT INTO connector_usage_ledger (
		organization_id, credential_id, connector_id, period,
		request_count, error_count, updated_at
	)
	SELECT cc.organization_id, cc.id, cc.connector_id, $2::date, 1, 0, now()
	FROM connector_credentials cc
	WHERE cc.id = $1
	ON CONFLICT (credential_id, period) DO UPDATE
	SET request_count = connector_usage_ledger.request_count + 1,
		updated_at = now()
	WHERE connector_usage_ledger.request_count < $3::integer
	RETURNING request_count`,
	get: `SELECT id, organization_id, credential_id, connector_id, period,
		request_count, error_count, updated_at
		FROM connector_usage_ledger
		WHERE credential_id = $1 AND period = $2::date`,
} as const;

export class PostgresConnectorUsageLedgerRepository
	implements ConnectorUsageLedgerRepository
{
	constructor(private readonly sql: PgSql) {}

	async consume(
		credentialId: string,
		options: ConsumeConnectorUsageOptions,
	): Promise<ConsumeConnectorUsageResult> {
		const id = requireCredentialId(credentialId);
		const normalized = normalizeConsumeOptions(options);
		const rows = (await this.sql.unsafe(STMT.consume, [
			id,
			normalized.period,
			normalized.limitPerPeriod,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) {
			return { consumed: true, requestCount: Number(rows[0].request_count) };
		}
		const current = await this.get(id, normalized.period);
		return { consumed: false, requestCount: current?.requestCount ?? 0 };
	}

	async get(
		credentialId: string,
		period: string,
	): Promise<ConnectorUsageLedgerRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			requireCredentialId(credentialId),
			requireUsagePeriod(period),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapConnectorUsageLedgerRow(rows[0]);
	}
}
