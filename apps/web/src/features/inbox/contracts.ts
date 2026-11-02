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
