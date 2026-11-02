import type { IncidentLink, IncidentSeverity } from "@isolate/shared";
import { z } from "zod";

/**
 * Client-safe Inbox contract (wave 23).
 *
 * The Inbox lists event deliveries, never payloads: one bounded row per
 * delivery with its source, severity, matched status, reason and task link. The
 * pure mapping helpers here are the only place a status or connector id becomes
 * operator-facing text, so the read model and the UI cannot drift.
 */

export const EVENT_DELIVERY_STATUSES = [
	"received",
	"verified",
	"rejected",
	"deduplicated",
	"task_created",
	"task_updated",
	"ignored",
] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

export const INBOX_LIMITS = { default: 25, max: 100 } as const;

/** One table page. The page loads a bounded window and pages it here. */
export const INBOX_PAGE_SIZE = 25;

/** Severity values accepted by the optional client-side severity filter. */
export const INBOX_SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"info",
] as const;
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number];

const CONNECTOR_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const inboxQuerySchema = z
	.strictObject({
		// Oversized limits are clamped by the read model, not rejected: the cap
		// is a server guarantee, not a client contract.
		limit: z.number().int().min(1).optional(),
		/** Connector token filter, e.g. `github`. */
		source: z.string().trim().regex(CONNECTOR_PATTERN).optional(),
		status: z.enum(EVENT_DELIVERY_STATUSES).optional(),
	})
	.optional();

export type InboxQuery = z.output<typeof inboxQuerySchema>;

export type InboxTone = "neutral" | "positive" | "attention" | "muted";

const STATUS_LABELS: Readonly<Record<EventDeliveryStatus, string>> = {
	received: "Received",
	verified: "Verified",
	rejected: "Rejected",
	deduplicated: "Deduplicated",
	task_created: "Task created",
	task_updated: "Task updated",
	ignored: "Ignored",
};

const STATUS_TONES: Readonly<Record<EventDeliveryStatus, InboxTone>> = {
	received: "neutral",
	verified: "neutral",
	rejected: "attention",
	deduplicated: "muted",
	task_created: "positive",
	task_updated: "positive",
	ignored: "muted",
};

const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
	github: "GitHub",
	sentry: "Sentry",
	grafana: "Grafana",
	pagerduty: "PagerDuty",
	datadog: "Datadog",
	newrelic: "New Relic",
	honeycomb: "Honeycomb",
	axiom: "Axiom",
	signoz: "SigNoz",
	kubernetes: "Kubernetes",
	generic: "Signed webhook",
};

/**
 * The bounded source filter: the connector tokens the intake can verify. The
 * list is static and ordered for a stable select, never a provider response.
 */
export const INBOX_SOURCE_OPTIONS: readonly { value: string; label: string }[] =
	Object.entries(CONNECTOR_LABELS)
		.map(([value, label]) => ({ value, label }))
		.sort((left, right) => left.label.localeCompare(right.label));

const REASON_LABELS: Readonly<Record<string, string>> = {
	NOT_AN_INCIDENT: "Not an incident",
	TRIGGER_POLICY_REJECTED: "Below the trigger policy",
	DUPLICATE_DELIVERY: "Duplicate delivery",
	DUPLICATE_FINGERPRINT: "Already handled",
	THROTTLED: "Active task limit reached",
	NO_SUBSCRIPTION_MATCH: "No trigger matched",
	SUBSCRIPTION_DISABLED: "Trigger disabled",
	CONNECTOR_MISMATCH: "Connector mismatch",
	EVENT_KIND_NOT_SUBSCRIBED: "Event type not subscribed",
	SEVERITY_BELOW_MINIMUM: "Below the severity threshold",
	ENVIRONMENT_NOT_ALLOWED: "Environment not allowed",
	BASE_BRANCH_MISMATCH: "Base branch does not match",
	REPOSITORY_UNMAPPED: "No repository mapped",
	TENANT_MISMATCH: "Mapping rejected",
	AUTONOMY_OBSERVE_ONLY: "Observe-only (A0)",
	AUTONOMY_LEVEL_UNSUPPORTED: "Autonomy level not supported yet",
	LIFECYCLE_UPDATE: "Lifecycle update",
	LIFECYCLE_UNMATCHED: "Lifecycle update with no matching task",
	TASK_SUBMISSION_FAILED: "Task submission failed",
	INVALID_PAYLOAD: "Invalid payload",
	SIGNATURE_REJECTED: "Signature rejected",
};

const SEVERITY_LABELS: Readonly<Record<IncidentSeverity, string>> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	info: "Info",
};

export function isInboxStatus(value: string): value is EventDeliveryStatus {
	return (EVENT_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function inboxStatusLabel(status: string): string {
	return isInboxStatus(status) ? STATUS_LABELS[status] : "Unknown";
}

export function inboxStatusTone(status: string): InboxTone {
	return isInboxStatus(status) ? STATUS_TONES[status] : "neutral";
}

/** Connector tokens are stable; unknown tokens render as a bounded title. */
export function inboxSourceLabel(connector: string): string {
	const known = CONNECTOR_LABELS[connector.toLowerCase()];
	if (known !== undefined) return known;
	const bounded = connector.slice(0, 32);
	return bounded.length === 0
		? "Source"
		: `${bounded.charAt(0).toUpperCase()}${bounded.slice(1)}`;
}

export function inboxReasonLabel(reason: string | null): string | null {
	if (reason === null || reason.length === 0) return null;
	const known = REASON_LABELS[reason];
	if (known !== undefined) return known;
	return `${reason.charAt(0)}${reason.slice(1).toLowerCase().replaceAll("_", " ")}`;
}

export function inboxSeverityLabel(severity: string): string {
	return SEVERITY_LABELS[severity as IncidentSeverity] ?? "Info";
}

/** Clamps an untrusted limit to the read-model bounds. */
export function clampInboxLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit))
		return INBOX_LIMITS.default;
	const integer = Math.trunc(limit);
	if (integer < 1) return 1;
	return Math.min(integer, INBOX_LIMITS.max);
}

/* -------------------------------------------------------------------------- */
/* URL search and paging (wave 23 UI)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The Inbox keeps its filters in the URL so a view is linkable and back/forward
 * works. Unknown or malformed values are dropped, never echoed.
 */
export type InboxSearch = {
	status?: EventDeliveryStatus;
	/** Connector token, e.g. `sentry`. */
	source?: string;
	severity?: InboxSeverity;
	page?: number;
};

export function isInboxSeverity(value: string): value is InboxSeverity {
	return (INBOX_SEVERITIES as readonly string[]).includes(value);
}

/** Pure URL parser; a page below one or a non-number becomes page one. */
export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
	const parsed: InboxSearch = {};
	if (typeof search.status === "string" && isInboxStatus(search.status)) {
		parsed.status = search.status;
	}
	if (
		typeof search.source === "string" &&
		CONNECTOR_PATTERN.test(search.source)
	) {
		parsed.source = search.source;
	}
	if (typeof search.severity === "string" && isInboxSeverity(search.severity)) {
		parsed.severity = search.severity;
	}
	const page = Number(search.page);
	if (Number.isFinite(page) && page >= 2) parsed.page = Math.trunc(page);
	return parsed;
}

/** Serializes the validated filters back into a Link/`navigate` search object. */
export function inboxSearchFor(
	search: InboxSearch,
	changes: Partial<InboxSearch>,
): InboxSearch {
	const next: InboxSearch = { ...search, ...changes };
	// A filter change always returns to the first page.
	if (changes.page === undefined) delete next.page;
	return next;
}

/**
 * The bounded server query for a search. Severity is not a server filter in
 * the merged read model, so it is applied to the loaded window by
 * {@link filterInboxItems}; status and source are filtered in SQL.
 */
export function inboxQueryFor(search: InboxSearch): {
	status?: EventDeliveryStatus;
	source?: string;
	limit: number;
} {
	return {
		limit: INBOX_LIMITS.max,
		...(search.status === undefined ? {} : { status: search.status }),
		...(search.source === undefined ? {} : { source: search.source }),
	};
}

/** Applies the optional severity filter to the already-bounded delivery list. */
export function filterInboxItems<T extends { severity: string }>(
	items: readonly T[],
	severity: InboxSeverity | undefined,
): T[] {
	if (severity === undefined) return [...items];
	return items.filter((item) => item.severity === severity);
}

/** The bounded row the server read produces (no payloads, no tokens). */
export type InboxDeliveryRow = {
	id: string;
	connector: string;
	source: string;
	eventKind: string;
	severity: IncidentSeverity;
	status: string;
	reasonCode: string | null;
	title: string;
	summary: string;
	links: readonly IncidentLink[];
	repository: string | null;
	taskId: string | null;
	receivedAt: string;
	processedAt: string | null;
};

export type InboxItem = InboxDeliveryRow & {
	statusLabel: string;
	statusTone: InboxTone;
	sourceLabel: string;
	reasonLabel: string | null;
	severityLabel: string;
};

export type InboxPage = {
	items: InboxItem[];
	limit: number;
};

/** Pure mapping used by the server read model and the mocked tests. */
export function mapInboxItem(row: InboxDeliveryRow): InboxItem {
	return {
		...row,
		statusLabel: inboxStatusLabel(row.status),
		statusTone: inboxStatusTone(row.status),
		sourceLabel: inboxSourceLabel(row.connector),
		reasonLabel: inboxReasonLabel(row.reasonCode),
		severityLabel: inboxSeverityLabel(row.severity),
	};
}
