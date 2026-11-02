import "@tanstack/react-start/server-only";
import { type PgSql, parseJsonbColumn } from "@isolate/db";
import {
	type IncidentLink,
	type IncidentSeverity,
	incidentLinkSchema,
	MAX_INCIDENT_LINKS,
} from "@isolate/shared";
import {
	clampInboxLimit,
	type InboxDeliveryRow,
	type InboxItem,
	type InboxPage,
	inboxQuerySchema,
	mapInboxItem,
} from "../features/inbox/contracts";
import { UiInvalidInputError, type UiResult } from "../features/ui/contracts";
import type { CallerScope } from "./task-service.server";
import { iso, isoOrNull, uiRead } from "./ui-runtime.server";

/**
 * Tenant-scoped Inbox read model (wave 23).
 *
 * One bounded page of event deliveries, newest first, joined to the normalized
 * signal (bounded title/summary/links), the subscription's repository mapping
 * and the task link. Payloads, headers, body hashes, tokens and provider free
 * text never cross this boundary.
 */

export type InboxFilter = {
	limit: number;
	/** Connector token filter, already validated. */
	connector: string | null;
	/** Delivery status filter, already validated. */
	status: string | null;
};

export type InboxReadRepository = {
	listDeliveries(
		scope: CallerScope,
		filter: InboxFilter,
	): Promise<InboxDeliveryRow[]>;
};

const INBOX_SQL = `SELECT d.id, d.connector_id, d.source, d.event_kind, d.severity,
		d.status, d.reason_code, d.received_at, d.processed_at, d.task_id,
		COALESCE(s.title, '') AS title,
		COALESCE(s.summary, '') AS summary,
		COALESCE(s.links, '[]'::jsonb) AS links,
		r.external_full_name AS repository_full_name
	FROM event_deliveries d
	LEFT JOIN incident_signals s
		ON s.id = d.signal_id AND s.organization_id = d.organization_id
	LEFT JOIN integration_subscriptions sub
		ON sub.id = d.subscription_id AND sub.organization_id = d.organization_id
	LEFT JOIN tasks t
		ON t.id = d.task_id AND t.organization_id = d.organization_id
	LEFT JOIN repositories r
		ON r.organization_id = d.organization_id
		AND r.id = COALESCE(t.repository_id, sub.repository_id)
	WHERE d.organization_id = $1
	  AND ($2::text IS NULL OR d.connector_id = $2)
	  AND ($3::text IS NULL OR d.status = $3)
	ORDER BY d.received_at DESC, d.id DESC
	LIMIT $4`;

function rowsOf(result: unknown): Record<string, unknown>[] {
	return result as unknown as Record<string, unknown>[];
}

/** Defensive parse: only bounded https links survive the jsonb round trip. */
export function parseInboxLinks(value: unknown): IncidentLink[] {
	let parsed: unknown;
	try {
		parsed = parseJsonbColumn<unknown>(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const links: IncidentLink[] = [];
	for (const entry of parsed) {
		const result = incidentLinkSchema.safeParse(entry);
		if (result.success) links.push(result.data);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

export function createPostgresInboxRepository(sql: PgSql): InboxReadRepository {
	return {
		async listDeliveries(scope, filter) {
			const rows = rowsOf(
				await sql.unsafe(INBOX_SQL, [
					scope.organizationId,
					filter.connector,
					filter.status,
					filter.limit,
				]),
			);
			return rows.map((row) => ({
				id: String(row.id),
				connector: String(row.connector_id),
				source: String(row.source),
				eventKind: String(row.event_kind),
				severity: String(row.severity) as IncidentSeverity,
				status: String(row.status),
				reasonCode: row.reason_code === null ? null : String(row.reason_code),
				title: String(row.title),
				summary: String(row.summary),
				links: parseInboxLinks(row.links),
				repository:
					row.repository_full_name === null
						? null
						: String(row.repository_full_name),
				taskId: row.task_id === null ? null : String(row.task_id),
				receivedAt: iso(row.received_at),
				processedAt: isoOrNull(row.processed_at),
			}));
		},
	};
}

export type InboxReadService = {
	listInbox(scope: CallerScope, query?: unknown): Promise<InboxPage>;
};

export function createInboxReadService(
	repository: InboxReadRepository,
): InboxReadService {
	return {
		async listInbox(scope, query) {
			const parsed = inboxQuerySchema.safeParse(query ?? {});
			if (!parsed.success) throw new UiInvalidInputError();
			const limit = clampInboxLimit(parsed.data?.limit);
			const rows = await repository.listDeliveries(scope, {
				limit,
				connector: parsed.data?.source ?? null,
				status: parsed.data?.status ?? null,
			});
			const items: InboxItem[] = rows
				.slice(0, limit)
				.map((row) => mapInboxItem(row));
			return { items, limit };
		},
	};
}

/**
 * Server-function entry point for `/inbox`. `task:read` gates the read and the
 * caller's organization is the only tenancy input.
 */
export function readInbox(input?: unknown): Promise<UiResult<InboxPage>> {
	return uiRead("task:read", (scope, sql) =>
		createInboxReadService(createPostgresInboxRepository(sql)).listInbox(
			scope,
			input,
		),
	);
}

export type {
	InboxDeliveryRow,
	InboxItem,
	InboxPage,
} from "../features/inbox/contracts";
