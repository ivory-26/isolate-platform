import "@tanstack/react-start/server-only";
import { iso, isoOrNull, numeric } from "../../server/ui-runtime.server";
import { CONNECTOR_AUTH_KINDS, CONNECTOR_IDS } from "../devices/contracts";
import { CONNECTOR_CAPABILITY, type ConnectorCapability } from "./capabilities";
import type { IntegrationCatalogEntry } from "./catalog";
import {
	type DeliveryStatus,
	deliveryStatusSchema,
	type EventDelivery,
	INTEGRATION_TABS,
	type IntegrationConnection,
	type IntegrationSubscription,
	type IntegrationSummary,
	type IntegrationTab,
	type IntegrationUsage,
	MAX_CONNECTOR_TOOLS,
	MAX_DELIVERIES_PER_READ,
	MAX_DELIVERY_SUMMARY_CHARS,
	MAX_ENVIRONMENTS,
	MAX_EVENT_KINDS,
	MAX_SIGNAL_LINKS,
	MAX_SUBSCRIPTIONS_PER_CONNECTOR,
	SEVERITIES,
	type Severity,
	type SignalLink,
	severitySchema,
	storedAutonomyLevelSchema,
} from "./contracts";

/**
 * Tenant-scoped read model for integrations.
 *
 * Every statement binds `organization_id` as `$1`, uses parameters for every
 * caller value and carries a fixed LIMIT. The projection never includes a
 * provider payload, a credential reference, a token, a token hash or a driver
 * error: deliveries expose a bounded title/summary and safe links only.
 */

export type IntegrationsReadSql = {
	unsafe(query: string, parameters?: readonly unknown[]): Promise<unknown>;
};

export const INTEGRATION_CONNECTION_SQL = `SELECT
	cc.id, cc.connector_id, cc.display_name, cc.auth_kind, cc.status, cc.scopes,
	cc.metadata, cc.last_validated_at, cc.last_used_at,
	cd.id AS relay_id, cd.display_name AS relay_name, cd.status AS relay_status
FROM connector_credentials cc
JOIN connector_devices cd
	ON cd.id = cc.device_id AND cd.organization_id = cc.organization_id
WHERE cc.organization_id = $1
	AND cc.status <> 'revoked'
ORDER BY cc.connector_id ASC, cc.created_at DESC
LIMIT 100`;

export const INTEGRATION_TRIGGER_COUNT_SQL = `SELECT
	connector_id,
	count(*)::int AS trigger_count,
	count(*) FILTER (WHERE enabled)::int AS enabled_trigger_count
FROM integration_subscriptions
WHERE organization_id = $1
GROUP BY connector_id
LIMIT 64`;

export const INTEGRATION_LAST_EVENT_SQL = `SELECT
	connector_id, max(received_at) AS last_event_at
FROM event_deliveries
WHERE organization_id = $1
GROUP BY connector_id
LIMIT 64`;

export const INTEGRATION_USAGE_SQL = `SELECT DISTINCT ON (connector_id)
	connector_id, period, request_count
FROM connector_usage_ledger
WHERE organization_id = $1
ORDER BY connector_id ASC, period DESC
LIMIT 64`;

export const INTEGRATION_SUBSCRIPTIONS_SQL = `SELECT
	s.id, s.connector_id, s.display_name, s.event_kinds, s.environment_allowlist,
	s.min_severity, s.repository_id, s.base_branch, s.autonomy_level, s.enabled,
	s.created_at, s.updated_at,
	r.external_full_name AS repository_name
FROM integration_subscriptions s
LEFT JOIN repositories r
	ON r.id = s.repository_id AND r.organization_id = s.organization_id
WHERE s.organization_id = $1
	AND ($2::text IS NULL OR s.connector_id = $2)
ORDER BY s.created_at DESC, s.id DESC
LIMIT $3`;

export const INTEGRATION_DELIVERIES_SQL = `SELECT
	d.id, d.connector_id, d.source, d.event_kind, d.severity, d.status,
	d.reason_code, d.task_id, d.received_at,
	s.title, s.summary, s.links,
	r.external_full_name AS repository_name
FROM event_deliveries d
LEFT JOIN incident_signals s
	ON s.id = d.signal_id AND s.organization_id = d.organization_id
LEFT JOIN integration_subscriptions sub
	ON sub.id = d.subscription_id AND sub.organization_id = d.organization_id
LEFT JOIN repositories r
	ON r.id = sub.repository_id AND r.organization_id = d.organization_id
WHERE d.organization_id = $1
	AND ($2::text IS NULL OR d.connector_id = $2)
ORDER BY d.received_at DESC, d.id DESC
LIMIT $3`;

export type IntegrationAggregate = {
	readonly connections: ReadonlyMap<string, IntegrationConnection>;
	readonly triggerCounts: ReadonlyMap<string, number>;
	readonly enabledTriggerCounts: ReadonlyMap<string, number>;
	readonly lastEventAt: ReadonlyMap<string, string | null>;
	readonly usage: ReadonlyMap<string, IntegrationUsage>;
};

type Row = Record<string, unknown>;

function rowsOf(value: unknown): Row[] {
	if (!Array.isArray(value)) {
		throw new Error("integration read returned an unexpected row shape");
	}
	return value as Row[];
}

function textValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") {
		return String(value);
	}
	return "";
}

/** Caps length and strips control characters except line breaks and tabs. */
export function safeText(value: unknown, maxChars: number): string {
	const text = textValue(value);
	let output = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 && character !== "\n" && character !== "\t") continue;
		output += character;
		if (output.length >= maxChars) break;
	}
	return output.slice(0, maxChars);
}

export function boundedStringArray(
	value: unknown,
	maxItems: number,
	maxChars: number,
): string[] {
	if (!Array.isArray(value)) return [];
	const values: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const bounded = item.slice(0, maxChars);
		if (bounded.length === 0) continue;
		values.push(bounded);
		if (values.length >= maxItems) break;
	}
	return values;
}

function isConnectorId(value: string): boolean {
	return (CONNECTOR_IDS as readonly string[]).includes(value);
}

function isOneOf<T extends string>(
	values: readonly T[],
	value: string,
): value is T {
	return (values as readonly string[]).includes(value);
}

function booleanValue(value: unknown): boolean {
	return value === true || value === "t" || value === "true";
}

/** Only absolute http(s) links survive; signed URLs are not invented here. */
export function parseSignalLinks(value: unknown): SignalLink[] {
	if (!Array.isArray(value)) return [];
	const links: SignalLink[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Row;
		const label = safeText(record.label, 80).trim();
		const rawUrl = safeText(record.url, 2_000).trim();
		if (label.length === 0 || rawUrl.length === 0) continue;
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			continue;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
		links.push({ label, url: parsed.toString() });
		if (links.length >= MAX_SIGNAL_LINKS) break;
	}
	return links;
}

export function mapConnectionRow(row: Row): IntegrationConnection | null {
	const connectorId = textValue(row.connector_id);
	if (!isConnectorId(connectorId)) return null;
	const status = textValue(row.status);
	if (status === "revoked") return null;
	const authKind = textValue(row.auth_kind);
	const metadata =
		row.metadata !== null && typeof row.metadata === "object"
			? (row.metadata as Row)
			: {};
	return {
		id: textValue(row.id),
		connectorId: connectorId as IntegrationConnection["connectorId"],
		displayName: safeText(row.display_name, 100),
		authKind: isOneOf(CONNECTOR_AUTH_KINDS, authKind) ? authKind : "api_key",
		status: isOneOf(
			["pending_validation", "active", "invalid", "revoked"] as const,
			status,
		)
			? status
			: "pending_validation",
		relayId: textValue(row.relay_id),
		relayName: safeText(row.relay_name, 100),
		relayStatus: isOneOf(
			["pending", "active", "revoked"] as const,
			textValue(row.relay_status),
		)
			? (textValue(row.relay_status) as IntegrationConnection["relayStatus"])
			: "pending",
		scopes: boundedStringArray(row.scopes, 32, 64),
		enabledTools: boundedStringArray(
			metadata.enabled_tools,
			MAX_CONNECTOR_TOOLS,
			64,
		),
		lastValidatedAt: isoOrNull(row.last_validated_at),
		lastUsedAt: isoOrNull(row.last_used_at),
	};
}

export function mapSubscriptionRow(row: Row): IntegrationSubscription | null {
	const connectorId = textValue(row.connector_id);
	if (!isConnectorId(connectorId)) return null;
	const severity = textValue(row.min_severity);
	const autonomy = textValue(row.autonomy_level);
	return {
		id: textValue(row.id),
		connectorId: connectorId as IntegrationSubscription["connectorId"],
		displayName: safeText(row.display_name, 100),
		eventKinds: boundedStringArray(row.event_kinds, MAX_EVENT_KINDS, 64),
		environmentAllowlist: boundedStringArray(
			row.environment_allowlist,
			MAX_ENVIRONMENTS,
			64,
		),
		minSeverity: isOneOf(SEVERITIES, severity) ? severity : "high",
		repositoryId:
			row.repository_id === null ? null : textValue(row.repository_id),
		repositoryName:
			row.repository_name === null ? null : safeText(row.repository_name, 200),
		baseBranch:
			row.base_branch === null ? null : safeText(row.base_branch, 255),
		autonomyLevel: storedAutonomyLevelSchema.safeParse(autonomy).success
			? (autonomy as IntegrationSubscription["autonomyLevel"])
			: "A2",
		enabled: booleanValue(row.enabled),
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

export function mapDeliveryRow(row: Row): EventDelivery | null {
	const connectorId = textValue(row.connector_id);
	if (!isConnectorId(connectorId)) return null;
	const severity = textValue(row.severity);
	const status = textValue(row.status);
	return {
		id: textValue(row.id),
		connectorId: connectorId as EventDelivery["connectorId"],
		source: safeText(row.source, 32),
		eventKind: safeText(row.event_kind, 64),
		severity: severitySchema.safeParse(severity).success
			? (severity as Severity)
			: "info",
		title: safeText(row.title, 400),
		summary: safeText(row.summary, MAX_DELIVERY_SUMMARY_CHARS),
		status: deliveryStatusSchema.safeParse(status).success
			? (status as DeliveryStatus)
			: "received",
		reasonCode: row.reason_code === null ? null : safeText(row.reason_code, 64),
		repositoryName:
			row.repository_name === null ? null : safeText(row.repository_name, 200),
		taskId: row.task_id === null ? null : textValue(row.task_id),
		receivedAt: iso(row.received_at),
		links: parseSignalLinks(row.links),
	};
}

function setIfAbsent(
	target: Map<string, IntegrationConnection>,
	row: Row,
): void {
	const mapped = mapConnectionRow(row);
	if (mapped === null) return;
	// Ordered newest first; the first row per connector wins.
	if (!target.has(mapped.connectorId)) target.set(mapped.connectorId, mapped);
}

export async function readIntegrations(
	sql: IntegrationsReadSql,
	organizationId: string,
): Promise<IntegrationAggregate> {
	const [connectionRows, triggerRows, eventRows, usageRows] = await Promise.all(
		[
			sql.unsafe(INTEGRATION_CONNECTION_SQL, [organizationId]),
			sql.unsafe(INTEGRATION_TRIGGER_COUNT_SQL, [organizationId]),
			sql.unsafe(INTEGRATION_LAST_EVENT_SQL, [organizationId]),
			sql.unsafe(INTEGRATION_USAGE_SQL, [organizationId]),
		],
	);

	const connections = new Map<string, IntegrationConnection>();
	for (const row of rowsOf(connectionRows)) setIfAbsent(connections, row);

	const triggerCounts = new Map<string, number>();
	const enabledTriggerCounts = new Map<string, number>();
	for (const row of rowsOf(triggerRows)) {
		const connectorId = textValue(row.connector_id);
		if (!isConnectorId(connectorId)) continue;
		triggerCounts.set(connectorId, numeric(row.trigger_count));
		enabledTriggerCounts.set(connectorId, numeric(row.enabled_trigger_count));
	}

	const lastEventAt = new Map<string, string | null>();
	for (const row of rowsOf(eventRows)) {
		const connectorId = textValue(row.connector_id);
		if (!isConnectorId(connectorId)) continue;
		lastEventAt.set(connectorId, isoOrNull(row.last_event_at));
	}

	const usage = new Map<string, IntegrationUsage>();
	for (const row of rowsOf(usageRows)) {
		const connectorId = textValue(row.connector_id);
		if (!isConnectorId(connectorId)) continue;
		usage.set(connectorId, {
			requestsThisPeriod: numeric(row.request_count),
			period: isoOrNull(row.period),
		});
	}

	return {
		connections,
		triggerCounts,
		enabledTriggerCounts,
		lastEventAt,
		usage,
	};
}

export async function readSubscriptions(
	sql: IntegrationsReadSql,
	organizationId: string,
	connectorId?: string,
): Promise<{
	subscriptions: IntegrationSubscription[];
	truncated: boolean;
}> {
	const rows = rowsOf(
		await sql.unsafe(INTEGRATION_SUBSCRIPTIONS_SQL, [
			organizationId,
			connectorId ?? null,
			MAX_SUBSCRIPTIONS_PER_CONNECTOR + 1,
		]),
	);
	const subscriptions = rows
		.slice(0, MAX_SUBSCRIPTIONS_PER_CONNECTOR)
		.map(mapSubscriptionRow)
		.filter((row): row is IntegrationSubscription => row !== null);
	return {
		subscriptions,
		truncated: rows.length > MAX_SUBSCRIPTIONS_PER_CONNECTOR,
	};
}

export async function readDeliveries(
	sql: IntegrationsReadSql,
	organizationId: string,
	input: { connectorId?: string; limit: number },
): Promise<{ deliveries: EventDelivery[]; truncated: boolean }> {
	const limit = Math.min(Math.max(input.limit, 1), MAX_DELIVERIES_PER_READ);
	const rows = rowsOf(
		await sql.unsafe(INTEGRATION_DELIVERIES_SQL, [
			organizationId,
			input.connectorId ?? null,
			limit + 1,
		]),
	);
	const deliveries = rows
		.slice(0, limit)
		.map(mapDeliveryRow)
		.filter((row): row is EventDelivery => row !== null);
	return { deliveries, truncated: rows.length > limit };
}

/**
 * Merges the catalog entry with the tenant read rows into one bounded summary.
 * Kept pure so the server function and the tests share exactly one shape.
 */
export function summarizeIntegration(
	entry: IntegrationCatalogEntry,
	aggregate: IntegrationAggregate,
): IntegrationSummary {
	const connection = aggregate.connections.get(entry.id) ?? null;
	return {
		connectorId: entry.id,
		label: entry.label,
		category: entry.category,
		capabilities: entry.capabilities,
		pairingMode: entry.pairingMode,
		connection,
		triggerCount: aggregate.triggerCounts.get(entry.id) ?? 0,
		enabledTriggerCount: aggregate.enabledTriggerCounts.get(entry.id) ?? 0,
		lastEventAt: aggregate.lastEventAt.get(entry.id) ?? null,
		usage: aggregate.usage.get(entry.id) ?? {
			requestsThisPeriod: 0,
			period: null,
		},
	};
}

/** The catalog capability a surface is asking about; exported for clarity. */
export function capabilityForIntegrationTab(
	tab: IntegrationTab,
): ConnectorCapability {
	return tab === "connected"
		? CONNECTOR_CAPABILITY.manage
		: CONNECTOR_CAPABILITY.read;
}

export function normalizeTab(value: string): IntegrationTab {
	return isOneOf(INTEGRATION_TABS, value) ? value : "catalog";
}
