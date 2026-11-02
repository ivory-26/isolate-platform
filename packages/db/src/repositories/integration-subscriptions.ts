import {
	type AutonomyLevel,
	connectorDisplayNameSchema,
	INCIDENT_SEVERITIES,
	type IncidentSeverity,
	type IntegrationConnectorId,
	type IntegrationSubscriptionInput,
	integrationSubscriptionInputSchema,
	type OrganizationId,
	PlatformError,
	type RepositoryId,
	type UserId,
} from "@isolate/shared";
import { type PgSql, parseJsonbColumn } from "../client";
import type { IntegrationSubscriptionRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Tenant-scoped integration trigger rules (wave 23, migration 0016).
 *
 * A subscription maps one connector's events to at most one repository/base
 * branch and one autonomy level. It carries metadata only: no provider
 * credential, token or webhook secret. All bounds come from the shared
 * `integrationSubscriptionInputSchema`, shared by the driver and the fake, so
 * the two cannot drift.
 */

export const MAX_MATCHING_SUBSCRIPTIONS = 64;

const SUBSCRIPTION_COLUMNS =
	"id, organization_id, connector_id, display_name, event_kinds, environment_allowlist, min_severity, repository_id, base_branch, autonomy_level, enabled, config, created_by, created_at, updated_at";

export type CreateIntegrationSubscriptionInput =
	IntegrationSubscriptionInput & {
		readonly organizationId: OrganizationId;
		readonly createdBy?: UserId | null;
	};

export type NormalizedSubscriptionRecord = {
	organizationId: OrganizationId;
	connectorId: IntegrationConnectorId;
	displayName: string;
	eventKinds: string[];
	environmentAllowlist: string[];
	minSeverity: IncidentSeverity;
	repositoryId: RepositoryId | null;
	baseBranch: string | null;
	autonomyLevel: AutonomyLevel;
	enabled: boolean;
	config: Record<string, unknown>;
	createdBy: UserId | null;
};

export type UpdateIntegrationSubscriptionInput = {
	readonly organizationId: OrganizationId;
	readonly id: string;
	readonly displayName?: string;
	readonly eventKinds?: readonly string[];
	readonly environmentAllowlist?: readonly string[];
	readonly minSeverity?: IncidentSeverity;
	readonly repositoryId?: RepositoryId | null;
	readonly baseBranch?: string | null;
	readonly autonomyLevel?: AutonomyLevel;
	readonly enabled?: boolean;
	readonly config?: Record<string, unknown>;
};

export type IntegrationEventMatch = {
	readonly connectorId: IntegrationConnectorId;
	readonly eventKind: string;
	readonly severity: IncidentSeverity;
	/** Deployment environment; an unknown environment matches nothing default. */
	readonly environment: string;
};

export interface IntegrationSubscriptionRepository {
	list(
		organizationId: OrganizationId,
		connectorId?: IntegrationConnectorId,
	): Promise<IntegrationSubscriptionRow[]>;
	create(
		input: CreateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow>;
	update(
		input: UpdateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow | null>;
	setEnabled(
		organizationId: OrganizationId,
		id: string,
		enabled: boolean,
	): Promise<IntegrationSubscriptionRow | null>;
	/** true when the row belonged to this tenant and was deleted. */
	delete(organizationId: OrganizationId, id: string): Promise<boolean>;
	findMatchingForEvent(
		input: IntegrationEventMatch & { organizationId: OrganizationId },
	): Promise<IntegrationSubscriptionRow[]>;
}

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

/** Severity rank: info=0 … critical=4; unknown values are a boundary error. */
export function severityRank(severity: IncidentSeverity): number {
	const index = INCIDENT_SEVERITIES.indexOf(severity);
	if (index < 0) throw validationError("severity is invalid");
	return INCIDENT_SEVERITIES.length - 1 - index;
}

/** True when an event's severity meets the rule's minimum. */
export function severityAtLeast(
	eventSeverity: IncidentSeverity,
	minSeverity: IncidentSeverity,
): boolean {
	return severityRank(eventSeverity) >= severityRank(minSeverity);
}

export function normalizeCreateSubscriptionInput(
	input: CreateIntegrationSubscriptionInput,
): NormalizedSubscriptionRecord {
	requireNonEmpty(input.organizationId, "organizationId");
	const parsed = integrationSubscriptionInputSchema.safeParse({
		connectorId: input.connectorId,
		displayName: input.displayName,
		eventKinds: input.eventKinds,
		environmentAllowlist: input.environmentAllowlist,
		minSeverity: input.minSeverity,
		repositoryId: input.repositoryId,
		baseBranch: input.baseBranch,
		autonomyLevel: input.autonomyLevel,
		enabled: input.enabled,
		config: input.config,
	});
	if (!parsed.success) {
		throw validationError("integration subscription input is invalid");
	}
	const createdBy = input.createdBy ?? null;
	if (createdBy !== null) requireNonEmpty(createdBy, "createdBy");
	return {
		organizationId: input.organizationId,
		connectorId: parsed.data.connectorId,
		displayName: parsed.data.displayName,
		eventKinds: [...parsed.data.eventKinds],
		environmentAllowlist: [...parsed.data.environmentAllowlist],
		minSeverity: parsed.data.minSeverity,
		repositoryId: parsed.data.repositoryId as RepositoryId | null,
		baseBranch: parsed.data.baseBranch,
		autonomyLevel: parsed.data.autonomyLevel,
		enabled: parsed.data.enabled,
		config: { ...parsed.data.config },
		createdBy,
	};
}

/** Validates a merged create/update candidate; shared with the in-memory fake. */
export function normalizeSubscriptionCandidate(input: {
	organizationId: OrganizationId;
	connectorId: IntegrationConnectorId;
	displayName: string;
	eventKinds: readonly string[];
	environmentAllowlist: readonly string[];
	minSeverity: IncidentSeverity;
	repositoryId: RepositoryId | null;
	baseBranch: string | null;
	autonomyLevel: AutonomyLevel;
	enabled: boolean;
	config: Record<string, unknown>;
	createdBy: UserId | null;
}): NormalizedSubscriptionRecord {
	return normalizeCreateSubscriptionInput({
		organizationId: input.organizationId,
		connectorId: input.connectorId,
		displayName: input.displayName,
		eventKinds: [...input.eventKinds],
		environmentAllowlist: [...input.environmentAllowlist],
		minSeverity: input.minSeverity,
		repositoryId: input.repositoryId,
		baseBranch: input.baseBranch,
		autonomyLevel: input.autonomyLevel,
		enabled: input.enabled,
		config: input.config,
		createdBy: input.createdBy,
	});
}

/**
 * Pure trigger match used by the fake and by read-model callers. The Postgres
 * statement mirrors these three conditions exactly.
 */
export function subscriptionMatchesEvent(
	row: Pick<
		IntegrationSubscriptionRow,
		| "connector_id"
		| "enabled"
		| "event_kinds"
		| "environment_allowlist"
		| "min_severity"
	>,
	event: IntegrationEventMatch,
): boolean {
	if (!row.enabled) return false;
	if (row.connector_id !== event.connectorId) return false;
	if (
		row.event_kinds.length > 0 &&
		!row.event_kinds.includes(event.eventKind)
	) {
		return false;
	}
	if (!row.environment_allowlist.includes(event.environment)) return false;
	return severityAtLeast(event.severity, row.min_severity);
}

export function mapIntegrationSubscriptionRow(
	row: Record<string, unknown>,
): IntegrationSubscriptionRow {
	const config = parseJsonbColumn<Record<string, unknown>>(row.config);
	return {
		id: String(row.id),
		organization_id: row.organization_id as OrganizationId,
		connector_id: row.connector_id as IntegrationConnectorId,
		display_name: String(row.display_name),
		event_kinds: (row.event_kinds as string[] | null) ?? [],
		environment_allowlist: (row.environment_allowlist as string[] | null) ?? [],
		min_severity: row.min_severity as IncidentSeverity,
		repository_id:
			row.repository_id === null || row.repository_id === undefined
				? null
				: (String(row.repository_id) as RepositoryId),
		base_branch:
			row.base_branch === null || row.base_branch === undefined
				? null
				: String(row.base_branch),
		autonomy_level: row.autonomy_level as AutonomyLevel,
		enabled: row.enabled === true || row.enabled === "true",
		config: config ?? {},
		created_by:
			row.created_by === null || row.created_by === undefined
				? null
				: (String(row.created_by) as UserId),
		created_at: row.created_at as Date,
		updated_at: row.updated_at as Date,
	};
}

const STMT = {
	insert: `INSERT INTO integration_subscriptions (
		organization_id, connector_id, display_name, event_kinds,
		environment_allowlist, min_severity, repository_id, base_branch,
		autonomy_level, enabled, config, created_by
	) VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10,
		$11::text::jsonb, $12)
	ON CONFLICT (organization_id, connector_id, display_name) DO NOTHING
	RETURNING ${SUBSCRIPTION_COLUMNS}`,
	list: `SELECT ${SUBSCRIPTION_COLUMNS} FROM integration_subscriptions
		WHERE organization_id = $1
		  AND ($2::text IS NULL OR connector_id = $2)
		ORDER BY created_at ASC, id ASC`,
	update: `UPDATE integration_subscriptions SET
		display_name = $3, event_kinds = $4::text[],
		environment_allowlist = $5::text[], min_severity = $6,
		repository_id = $7, base_branch = $8, autonomy_level = $9,
		enabled = $10, config = $11::text::jsonb, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUBSCRIPTION_COLUMNS}`,
	setEnabled: `UPDATE integration_subscriptions
		SET enabled = $3, updated_at = now()
		WHERE organization_id = $1 AND id = $2
		RETURNING ${SUBSCRIPTION_COLUMNS}`,
	delete: `DELETE FROM integration_subscriptions
		WHERE organization_id = $1 AND id = $2
		RETURNING id`,
	// The ORDER BY/severity rank mirrors `subscriptionMatchesEvent`.
	matching: `SELECT ${SUBSCRIPTION_COLUMNS} FROM integration_subscriptions
		WHERE organization_id = $1
		  AND connector_id = $2
		  AND enabled = true
		  AND (cardinality(event_kinds) = 0 OR $3 = ANY(event_kinds))
		  AND $4 = ANY(environment_allowlist)
		  AND array_position(ARRAY['info','low','medium','high','critical'], min_severity) - 1 <= $5
		ORDER BY created_at ASC, id ASC
		LIMIT ${MAX_MATCHING_SUBSCRIPTIONS}`,
} as const;

export class PostgresIntegrationSubscriptionRepository
	implements IntegrationSubscriptionRepository
{
	constructor(private readonly sql: PgSql) {}

	async list(
		organizationId: OrganizationId,
		connectorId?: IntegrationConnectorId,
	): Promise<IntegrationSubscriptionRow[]> {
		requireNonEmpty(organizationId, "organizationId");
		const rows = (await this.sql.unsafe(STMT.list, [
			organizationId,
			connectorId ?? null,
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapIntegrationSubscriptionRow);
	}

	async create(
		input: CreateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow> {
		const normalized = normalizeCreateSubscriptionInput(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.connectorId,
			normalized.displayName,
			normalized.eventKinds,
			normalized.environmentAllowlist,
			normalized.minSeverity,
			normalized.repositoryId,
			normalized.baseBranch,
			normalized.autonomyLevel,
			normalized.enabled,
			JSON.stringify(normalized.config),
			normalized.createdBy,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"an integration subscription with this name already exists",
			);
		}
		return mapIntegrationSubscriptionRow(rows[0]);
	}

	async update(
		input: UpdateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.id, "id");
		const existing = await this.findById(input.organizationId, input.id);
		if (existing === null) return null;
		if (input.displayName !== undefined) {
			const parsed = connectorDisplayNameSchema.safeParse(input.displayName);
			if (!parsed.success) {
				throw validationError("displayName is invalid");
			}
		}
		const normalized = normalizeSubscriptionCandidate({
			organizationId: existing.organization_id,
			connectorId: existing.connector_id,
			displayName: input.displayName ?? existing.display_name,
			eventKinds: input.eventKinds ?? existing.event_kinds,
			environmentAllowlist:
				input.environmentAllowlist ?? existing.environment_allowlist,
			minSeverity: input.minSeverity ?? existing.min_severity,
			repositoryId:
				input.repositoryId === undefined
					? existing.repository_id
					: input.repositoryId,
			baseBranch:
				input.baseBranch === undefined
					? existing.base_branch
					: input.baseBranch,
			autonomyLevel: input.autonomyLevel ?? existing.autonomy_level,
			enabled: input.enabled ?? existing.enabled,
			config: input.config ?? existing.config,
			createdBy: existing.created_by,
		});
		const rows = (await this.sql.unsafe(STMT.update, [
			normalized.organizationId,
			input.id,
			normalized.displayName,
			normalized.eventKinds,
			normalized.environmentAllowlist,
			normalized.minSeverity,
			normalized.repositoryId,
			normalized.baseBranch,
			normalized.autonomyLevel,
			normalized.enabled,
			JSON.stringify(normalized.config),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapIntegrationSubscriptionRow(rows[0]);
	}

	async setEnabled(
		organizationId: OrganizationId,
		id: string,
		enabled: boolean,
	): Promise<IntegrationSubscriptionRow | null> {
		requireNonEmpty(organizationId, "organizationId");
		requireNonEmpty(id, "id");
		if (typeof enabled !== "boolean") {
			throw validationError("enabled must be a boolean");
		}
		const rows = (await this.sql.unsafe(STMT.setEnabled, [
			organizationId,
			id,
			enabled,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapIntegrationSubscriptionRow(rows[0]);
	}

	async delete(organizationId: OrganizationId, id: string): Promise<boolean> {
		requireNonEmpty(organizationId, "organizationId");
		requireNonEmpty(id, "id");
		const rows = (await this.sql.unsafe(STMT.delete, [
			organizationId,
			id,
		])) as unknown as Record<string, unknown>[];
		return rows.length > 0;
	}

	async findMatchingForEvent(
		input: IntegrationEventMatch & { organizationId: OrganizationId },
	): Promise<IntegrationSubscriptionRow[]> {
		requireNonEmpty(input.organizationId, "organizationId");
		if (typeof input.eventKind !== "string" || input.eventKind.length === 0) {
			throw validationError("eventKind is required");
		}
		if (
			typeof input.environment !== "string" ||
			input.environment.length === 0
		) {
			throw validationError("environment is required");
		}
		const rows = (await this.sql.unsafe(STMT.matching, [
			input.organizationId,
			input.connectorId,
			input.eventKind,
			input.environment,
			severityRank(input.severity),
		])) as unknown as Record<string, unknown>[];
		return rows.map(mapIntegrationSubscriptionRow);
	}

	private async findById(
		organizationId: OrganizationId,
		id: string,
	): Promise<IntegrationSubscriptionRow | null> {
		const rows = (await this.sql.unsafe(
			`SELECT ${SUBSCRIPTION_COLUMNS} FROM integration_subscriptions
			 WHERE organization_id = $1 AND id = $2`,
			[organizationId, id],
		)) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapIntegrationSubscriptionRow(rows[0]);
	}
}
