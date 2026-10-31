import { createHash } from "node:crypto";
import {
	type IncidentLink,
	type IncidentSeverity,
	type IncidentSignal,
	incidentSignalSchema,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINK_LABEL_CHARS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactSentryText } from "./redact";
import { type SentryLevel, sentryIssueWebhookSchema } from "./schemas";
import type { SentryIncidentDelivery } from "./types";

/**
 * Sentry incident normalization (docs/connectors/sentry.md §1).
 *
 * Only `issue` webhooks with action `created` or `unresolved` are incidents;
 * `resolved`, `assigned` and `archived` are lifecycle updates. Everything is
 * composed from allowlisted fields — never request data, breadcrumbs, user
 * objects or free-form provider text — and provider strings are redacted
 * before they reach a signal.
 *
 * The fingerprint is source-stable (`sentry:<org>:<project>:<issue>`) so a
 * redelivery or a regression of the same issue dedupes; delivery ids are
 * traceability only.
 */

export const SENTRY_ISSUE_CREATED_KIND = "issue_created";
export const SENTRY_ISSUE_UNRESOLVED_KIND = "issue_unresolved";

const TRIGGERING_ACTIONS: ReadonlySet<string> = new Set([
	"created",
	"unresolved",
]);

const SEVERITY_BY_LEVEL: Readonly<Record<SentryLevel, IncidentSeverity>> = {
	fatal: "critical",
	error: "high",
	warning: "medium",
	info: "low",
	debug: "info",
};

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** Single-line provider text; newlines cannot pose as a new summary field. */
function lineValue(value: string | null | undefined): string | null {
	const normalized = nonEmpty(value);
	return normalized === null ? null : normalized.replace(/[\r\n]+/g, " ");
}

function boundText(value: string, maxChars: number): string {
	return value.length <= maxChars
		? value
		: `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundedComponent(value: string, maxChars: number): string {
	let sanitized = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		sanitized +=
			code <= 31 || code === 127 || character === ":" ? "_" : character;
	}
	sanitized = sanitized.trim();
	return sanitized.length <= maxChars
		? sanitized
		: sanitized.slice(0, maxChars);
}

/** The exact severity table from the connector spec, including the default. */
export function sentryIncidentSeverity(
	level: SentryLevel | null | undefined,
): IncidentSeverity {
	return level === null || level === undefined
		? "high"
		: SEVERITY_BY_LEVEL[level];
}

/**
 * Source-stable dedupe key: `sentry:<org-slug>:<project-id>:<issue-id>`.
 *
 * Long components are truncated and suffixed with a digest of the full value,
 * so two long prefixes cannot silently merge two different incidents.
 */
export function sentryIncidentFingerprint(input: {
	orgSlug: string;
	projectId: string;
	issueId: string;
}): string {
	const org = boundedComponent(input.orgSlug, 40);
	const project = boundedComponent(input.projectId, 40);
	const issue = boundedComponent(input.issueId, 40);
	const full = `sentry:${org}:${project}:${issue}`;
	if (full.length <= MAX_INCIDENT_FINGERPRINT_CHARS) return full;

	const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
	return `sentry:${org.slice(0, 35)}:${project.slice(0, 35)}:${issue.slice(
		0,
		31,
	)}~${digest}`;
}

function receivedAtOf(
	delivery: SentryIncidentDelivery,
	fallbackMs: number,
): string {
	const candidate = delivery.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date(fallbackMs).toISOString();
}

function boundedLink(label: string, url: string | null | undefined) {
	if (url === null || url === undefined || !isBoundedHttpsUrl(url)) return null;
	return {
		label: boundText(redactSentryText(label), MAX_INCIDENT_LINK_LABEL_CHARS),
		url,
	};
}

/**
 * Normalizes one webhook payload, or returns `null` when it is not a
 * triggering incident (unsupported action, missing organization/project,
 * malformed envelope).
 *
 * Pure: no clock, no network, no credential. `receivedAt` is supplied by the
 * trusted caller and only defaults to `Date.now()` when absent.
 */
export function normalizeSentryIncident(
	payload: unknown,
	delivery: SentryIncidentDelivery = {},
): IncidentSignal | null {
	const parsed = sentryIssueWebhookSchema.safeParse(payload);
	if (!parsed.success) return null;
	const data = parsed.data;
	if (!TRIGGERING_ACTIONS.has(data.action)) return null;

	const issue = data.issue;
	const orgSlug = nonEmpty(data.organization?.slug);
	const projectSlug =
		nonEmpty(data.project?.slug) ?? nonEmpty(issue.project?.slug);
	if (orgSlug === null || projectSlug === null) return null;
	const projectId = data.project?.id ?? issue.project?.id ?? projectSlug;

	const receivedAt = receivedAtOf(delivery, Date.now());
	const level = issue.level ?? null;
	const kind =
		data.action === "created"
			? SENTRY_ISSUE_CREATED_KIND
			: SENTRY_ISSUE_UNRESOLVED_KIND;

	const rawTitle =
		lineValue(issue.title) ??
		lineValue(issue.metadata?.value) ??
		`Issue ${lineValue(issue.shortId) ?? issue.id}`;
	const title = boundText(redactSentryText(rawTitle), MAX_INCIDENT_TITLE_CHARS);
	if (title.length === 0) return null;

	const summaryLines = [
		`Action: ${data.action}`,
		`Issue: ${lineValue(issue.shortId) ?? issue.id}`,
		`Sentry level: ${level ?? "error"}`,
		`Status: ${lineValue(issue.status) ?? "unknown"}`,
		`Project: ${projectSlug}`,
		`Organization: ${orgSlug}`,
		`Culprit: ${lineValue(issue.culprit) ?? "unknown"}`,
		`Count: ${issue.count === undefined ? "unknown" : String(issue.count)}`,
		`First seen: ${lineValue(issue.firstSeen) ?? "unknown"}`,
		`Last seen: ${lineValue(issue.lastSeen) ?? "unknown"}`,
		`Error: ${lineValue(issue.metadata?.value) ?? "unknown"}`,
		`Location: ${lineValue(issue.metadata?.filename) ?? "unknown"}`,
	];
	if (delivery.deliveryId !== undefined) {
		summaryLines.push(`Delivery: ${lineValue(delivery.deliveryId) ?? ""}`);
	}
	const summary = boundText(
		redactSentryText(summaryLines.join("\n")),
		MAX_INCIDENT_SUMMARY_CHARS,
	);

	const links: IncidentLink[] = [];
	const permalink = boundedLink("Sentry issue", issue.permalink);
	if (permalink !== null) links.push(permalink);

	const signal = {
		source: "sentry" as const,
		kind,
		severity: sentryIncidentSeverity(level),
		service: redactSentryText(projectSlug).slice(0, 128),
		fingerprint: sentryIncidentFingerprint({
			orgSlug,
			projectId,
			issueId: issue.id,
		}),
		title,
		summary,
		links,
		receivedAt,
	};
	const validated = incidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
