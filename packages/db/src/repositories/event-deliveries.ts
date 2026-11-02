import {
	EVENT_DELIVERY_STATUSES,
	EVENT_VERIFICATION_METHODS,
	type EventDeliveryStatus,
	type EventVerificationMethod,
	INCIDENT_SEVERITIES,
	type IncidentSeverity,
	type IntegrationConnectorId,
	integrationConnectorIdSchema,
	type OrganizationId,
	PlatformError,
	type TaskId,
} from "@isolate/shared";
import type { PgSql } from "../client";
import type { EventDeliveryRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Bounded event-delivery ledger (wave 23, migration 0016).
 *
 * A row is a receipt, never a payload: `body_sha256` proves what arrived, and
 * the bounded source/kind/severity fields drive the inbox. No provider body,
 * header, credential or token is stored.
 *
 * Idempotency: `(organization_id, connector_id, delivery_id)` is unique when a
 * delivery id is present. `record` returns the surviving row with
 * `created: false` on a duplicate, so a retried webhook cannot create a second
 * receipt or a second task. Pagination is keyset-based (`received_at`, `id`)
 * with an opaque cursor and a hard page cap.
 */

export const DEFAULT_DELIVERY_PAGE_LIMIT = 25;
export const MAX_DELIVERY_PAGE_LIMIT = 100;
const MAX_DELIVERY_ID_CHARS = 128;
const MAX_SOURCE_CHARS = 32;
const MAX_EVENT_KIND_CHARS = 64;
const MAX_FINGERPRINT_CHARS = 128;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

const DELIVERY_COLUMNS =
	"id, organization_id, connector_id, subscription_id, delivery_id, source, event_kind, severity, fingerprint, verification, status, reason_code, signal_id, task_id, body_sha256, received_at, processed_at, created_at";

export type RecordEventDeliveryInput = {
	readonly organizationId: OrganizationId;
	readonly connectorId: IntegrationConnectorId;
	readonly subscriptionId?: string | null;
	/** Provider delivery id; null means every delivery is a new receipt. */
	readonly deliveryId?: string | null;
	readonly source: string;
	readonly eventKind: string;
	readonly severity: IncidentSeverity;
	readonly fingerprint: string;
	readonly verification: EventVerificationMethod;
	readonly status?: EventDeliveryStatus;
	readonly reasonCode?: string | null;
	readonly signalId?: string | null;
	readonly taskId?: TaskId | null;
	readonly bodySha256: string;
	readonly receivedAt?: Date;
	readonly processedAt?: Date | null;
};

export type RecordEventDeliveryResult = {
	readonly delivery: EventDeliveryRow;
	readonly created: boolean;
};

export type UpdateEventDeliveryStatusInput = {
	readonly organizationId: OrganizationId;
	readonly id: string;
	readonly status: EventDeliveryStatus;
	readonly reasonCode?: string | null;
	readonly signalId?: string | null;
	readonly taskId?: TaskId | null;
	readonly processedAt?: Date | null;
};

export type ListEventDeliveriesInput = {
	readonly organizationId: OrganizationId;
	/** Opaque cursor returned by the previous page. */
	readonly cursor?: string | null;
	readonly limit?: number;
};

export type ListRecentDeliveriesInput = ListEventDeliveriesInput & {
	readonly connectorId?: IntegrationConnectorId;
};

export type ListInboxDeliveriesInput = ListEventDeliveriesInput & {
	readonly status?: EventDeliveryStatus;
	readonly source?: string;
};

export type EventDeliveryPage = {
	readonly items: EventDeliveryRow[];
	readonly nextCursor: string | null;
};

export interface EventDeliveryRepository {
	record(input: RecordEventDeliveryInput): Promise<RecordEventDeliveryResult>;
	updateStatus(
		input: UpdateEventDeliveryStatusInput,
	): Promise<EventDeliveryRow | null>;
	listRecent(input: ListRecentDeliveriesInput): Promise<EventDeliveryPage>;
	listInbox(input: ListInboxDeliveriesInput): Promise<EventDeliveryPage>;
}

export type NormalizedEventDelivery = {
	organizationId: OrganizationId;
	connectorId: IntegrationConnectorId;
	subscriptionId: string | null;
	deliveryId: string | null;
	source: string;
	eventKind: string;
	severity: IncidentSeverity;
	fingerprint: string;
	verification: EventVerificationMethod;
	status: EventDeliveryStatus;
	reasonCode: string | null;
	signalId: string | null;
	taskId: TaskId | null;
	bodySha256: string;
	receivedAt: Date;
	processedAt: Date | null;
};

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function boundedText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") throw validationError(`${field} is invalid`);
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) {
		throw validationError(`${field} is invalid`);
	}
	return trimmed;
}

function optionalUuid(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw validationError(`${field} is invalid`);
	}
	return value.toLowerCase();
}

function optionalReasonCode(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !REASON_CODE_PATTERN.test(value)) {
		throw validationError("reasonCode is invalid");
	}
	return value;
}

function validDate(value: unknown, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw validationError(`${field} is invalid`);
	}
	return new Date(value.getTime());
}

export function clampDeliveryLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_DELIVERY_PAGE_LIMIT;
	}
	return Math.max(1, Math.min(MAX_DELIVERY_PAGE_LIMIT, Math.floor(limit)));
}

export function normalizeEventDeliveryInput(
	input: RecordEventDeliveryInput,
): NormalizedEventDelivery {
	requireNonEmpty(input.organizationId, "organizationId");
	const connectorId = integrationConnectorIdSchema.safeParse(input.connectorId);
	if (!connectorId.success) throw validationError("connectorId is invalid");
	if (!INCIDENT_SEVERITIES.includes(input.severity)) {
		throw validationError("severity is invalid");
	}
	if (!EVENT_VERIFICATION_METHODS.includes(input.verification)) {
		throw validationError("verification is invalid");
	}
	const status = input.status ?? "received";
	if (!EVENT_DELIVERY_STATUSES.includes(status)) {
		throw validationError("status is invalid");
	}
	if (
		typeof input.bodySha256 !== "string" ||
		!SHA256_PATTERN.test(input.bodySha256)
	) {
		throw validationError("bodySha256 must be 64 lowercase hex characters");
	}
	const deliveryId =
		input.deliveryId === undefined || input.deliveryId === null
			? null
			: boundedText(input.deliveryId, "deliveryId", MAX_DELIVERY_ID_CHARS);
	const receivedAt =
		input.receivedAt === undefined
			? new Date()
			: validDate(input.receivedAt, "receivedAt");
	const processedAt =
		input.processedAt === undefined || input.processedAt === null
			? null
			: validDate(input.processedAt, "processedAt");
	return {
		organizationId: input.organizationId,
		connectorId: connectorId.data,
		subscriptionId: optionalUuid(input.subscriptionId, "subscriptionId"),
		deliveryId,
		source: boundedText(input.source, "source", MAX_SOURCE_CHARS),
		eventKind: boundedText(input.eventKind, "eventKind", MAX_EVENT_KIND_CHARS),
		severity: input.severity,
		fingerprint: boundedText(
			input.fingerprint,
			"fingerprint",
			MAX_FINGERPRINT_CHARS,
		),
		verification: input.verification,
		status,
		reasonCode: optionalReasonCode(input.reasonCode),
		signalId: optionalUuid(input.signalId, "signalId"),
		taskId: optionalUuid(input.taskId, "taskId") as TaskId | null,
		bodySha256: input.bodySha256,
		receivedAt,
		processedAt,
	};
}

export type NormalizedEventDeliveryStatus = {
	status: EventDeliveryStatus;
	reasonCode: string | null;
	signalId: string | null;
	taskId: TaskId | null;
	processedAt: Date | null;
};

/** Shared status-update bounds, used by the driver and the in-memory fake. */
export function normalizeEventDeliveryStatusUpdate(
	input: UpdateEventDeliveryStatusInput,
): NormalizedEventDeliveryStatus {
	if (!EVENT_DELIVERY_STATUSES.includes(input.status)) {
		throw validationError("status is invalid");
	}
	const processedAt =
		input.processedAt === undefined
			? input.status === "received" || input.status === "verified"
				? null
				: new Date()
			: input.processedAt === null
				? null
				: validDate(input.processedAt, "processedAt");
	return {
		status: input.status,
		reasonCode: optionalReasonCode(input.reasonCode),
		signalId: optionalUuid(input.signalId, "signalId"),
		taskId: optionalUuid(input.taskId, "taskId") as TaskId | null,
		processedAt,
	};
}

export type DeliveryCursor = { readonly receivedAt: Date; readonly id: string };

export function encodeDeliveryCursor(cursor: DeliveryCursor): string {
	return Buffer.from(
		JSON.stringify({ r: cursor.receivedAt.toISOString(), i: cursor.id }),
		"utf8",
	).toString("base64url");
}

export function decodeDeliveryCursor(cursor: string): DeliveryCursor {
	if (
		typeof cursor !== "string" ||
		cursor.length === 0 ||
		cursor.length > 512
	) {
		throw validationError("cursor is invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw validationError("cursor is invalid");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw validationError("cursor is invalid");
	}
	const candidate = parsed as { r?: unknown; i?: unknown };
	if (typeof candidate.r !== "string" || typeof candidate.i !== "string") {
		throw validationError("cursor is invalid");
	}
	const receivedAt = new Date(candidate.r);
	if (Number.isNaN(receivedAt.getTime()) || !UUID_PATTERN.test(candidate.i)) {
		throw validationError("cursor is invalid");
	}
	return { receivedAt, id: candidate.i.toLowerCase() };
}

/**
 * Keyset pagination over rows already sorted newest-first. Shared by the
 * in-memory fake; the driver applies the same comparison in SQL.
 */
export function paginateDeliveries(
	rows: readonly EventDeliveryRow[],
	limit: number | undefined,
	cursor: string | null | undefined,
): EventDeliveryPage {
	const bounded = clampDeliveryLimit(limit);
	const decoded =
		cursor === undefined || cursor === null
			? null
			: decodeDeliveryCursor(cursor);
	let filtered = rows.slice().sort((left, right) => {
		const byTime = right.received_at.getTime() - left.received_at.getTime();
		return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
	});
	if (decoded !== null) {
		const cursorTime = decoded.receivedAt.getTime();
		filtered = filtered.filter((row) => {
			const time = row.received_at.getTime();
			if (time !== cursorTime) return time < cursorTime;
			return row.id.localeCompare(decoded.id) < 0;
		});
	}
	const items = filtered.slice(0, bounded);
	const last = items[items.length - 1];
	const nextCursor =
		filtered.length > bounded && last !== undefined
			? encodeDeliveryCursor({ receivedAt: last.received_at, id: last.id })
			: null;
	return { items, nextCursor };
}

export function mapEventDeliveryRow(
	row: Record<string, unknown>,
): EventDeliveryRow {
	return {
		id: String(row.id),
		organization_id: row.organization_id as OrganizationId,
		connector_id: row.connector_id as IntegrationConnectorId,
		subscription_id:
			row.subscription_id === null || row.subscription_id === undefined
				? null
				: String(row.subscription_id),
		delivery_id:
			row.delivery_id === null || row.delivery_id === undefined
				? null
				: String(row.delivery_id),
		source: String(row.source),
		event_kind: String(row.event_kind),
		severity: row.severity as IncidentSeverity,
		fingerprint: String(row.fingerprint),
		verification: row.verification as EventVerificationMethod,
		status: row.status as EventDeliveryStatus,
		reason_code:
			row.reason_code === null || row.reason_code === undefined
				? null
				: String(row.reason_code),
		signal_id:
			row.signal_id === null || row.signal_id === undefined
				? null
				: String(row.signal_id),
		task_id:
			row.task_id === null || row.task_id === undefined
				? null
				: (String(row.task_id) as TaskId),
		body_sha256: String(row.body_sha256),
		received_at: row.received_at as Date,
		processed_at:
			row.processed_at === null || row.processed_at === undefined
				? null
				: (row.processed_at as Date),
		created_at: row.created_at as Date,
	};
}

const STMT = {
	insert: `INSERT INTO event_deliveries (
		organization_id, connector_id, subscription_id, delivery_id, source,
		event_kind, severity, fingerprint, verification, status, reason_code,
		signal_id, task_id, body_sha256, received_at, processed_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
		$14, $15::timestamptz, $16::timestamptz)
	ON CONFLICT (organization_id, connector_id, delivery_id)
		WHERE delivery_id IS NOT NULL
	DO NOTHING
	RETURNING ${DELIVERY_COLUMNS}`,
	findByDelivery: `SELECT ${DELIVERY_COLUMNS} FROM event_deliveries
		WHERE organization_id = $1 AND connector_id = $2 AND delivery_id = $3
		ORDER BY received_at DESC, id DESC
		LIMIT 1`,
	updateStatus: `UPDATE event_deliveries SET
		status = $3, reason_code = $4, signal_id = $5, task_id = $6,
		processed_at = $7::timestamptz
		WHERE organization_id = $1 AND id = $2
		RETURNING ${DELIVERY_COLUMNS}`,
	listRecent: `SELECT ${DELIVERY_COLUMNS} FROM event_deliveries
		WHERE organization_id = $1
		  AND ($2::text IS NULL OR connector_id = $2)
		  AND ($3::timestamptz IS NULL OR (received_at, id) < ($3::timestamptz, $4::uuid))
		ORDER BY received_at DESC, id DESC
		LIMIT $5`,
	listInbox: `SELECT ${DELIVERY_COLUMNS} FROM event_deliveries
		WHERE organization_id = $1
		  AND ($2::text IS NULL OR status = $2)
		  AND ($3::text IS NULL OR source = $3)
		  AND ($4::timestamptz IS NULL OR (received_at, id) < ($4::timestamptz, $5::uuid))
		ORDER BY received_at DESC, id DESC
		LIMIT $6`,
} as const;

function pageFrom(
	rows: Record<string, unknown>[],
	limit: number,
): EventDeliveryPage {
	const mapped = rows.map(mapEventDeliveryRow);
	const hasMore = mapped.length > limit;
	const items = hasMore ? mapped.slice(0, limit) : mapped;
	const last = items[items.length - 1];
	return {
		items,
		nextCursor:
			hasMore && last !== undefined
				? encodeDeliveryCursor({ receivedAt: last.received_at, id: last.id })
				: null,
	};
}

export class PostgresEventDeliveryRepository
	implements EventDeliveryRepository
{
	constructor(private readonly sql: PgSql) {}

	async record(
		input: RecordEventDeliveryInput,
	): Promise<RecordEventDeliveryResult> {
		const normalized = normalizeEventDeliveryInput(input);
		const inserted = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.connectorId,
			normalized.subscriptionId,
			normalized.deliveryId,
			normalized.source,
			normalized.eventKind,
			normalized.severity,
			normalized.fingerprint,
			normalized.verification,
			normalized.status,
			normalized.reasonCode,
			normalized.signalId,
			normalized.taskId,
			normalized.bodySha256,
			normalized.receivedAt.toISOString(),
			normalized.processedAt === null
				? null
				: normalized.processedAt.toISOString(),
		])) as unknown as Record<string, unknown>[];
		if (inserted.length > 0) {
			return {
				delivery: mapEventDeliveryRow(inserted[0]),
				created: true,
			};
		}
		if (normalized.deliveryId === null) {
			throw new Error("event delivery insert returned no row");
		}
		const existing = (await this.sql.unsafe(STMT.findByDelivery, [
			normalized.organizationId,
			normalized.connectorId,
			normalized.deliveryId,
		])) as unknown as Record<string, unknown>[];
		if (existing.length === 0) {
			throw new Error(
				"event delivery conflicted but no row matches the delivery id",
			);
		}
		return { delivery: mapEventDeliveryRow(existing[0]), created: false };
	}

	async updateStatus(
		input: UpdateEventDeliveryStatusInput,
	): Promise<EventDeliveryRow | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.id, "id");
		const normalized = normalizeEventDeliveryStatusUpdate(input);
		const rows = (await this.sql.unsafe(STMT.updateStatus, [
			input.organizationId,
			input.id,
			normalized.status,
			normalized.reasonCode,
			normalized.signalId,
			normalized.taskId,
			normalized.processedAt === null
				? null
				: normalized.processedAt.toISOString(),
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapEventDeliveryRow(rows[0]);
	}

	async listRecent(
		input: ListRecentDeliveriesInput,
	): Promise<EventDeliveryPage> {
		requireNonEmpty(input.organizationId, "organizationId");
		const limit = clampDeliveryLimit(input.limit);
		const cursor =
			input.cursor === undefined || input.cursor === null
				? null
				: decodeDeliveryCursor(input.cursor);
		const rows = (await this.sql.unsafe(STMT.listRecent, [
			input.organizationId,
			input.connectorId ?? null,
			cursor === null ? null : cursor.receivedAt.toISOString(),
			cursor === null ? null : cursor.id,
			limit + 1,
		])) as unknown as Record<string, unknown>[];
		return pageFrom(rows, limit);
	}

	async listInbox(input: ListInboxDeliveriesInput): Promise<EventDeliveryPage> {
		requireNonEmpty(input.organizationId, "organizationId");
		const limit = clampDeliveryLimit(input.limit);
		const cursor =
			input.cursor === undefined || input.cursor === null
				? null
				: decodeDeliveryCursor(input.cursor);
		const rows = (await this.sql.unsafe(STMT.listInbox, [
			input.organizationId,
			input.status ?? null,
			input.source ?? null,
			cursor === null ? null : cursor.receivedAt.toISOString(),
			cursor === null ? null : cursor.id,
			limit + 1,
		])) as unknown as Record<string, unknown>[];
		return pageFrom(rows, limit);
	}
}
