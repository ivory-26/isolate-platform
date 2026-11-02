import "@tanstack/react-start/server-only";
import type { PgSql } from "@isolate/db";
import { parseJsonbColumn } from "@isolate/db";
import {
	INCIDENT_SEVERITIES,
	type IncidentLink,
	type IncidentSeverity,
	type OrganizationId,
} from "@isolate/shared";
import {
	type DeliveryReasonCode,
	EVENT_DELIVERY_STATUSES,
	EVENT_DELIVERY_VERIFICATIONS,
	type EventDeliveryFinalizeInput,
	type EventDeliveryLedger,
	type EventDeliveryRecordInput,
	type EventDeliveryRecordResult,
	MAX_DELIVERY_SUMMARY_CHARS,
	MAX_DELIVERY_TITLE_CHARS,
} from "./incident-delivery.server";
import {
	type IntegrationSubscriptionRecord,
	SUBSCRIPTION_AUTONOMY_LEVELS,
	type SubscriptionAutonomyLevel,
	type SubscriptionRegistry,
} from "./incident-subscription.server";

/**
 * PostgreSQL access for the wave-23 event pipeline.
 *
 * The database package does not expose subscription/delivery repositories yet
 * (that file set is owned by another lane), so this module owns the
 * parameterized SQL. Every statement is a static string with `$n` binds and
 * every read filters on `organization_id` first. No secret, raw body, header or
 * provider payload is written here.
 */

const STMT = {
	listSubscriptions: `SELECT id, organization_id, connector_id, display_name,
			event_kinds, environment_allowlist, min_severity, repository_id,
			base_branch, autonomy_level, enabled
		FROM integration_subscriptions
		WHERE organization_id = $1 AND connector_id = $2 AND enabled = true
		ORDER BY display_name ASC, id ASC`,
	insertDelivery: `INSERT INTO event_deliveries (
			organization_id, connector_id, subscription_id, delivery_id, source,
			event_kind, severity, fingerprint, verification, status, reason_code,
			signal_id, task_id, body_sha256, received_at, processed_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
			$15::timestamptz, $16::timestamptz
		)
		ON CONFLICT DO NOTHING
		RETURNING id`,
	// A duplicate delivery id keeps its row and task link; the status becomes
	// the auditable "this delivery was seen again" marker.
	markDuplicate: `UPDATE event_deliveries
		SET status = 'deduplicated', reason_code = 'DUPLICATE_DELIVERY',
			processed_at = $4::timestamptz
		WHERE organization_id = $1 AND connector_id = $2 AND delivery_id = $3
		RETURNING id, task_id`,
	findDelivery: `SELECT id, status, task_id FROM event_deliveries
		WHERE organization_id = $1 AND connector_id = $2 AND delivery_id = $3
		LIMIT 1`,
	finalize: `UPDATE event_deliveries
		SET status = $3, reason_code = $4, signal_id = $5, task_id = $6,
			subscription_id = COALESCE($8, subscription_id),
			processed_at = $7::timestamptz
		WHERE organization_id = $1 AND id = $2`,
	attachSignalDisplay: `UPDATE incident_signals
		SET title = $3, summary = $4, links = $5::text::jsonb
		WHERE organization_id = $1 AND id = $2`,
	latestTask: `SELECT task_id FROM event_deliveries
		WHERE organization_id = $1 AND connector_id = $2 AND fingerprint = $3
		  AND task_id IS NOT NULL
		ORDER BY received_at DESC, id DESC
		LIMIT 1`,
	setTaskAutonomy: `UPDATE tasks SET autonomy_level = $3
		WHERE organization_id = $1 AND id = $2`,
	repositoryDefaultBranch: `SELECT default_branch FROM repositories
		WHERE organization_id = $1 AND id = $2
		LIMIT 1`,
} as const;

function rowsOf(result: unknown): Record<string, unknown>[] {
	return result as unknown as Record<string, unknown>[];
}

function stringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === "string");
	}
	const parsed = parseJsonbColumn<unknown>(value);
	return Array.isArray(parsed)
		? parsed.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function severityOf(value: unknown): IncidentSeverity {
	return typeof value === "string" &&
		(INCIDENT_SEVERITIES as readonly string[]).includes(value)
		? (value as IncidentSeverity)
		: "info";
}

function autonomyOf(value: unknown): SubscriptionAutonomyLevel {
	return typeof value === "string" &&
		(SUBSCRIPTION_AUTONOMY_LEVELS as readonly string[]).includes(value)
		? (value as SubscriptionAutonomyLevel)
		: "A2";
}

function mapSubscription(
	row: Record<string, unknown>,
): IntegrationSubscriptionRecord {
	return {
		id: String(row.id),
		organizationId: String(row.organization_id) as OrganizationId,
		connectorId: String(row.connector_id),
		displayName: String(row.display_name),
		eventKinds: stringArray(row.event_kinds),
		environmentAllowlist: stringArray(row.environment_allowlist),
		minSeverity: severityOf(row.min_severity),
		repositoryId: row.repository_id === null ? null : String(row.repository_id),
		baseBranch: row.base_branch === null ? null : String(row.base_branch),
		autonomyLevel: autonomyOf(row.autonomy_level),
		enabled: row.enabled === true || row.enabled === "true",
	};
}

/** Tenant- and connector-scoped subscription reader (enabled rows only). */
export class PostgresSubscriptionRegistry implements SubscriptionRegistry {
	constructor(private readonly sql: PgSql) {}

	async listEnabled(input: {
		organizationId: OrganizationId;
		connectorId: string;
	}): Promise<IntegrationSubscriptionRecord[]> {
		const rows = rowsOf(
			await this.sql.unsafe(STMT.listSubscriptions, [
				input.organizationId,
				input.connectorId,
			]),
		);
		return rows.map(mapSubscription);
	}
}

/**
 * Delivery ledger. The unique `(organization, connector, delivery id)` index
 * guarantees one row per provider delivery; the duplicate branch flips that
 * row to `deduplicated` and returns its prior task id.
 */
export class PostgresEventDeliveryLedger implements EventDeliveryLedger {
	constructor(private readonly sql: PgSql) {}

	async record(
		input: EventDeliveryRecordInput,
	): Promise<EventDeliveryRecordResult> {
		const receivedAt = input.receivedAt.toISOString();
		const processedAt = input.processedAt?.toISOString() ?? null;
		const inserted = rowsOf(
			await this.sql.unsafe(STMT.insertDelivery, [
				input.organizationId,
				input.connectorId,
				input.subscriptionId,
				input.deliveryId,
				input.source,
				input.eventKind,
				input.severity,
				input.fingerprint,
				input.verification,
				input.status,
				input.reasonCode,
				input.signalId,
				input.taskId,
				input.bodySha256,
				receivedAt,
				processedAt,
			]),
		);
		if (inserted.length > 0) {
			return {
				id: String(inserted[0].id),
				duplicate: false,
				priorTaskId: null,
			};
		}
		// Only a delivery id can conflict (the partial unique index); anything
		// else is a caller bug and surfaces as an exception, not a silent drop.
		if (input.deliveryId === null) {
			throw new Error("event delivery insert conflicted without a delivery id");
		}
		const existing = rowsOf(
			await this.sql.unsafe(STMT.findDelivery, [
				input.organizationId,
				input.connectorId,
				input.deliveryId,
			]),
		);
		if (existing.length === 0) {
			throw new Error("event delivery conflicted but no row matched");
		}
		const prior = existing[0];
		if (
			prior.status === "received" ||
			prior.status === "verified" ||
			prior.status === "rejected"
		) {
			// A prior attempt stopped before a terminal decision: process the same
			// row again instead of suppressing the event.
			return { id: String(prior.id), duplicate: false, priorTaskId: null };
		}
		const updated = rowsOf(
			await this.sql.unsafe(STMT.markDuplicate, [
				input.organizationId,
				input.connectorId,
				input.deliveryId,
				receivedAt,
			]),
		);
		if (updated.length === 0) {
			throw new Error("event delivery conflicted but no row matched");
		}
		return {
			id: String(updated[0].id),
			duplicate: true,
			priorTaskId:
				updated[0].task_id === null ? null : String(updated[0].task_id),
		};
	}

	async finalize(input: EventDeliveryFinalizeInput): Promise<void> {
		if (!EVENT_DELIVERY_STATUSES.includes(input.status)) {
			throw new Error("event delivery status is invalid");
		}
		await this.sql.unsafe(STMT.finalize, [
			input.organizationId,
			input.id,
			input.status,
			input.reasonCode,
			input.signalId,
			input.taskId,
			input.processedAt.toISOString(),
			input.subscriptionId ?? null,
		]);
	}

	async attachSignalDisplay(input: {
		organizationId: OrganizationId;
		signalId: string;
		title: string;
		summary: string;
		links: readonly IncidentLink[];
	}): Promise<void> {
		await this.sql.unsafe(STMT.attachSignalDisplay, [
			input.organizationId,
			input.signalId,
			input.title.slice(0, MAX_DELIVERY_TITLE_CHARS),
			input.summary.slice(0, MAX_DELIVERY_SUMMARY_CHARS),
			JSON.stringify(input.links.slice(0, 10)),
		]);
	}

	async findLatestTask(input: {
		organizationId: OrganizationId;
		connectorId: string;
		fingerprint: string;
	}): Promise<string | null> {
		const rows = rowsOf(
			await this.sql.unsafe(STMT.latestTask, [
				input.organizationId,
				input.connectorId,
				input.fingerprint,
			]),
		);
		return rows.length === 0 ? null : String(rows[0].task_id);
	}
}

/** Persists the autonomy level the subscription chose for a created task. */
export type TaskAutonomyRecorder = (input: {
	organizationId: OrganizationId;
	taskId: string;
	autonomyLevel: SubscriptionAutonomyLevel;
}) => Promise<void>;

export class PostgresTaskAutonomyRecorder {
	constructor(private readonly sql: PgSql) {}

	async record(input: {
		organizationId: OrganizationId;
		taskId: string;
		autonomyLevel: SubscriptionAutonomyLevel;
	}): Promise<void> {
		if (!SUBSCRIPTION_AUTONOMY_LEVELS.includes(input.autonomyLevel)) {
			throw new Error("autonomy level is invalid");
		}
		await this.sql.unsafe(STMT.setTaskAutonomy, [
			input.organizationId,
			input.taskId,
			input.autonomyLevel,
		]);
	}
}

/**
 * Server-side repository resolution for a subscription's `repository_id`.
 * Returns the default branch only when the repository belongs to the caller's
 * organization; a foreign id is indistinguishable from a missing one.
 */
export class PostgresSubscriptionRepositoryLookup {
	constructor(private readonly sql: PgSql) {}

	async defaultBranch(input: {
		organizationId: OrganizationId;
		repositoryId: string;
	}): Promise<string | null> {
		const rows = rowsOf(
			await this.sql.unsafe(STMT.repositoryDefaultBranch, [
				input.organizationId,
				input.repositoryId,
			]),
		);
		return rows.length === 0 ? null : String(rows[0].default_branch);
	}
}

export function isDeliveryReason(value: string): value is DeliveryReasonCode {
	return /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

export function isDeliveryVerification(value: string): boolean {
	return (EVENT_DELIVERY_VERIFICATIONS as readonly string[]).includes(value);
}
