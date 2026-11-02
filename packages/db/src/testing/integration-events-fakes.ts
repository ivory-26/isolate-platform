import type {
	IntegrationConnectorId,
	OrganizationId,
	RepositoryId,
	UserId,
} from "@isolate/shared";
import {
	type ListInboxDeliveriesInput,
	type ListRecentDeliveriesInput,
	normalizeEventDeliveryInput,
	normalizeEventDeliveryStatusUpdate,
	paginateDeliveries,
	type RecordEventDeliveryInput,
	type RecordEventDeliveryResult,
	type UpdateEventDeliveryStatusInput,
} from "../repositories/event-deliveries";
import {
	type GitHubInstallationRepository,
	normalizeGitHubInstallationInput,
	type UpsertGitHubInstallationInput,
} from "../repositories/github-installations";
import {
	type CreateIntegrationSubscriptionInput,
	type IntegrationEventMatch,
	type IntegrationSubscriptionRepository,
	normalizeCreateSubscriptionInput,
	normalizeSubscriptionCandidate,
	severityRank,
	subscriptionMatchesEvent,
	type UpdateIntegrationSubscriptionInput,
} from "../repositories/integration-subscriptions";
import type {
	EventDeliveryRow,
	GitHubInstallationRow,
	IntegrationSubscriptionRow,
} from "../schema";

/**
 * In-memory twins for the wave-23 event-first tables. Each fake shares the
 * driver's normalizers and pure decision helpers, so bounds, tenant scoping
 * and duplicate-delivery idempotency cannot drift between Postgres and tests.
 */

function newUuid(): string {
	return crypto.randomUUID();
}

export class InMemoryGitHubInstallationRepository
	implements GitHubInstallationRepository
{
	private readonly rows = new Map<string, GitHubInstallationRow>();

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async upsert(
		input: UpsertGitHubInstallationInput,
	): Promise<GitHubInstallationRow | null> {
		const normalized = normalizeGitHubInstallationInput(input);
		const existing = [...this.rows.values()].find(
			(row) => row.installation_id === normalized.installationId,
		);
		if (existing !== undefined) {
			// A different tenant can never take over the numeric installation id.
			if (existing.organization_id !== normalized.organizationId) return null;
			existing.account_login = normalized.accountLogin;
			existing.account_type = normalized.accountType;
			existing.repository_selection = normalized.repositorySelection;
			existing.status = normalized.status;
			existing.updated_at = this.clock();
			return { ...existing };
		}
		const now = this.clock();
		const row: GitHubInstallationRow = {
			id: newUuid(),
			organization_id: normalized.organizationId,
			installation_id: normalized.installationId,
			account_login: normalized.accountLogin,
			account_type: normalized.accountType,
			repository_selection: normalized.repositorySelection,
			status: normalized.status,
			created_by: normalized.createdBy,
			created_at: now,
			updated_at: now,
		};
		this.rows.set(row.id, row);
		return { ...row };
	}

	async findByOrganization(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null> {
		for (const row of this.rows.values()) {
			if (
				row.organization_id === organizationId &&
				row.installation_id === installationId
			) {
				return { ...row };
			}
		}
		return null;
	}

	async findActiveByOrganization(
		organizationId: OrganizationId,
	): Promise<GitHubInstallationRow | null> {
		const active = [...this.rows.values()]
			.filter(
				(row) =>
					row.organization_id === organizationId && row.status === "active",
			)
			.sort((left, right) => {
				const byTime = right.updated_at.getTime() - left.updated_at.getTime();
				return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
			});
		const first = active[0];
		return first === undefined ? null : { ...first };
	}

	async list(organizationId: OrganizationId): Promise<GitHubInstallationRow[]> {
		return [...this.rows.values()]
			.filter((row) => row.organization_id === organizationId)
			.sort((left, right) => {
				const byTime = right.created_at.getTime() - left.created_at.getTime();
				return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
			})
			.map((row) => ({ ...row }));
	}

	async revoke(
		organizationId: OrganizationId,
		installationId: string,
	): Promise<GitHubInstallationRow | null> {
		for (const row of this.rows.values()) {
			if (
				row.organization_id === organizationId &&
				row.installation_id === installationId
			) {
				row.status = "revoked";
				row.updated_at = this.clock();
				return { ...row };
			}
		}
		return null;
	}

	get rowCount(): number {
		return this.rows.size;
	}
}

export class InMemoryIntegrationSubscriptionRepository
	implements IntegrationSubscriptionRepository
{
	private readonly rows = new Map<string, IntegrationSubscriptionRow>();

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async list(
		organizationId: OrganizationId,
		connectorId?: IntegrationConnectorId,
	): Promise<IntegrationSubscriptionRow[]> {
		return [...this.rows.values()]
			.filter(
				(row) =>
					row.organization_id === organizationId &&
					(connectorId === undefined || row.connector_id === connectorId),
			)
			.sort((left, right) => {
				const byTime = left.created_at.getTime() - right.created_at.getTime();
				return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
			})
			.map((row) => ({ ...row, config: { ...row.config } }));
	}

	async create(
		input: CreateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow> {
		const normalized = normalizeCreateSubscriptionInput(input);
		for (const row of this.rows.values()) {
			if (
				row.organization_id === normalized.organizationId &&
				row.connector_id === normalized.connectorId &&
				row.display_name === normalized.displayName
			) {
				throw new Error("integration subscription already exists");
			}
		}
		const now = this.clock();
		const row: IntegrationSubscriptionRow = {
			id: newUuid(),
			organization_id: normalized.organizationId,
			connector_id: normalized.connectorId,
			display_name: normalized.displayName,
			event_kinds: [...normalized.eventKinds],
			environment_allowlist: [...normalized.environmentAllowlist],
			min_severity: normalized.minSeverity,
			repository_id: normalized.repositoryId as RepositoryId | null,
			base_branch: normalized.baseBranch,
			autonomy_level: normalized.autonomyLevel,
			enabled: normalized.enabled,
			config: { ...normalized.config },
			created_by: normalized.createdBy as UserId | null,
			created_at: now,
			updated_at: now,
		};
		this.rows.set(row.id, row);
		return { ...row, config: { ...row.config } };
	}

	async update(
		input: UpdateIntegrationSubscriptionInput,
	): Promise<IntegrationSubscriptionRow | null> {
		const row = this.rows.get(input.id);
		if (row === undefined || row.organization_id !== input.organizationId) {
			return null;
		}
		const normalized = normalizeSubscriptionCandidate({
			organizationId: row.organization_id,
			connectorId: row.connector_id,
			displayName: input.displayName ?? row.display_name,
			eventKinds: input.eventKinds ?? row.event_kinds,
			environmentAllowlist:
				input.environmentAllowlist ?? row.environment_allowlist,
			minSeverity: input.minSeverity ?? row.min_severity,
			repositoryId:
				input.repositoryId === undefined
					? row.repository_id
					: input.repositoryId,
			baseBranch:
				input.baseBranch === undefined ? row.base_branch : input.baseBranch,
			autonomyLevel: input.autonomyLevel ?? row.autonomy_level,
			enabled: input.enabled ?? row.enabled,
			config: input.config ?? row.config,
			createdBy: row.created_by,
		});
		row.display_name = normalized.displayName;
		row.event_kinds = [...normalized.eventKinds];
		row.environment_allowlist = [...normalized.environmentAllowlist];
		row.min_severity = normalized.minSeverity;
		row.repository_id = normalized.repositoryId;
		row.base_branch = normalized.baseBranch;
		row.autonomy_level = normalized.autonomyLevel;
		row.enabled = normalized.enabled;
		row.config = { ...normalized.config };
		row.updated_at = this.clock();
		return { ...row, config: { ...row.config } };
	}

	async setEnabled(
		organizationId: OrganizationId,
		id: string,
		enabled: boolean,
	): Promise<IntegrationSubscriptionRow | null> {
		const row = this.rows.get(id);
		if (row === undefined || row.organization_id !== organizationId) {
			return null;
		}
		row.enabled = enabled;
		row.updated_at = this.clock();
		return { ...row, config: { ...row.config } };
	}

	async delete(organizationId: OrganizationId, id: string): Promise<boolean> {
		const row = this.rows.get(id);
		if (row === undefined || row.organization_id !== organizationId) {
			return false;
		}
		this.rows.delete(id);
		return true;
	}

	async findMatchingForEvent(
		input: IntegrationEventMatch & { organizationId: OrganizationId },
	): Promise<IntegrationSubscriptionRow[]> {
		// Validate the severity through the shared rank helper first.
		severityRank(input.severity);
		return [...this.rows.values()]
			.filter(
				(row) =>
					row.organization_id === input.organizationId &&
					subscriptionMatchesEvent(row, input),
			)
			.sort((left, right) => {
				const byTime = left.created_at.getTime() - right.created_at.getTime();
				return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
			})
			.map((row) => ({ ...row, config: { ...row.config } }));
	}

	get rowCount(): number {
		return this.rows.size;
	}
}

export class InMemoryEventDeliveryRepository {
	private readonly rows = new Map<string, EventDeliveryRow>();

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async record(
		input: RecordEventDeliveryInput,
	): Promise<RecordEventDeliveryResult> {
		const normalized = normalizeEventDeliveryInput(input);
		if (normalized.deliveryId !== null) {
			for (const row of this.rows.values()) {
				if (
					row.organization_id === normalized.organizationId &&
					row.connector_id === normalized.connectorId &&
					row.delivery_id === normalized.deliveryId
				) {
					return { delivery: { ...row }, created: false };
				}
			}
		}
		const now = this.clock();
		const row: EventDeliveryRow = {
			id: newUuid(),
			organization_id: normalized.organizationId,
			connector_id: normalized.connectorId,
			subscription_id: normalized.subscriptionId,
			delivery_id: normalized.deliveryId,
			source: normalized.source,
			event_kind: normalized.eventKind,
			severity: normalized.severity,
			fingerprint: normalized.fingerprint,
			verification: normalized.verification,
			status: normalized.status,
			reason_code: normalized.reasonCode,
			signal_id: normalized.signalId,
			task_id: normalized.taskId,
			body_sha256: normalized.bodySha256,
			received_at: normalized.receivedAt,
			processed_at: normalized.processedAt,
			created_at: now,
		};
		this.rows.set(row.id, row);
		return { delivery: { ...row }, created: true };
	}

	async updateStatus(
		input: UpdateEventDeliveryStatusInput,
	): Promise<EventDeliveryRow | null> {
		const row = this.rows.get(input.id);
		if (row === undefined || row.organization_id !== input.organizationId) {
			return null;
		}
		const normalized = normalizeEventDeliveryStatusUpdate(input);
		row.status = normalized.status;
		row.reason_code = normalized.reasonCode;
		row.signal_id = normalized.signalId;
		row.task_id = normalized.taskId;
		row.processed_at = normalized.processedAt;
		return { ...row };
	}

	async listRecent(
		input: ListRecentDeliveriesInput,
	): Promise<{ items: EventDeliveryRow[]; nextCursor: string | null }> {
		const rows = [...this.rows.values()].filter(
			(row) =>
				row.organization_id === input.organizationId &&
				(input.connectorId === undefined ||
					row.connector_id === input.connectorId),
		);
		return paginateDeliveries(rows, input.limit, input.cursor);
	}

	async listInbox(
		input: ListInboxDeliveriesInput,
	): Promise<{ items: EventDeliveryRow[]; nextCursor: string | null }> {
		const rows = [...this.rows.values()].filter(
			(row) =>
				row.organization_id === input.organizationId &&
				(input.status === undefined || row.status === input.status) &&
				(input.source === undefined || row.source === input.source),
		);
		return paginateDeliveries(rows, input.limit, input.cursor);
	}

	get rowCount(): number {
		return this.rows.size;
	}
}
