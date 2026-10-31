import { createHash } from "node:crypto";
import {
	type IncidentSeverity,
	type IncidentSignal,
	incidentSignalSchema,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINKS,
	MAX_INCIDENT_SERVICE_CHARS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactPagerDutyText } from "./redact";
import {
	type PagerDutyIncident,
	pagerDutyIncidentSchema,
	pagerDutyWebhookEnvelopeSchema,
} from "./schemas";

/**
 * PagerDuty incident normalization.
 *
 * `incident.triggered` is the only event that may create a task. Resolved,
 * acknowledged and other lifecycle events classify as updates and normalize to
 * `null`, so a status change can never create a second task. The fingerprint is
 * source-stable (`pagerduty:<service-id>:<incident-id>`), so a redelivery or a
 * later status change dedupes against the existing incident; `event.id` and
 * `X-Webhook-Id` are traceability only, never the dedupe key.
 *
 * All provider strings pass the PagerDuty redactor (emails, phones, contact
 * methods, credentials) and every field is capped to the shared signal limits.
 * Responder, assignment and alert fields are never read.
 */

export const PAGERDUTY_TRIGGER_EVENT = "incident.triggered";
export const PAGERDUTY_UPDATE_EVENTS = [
	"incident.acknowledged",
	"incident.resolved",
	"incident.escalated",
	"incident.reassigned",
	"incident.priority_updated",
] as const;
export const PAGERDUTY_IGNORED_EVENTS = ["service.updated"] as const;
export const PAGERDUTY_INCIDENT_KIND = "incident";

const PRIORITY_PATTERN = /^P?([1-5])$/i;

export type PagerDutyEventClassification =
	| { kind: "create"; eventType: string }
	| { kind: "update"; eventType: string }
	| { kind: "ignore"; eventType: string }
	| { kind: "invalid" };

/** Lowercase, whitespace-collapsed, redacted and capped (ellipsis counts). */
function boundText(value: string, maxChars: number): string {
	const normalized = redactPagerDutyText(value).replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Multi-line variant: preserves the field-per-line layout, caps only. */
function boundMultiline(value: string, maxChars: number): string {
	const normalized = redactPagerDutyText(value).trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function boundedComponent(value: string, maxChars: number): string {
	let sanitized = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		sanitized +=
			code <= 31 || code === 127 || character === ":" ? "_" : character;
	}
	return redactPagerDutyText(sanitized.trim()).slice(0, maxChars);
}

/**
 * Source-stable dedupe key: `pagerduty:<service-id>:<incident-id>`.
 *
 * Both ids are already template-validated; long values are truncated with a
 * digest suffix so two prefixes cannot silently merge two incidents.
 */
export function pagerDutyIncidentFingerprint(input: {
	serviceId: string;
	incidentId: string;
}): string {
	const serviceId = boundedComponent(input.serviceId, 64);
	const incidentId = boundedComponent(input.incidentId, 64);
	const full = `pagerduty:${serviceId}:${incidentId}`;
	if (full.length <= MAX_INCIDENT_FINGERPRINT_CHARS) return full;
	const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
	return `pagerduty:${serviceId.slice(0, 52)}:${incidentId.slice(
		0,
		52,
	)}~${digest}`;
}

/**
 * Severity table (docs/connectors/pagerduty.md §1), with `urgency` checked
 * first because a high-urgency incident is paging a human regardless of its
 * priority label:
 *
 *  - `urgency=high` or `P1` → `critical`
 *  - `P2` → `high`
 *  - `P3` or `urgency=low` → `medium`
 *  - `P4` / `P5` → `low`
 *  - no priority and no urgency → `medium`
 */
export function pagerDutySeverity(input: {
	urgency?: string | null;
	priorityName?: string | null;
}): IncidentSeverity {
	const urgency = nonEmpty(input.urgency)?.toLowerCase();
	const priorityName = nonEmpty(input.priorityName)?.toUpperCase();
	const match =
		priorityName === undefined ? null : PRIORITY_PATTERN.exec(priorityName);
	const priority = match?.[1] ?? null;

	if (urgency === "high") return "critical";
	if (priority === "1") return "critical";
	if (priority === "2") return "high";
	if (priority === "3" || urgency === "low") return "medium";
	if (priority === "4" || priority === "5") return "low";
	return "medium";
}

/** Classifies a v3 envelope without normalizing it. */
export function classifyPagerDutyEvent(
	payload: unknown,
): PagerDutyEventClassification {
	const parsed = pagerDutyWebhookEnvelopeSchema.safeParse(payload);
	if (!parsed.success) return { kind: "invalid" };
	const eventType = parsed.data.event.event_type;
	if (eventType === PAGERDUTY_TRIGGER_EVENT) {
		return { kind: "create", eventType };
	}
	if (
		(PAGERDUTY_UPDATE_EVENTS as readonly string[]).includes(eventType) ||
		(PAGERDUTY_IGNORED_EVENTS as readonly string[]).includes(eventType)
	) {
		return (PAGERDUTY_IGNORED_EVENTS as readonly string[]).includes(eventType)
			? { kind: "ignore", eventType }
			: { kind: "update", eventType };
	}
	return { kind: "invalid" };
}

function safeLink(
	label: string,
	url: string | null | undefined,
): { label: string; url: string } | null {
	if (url === null || url === undefined || !isBoundedHttpsUrl(url)) return null;
	return { label: boundText(label, 120), url };
}

function boundedLinks(
	candidates: ReadonlyArray<{ label: string; url: string | null | undefined }>,
): Array<{ label: string; url: string }> {
	const seen = new Set<string>();
	const links: Array<{ label: string; url: string }> = [];
	for (const candidate of candidates) {
		const link = safeLink(candidate.label, candidate.url);
		if (link === null || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

function receivedAtOf(receivedAt: string | undefined, fallbackMs: number) {
	if (typeof receivedAt === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(receivedAt);
		if (parsed.success) return parsed.data;
	}
	return new Date(fallbackMs).toISOString();
}

function buildSummary(
	incident: PagerDutyIncident,
	eventId: string,
	eventType: string,
	occurredAt: string,
	fingerprint: string,
): string {
	const lines = [
		`Event: ${eventType}`,
		`Provider event id: ${eventId} (traceability only)`,
		`Incident: ${incident.id}${incident.number === undefined ? "" : ` (#${incident.number})`}`,
		`Status: ${incident.status}`,
		`Urgency: ${nonEmpty(incident.urgency) ?? "not set"}`,
		`Priority: ${nonEmpty(incident.priority?.name) ?? "not set"}`,
		`Service: ${nonEmpty(incident.service.name) ?? incident.service.id} (${incident.service.id})`,
		...(nonEmpty(incident.created_at) === null
			? []
			: [`Created: ${incident.created_at}`]),
		`Occurred: ${occurredAt}`,
		`Dedupe: ${fingerprint} (source fingerprint, not the delivery id)`,
	];
	return boundMultiline(lines.join("\n"), MAX_INCIDENT_SUMMARY_CHARS);
}

/**
 * Normalizes one verified v3 delivery. Returns a signal only for
 * `incident.triggered`; every other event returns `null` (an update path must
 * update the existing incident, never create a second task).
 *
 * Pure: no clock, no network, no credential. `receivedAt` is trusted caller
 * input (ISO-8601) and only defaults to the wall clock when absent.
 */
export function normalizePagerDutyIncident(
	payload: unknown,
	receivedAt?: string,
): IncidentSignal | null {
	const classification = classifyPagerDutyEvent(payload);
	if (classification.kind !== "create") return null;

	const parsed = pagerDutyWebhookEnvelopeSchema.safeParse(payload);
	if (!parsed.success) return null;
	const event = parsed.data.event;
	const incident = event.data;

	const serviceId = incident.service.id;
	const fingerprint = pagerDutyIncidentFingerprint({
		serviceId,
		incidentId: incident.id,
	});
	const serviceName =
		nonEmpty(incident.service.name) ??
		serviceId.slice(0, MAX_INCIDENT_SERVICE_CHARS);
	const severity = pagerDutySeverity({
		urgency: incident.urgency,
		priorityName: incident.priority?.name,
	});
	const title = boundText(
		`PagerDuty incident: ${incident.title} (${serviceName})`,
		MAX_INCIDENT_TITLE_CHARS,
	);
	const boundedService = boundText(serviceName, MAX_INCIDENT_SERVICE_CHARS);
	const signal = {
		source: "pagerduty" as const,
		kind: PAGERDUTY_INCIDENT_KIND,
		severity,
		service:
			boundedService.length === 0
				? serviceId.slice(0, MAX_INCIDENT_SERVICE_CHARS)
				: boundedService,
		fingerprint,
		title:
			title.length === 0
				? `PagerDuty incident ${incident.id}`.slice(0, MAX_INCIDENT_TITLE_CHARS)
				: title,
		summary: buildSummary(
			incident,
			event.id,
			event.event_type,
			event.occurred_at,
			fingerprint,
		),
		links: boundedLinks([
			{ label: "PagerDuty incident", url: incident.html_url },
			{ label: "PagerDuty service", url: incident.service.html_url },
		]),
		receivedAt: receivedAtOf(receivedAt, Date.now()),
	};
	const validated = incidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}

/** Re-exported so a route can parse the incident resource without the envelope. */
export { pagerDutyIncidentSchema };
