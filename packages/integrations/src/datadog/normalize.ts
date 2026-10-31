import { createHash } from "node:crypto";
import {
	type IncidentLink,
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
import { redactDatadogText } from "./redact";
import {
	DATADOG_SERVICE_PATTERN,
	type DatadogPriority,
	parseDatadogWebhookAlert,
} from "./schemas";

/**
 * Datadog alert normalization (`docs/connectors/datadog.md` §1/§4).
 *
 * A delivery is a **hint**, not proof: the caller must verify it through the
 * signed bridge and re-fetch the monitor/incident by id before creating a
 * task. This function only maps bounded payload fields to one
 * `IncidentSignal`:
 *
 * - `P1` → `critical`, `P2` → `high`, `P3` → `medium`, `P4`/`P5` → `low`,
 *   absent → `medium` (fail closed, never silent `critical`);
 * - a `Recovered` transition creates nothing;
 * - the fingerprint is source-stable: `datadog:<monitor-id>:<first16hex>` over
 *   the sorted group tags, so a redelivery or a tag-order change dedupes while
 *   a different monitor or group does not;
 * - `service` comes from the `service:` tag; title and summary are redacted
 *   and bounded; links point at the monitor and dashboard, never at a payload
 *   URL that is not bounded https.
 */

export const DATADOG_TRIGGERED_INCIDENT_KIND = "alert_firing";

const SEVERITY_BY_PRIORITY: Readonly<
	Record<DatadogPriority, IncidentSeverity>
> = {
	P1: "critical",
	P2: "high",
	P3: "medium",
	P4: "low",
	P5: "low",
};

const SITE_PATH_PATTERN = /^[/]?$/;

export type DatadogNormalizeOptions = {
	/** Datadog app origin (`https://app.datadoghq.com`); display-only. */
	site?: string | null;
	/** Receipt time from trusted code; defaults to wall clock. */
	receivedAt?: string;
};

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function boundText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function boundMultiline(value: string, maxChars: number): string {
	const normalized = value.trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeText(value: string | null | undefined, maxChars: number): string {
	return value === null || value === undefined
		? ""
		: boundText(redactDatadogText(value), maxChars);
}

/**
 * Source-severity mapping (`docs/connectors/datadog.md` §4, task W17):
 * `P1` → `critical`, `P2` → `high`, `P3` → `medium`, `P4`/`P5` → `low`,
 * absent/unknown → `medium`.
 */
export function datadogSeverityOf(
	value: string | null | undefined,
): IncidentSeverity {
	const priority = nonEmpty(value)?.toUpperCase();
	if (priority === "P1") return SEVERITY_BY_PRIORITY.P1;
	if (priority === "P2") return SEVERITY_BY_PRIORITY.P2;
	if (priority === "P3") return SEVERITY_BY_PRIORITY.P3;
	if (priority === "P4") return SEVERITY_BY_PRIORITY.P4;
	if (priority === "P5") return SEVERITY_BY_PRIORITY.P5;
	return "medium";
}

/** First `service:` tag value that matches the identifier pattern. */
export function datadogServiceFromTags(tags: readonly string[]): string {
	for (const tag of tags) {
		const separator = tag.indexOf(":");
		if (separator <= 0) continue;
		if (tag.slice(0, separator).trim().toLowerCase() !== "service") continue;
		const candidate = tag.slice(separator + 1).trim();
		if (DATADOG_SERVICE_PATTERN.test(candidate)) return candidate;
		const sanitized = candidate
			.replace(/[^A-Za-z0-9._/-]/g, "_")
			.slice(0, MAX_INCIDENT_SERVICE_CHARS);
		if (DATADOG_SERVICE_PATTERN.test(sanitized)) return sanitized;
	}
	return "datadog";
}

/**
 * Source-stable dedupe key:
 * `datadog:<monitor-id>:<first16hex(sha256(sorted group tags))>`.
 * Tag order and delivery id do not change it; monitor id or group tags do.
 */
export function datadogIncidentFingerprint(input: {
	monitorId: string;
	tags: readonly string[];
}): string {
	const monitorId = nonEmpty(input.monitorId) ?? "unknown";
	const group = [...input.tags]
		.map((tag) => tag.trim().toLowerCase())
		.filter((tag) => tag.length > 0)
		.sort()
		.join("|");
	const digest = createHash("sha256").update(group).digest("hex").slice(0, 16);
	const fingerprint = `datadog:${monitorId.slice(0, 64)}:${digest}`;
	return fingerprint.length <= MAX_INCIDENT_FINGERPRINT_CHARS
		? fingerprint
		: `datadog:${digest}`;
}

function siteOrigin(value: string | null | undefined): string | null {
	const candidate = nonEmpty(value);
	if (candidate === null || !isBoundedHttpsUrl(candidate)) return null;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" || !SITE_PATH_PATTERN.test(url.pathname)) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

function boundedLink(
	label: string,
	url: string | null | undefined,
): IncidentLink | null {
	if (url === null || url === undefined || !isBoundedHttpsUrl(url)) return null;
	let safe: string;
	try {
		const parsed = new URL(url);
		parsed.search = "";
		parsed.hash = "";
		safe = parsed.toString();
	} catch {
		return null;
	}
	return { label: boundText(label, 120), url: safe };
}

function boundedLinks(
	candidates: ReadonlyArray<{ label: string; url: string | null | undefined }>,
): IncidentLink[] {
	const seen = new Set<string>();
	const links: IncidentLink[] = [];
	for (const candidate of candidates) {
		const link = boundedLink(candidate.label, candidate.url);
		if (link === null || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

function receivedAtOf(options: DatadogNormalizeOptions): string {
	const candidate = options.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date().toISOString();
}

function happenedAtText(ms: number | null): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	const date = new Date(ms);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nonTriggeringTransition(value: string | null): boolean {
	const transition = nonEmpty(value)?.toLowerCase();
	return transition === "recovered";
}

/**
 * Normalizes one webhook/raw alert delivery, or returns `null` when it cannot
 * create a task: invalid/oversized payload, an unknown template field, a
 * missing id/title, or a `Recovered` transition.
 *
 * Pure: no network, no credential. `receivedAt` is trusted code's clock, never
 * a payload field.
 */
export function normalizeDatadogIncident(
	payload: unknown,
	options: DatadogNormalizeOptions = {},
): IncidentSignal | null {
	const alert = parseDatadogWebhookAlert(payload);
	if (alert === null) return null;
	if (nonTriggeringTransition(alert.alertTransition)) return null;

	const service = datadogServiceFromTags(alert.tags);
	const severity = datadogSeverityOf(alert.priority);
	const monitorId = alert.monitorId ?? alert.incidentId ?? alert.id;
	const sourcePriority = alert.priority ?? "absent";
	const alertType = nonEmpty(alert.alertType);
	const transition = nonEmpty(alert.alertTransition);
	const happenedAt = happenedAtText(alert.dateHappenedMs);
	const site = siteOrigin(options.site);
	const monitorUrl =
		site === null ? null : `${site}/monitors/${encodeURIComponent(monitorId)}`;
	const tagText = alert.tags
		.slice(0, 12)
		.map((tag) => boundText(redactDatadogText(tag), 80))
		.join(", ");

	const summaryLines = [
		`Alert: ${safeText(alert.title, 300)}`,
		`Priority: ${sourcePriority} -> ${severity}`,
		...(transition === null ? [] : [`Transition: ${safeText(transition, 64)}`]),
		...(alertType === null ? [] : [`Type: ${safeText(alertType, 64)}`]),
		`Monitor/incident id: ${boundText(monitorId, 64)}`,
		`Service: ${service}`,
		...(alert.org === null ? [] : [`Org: ${safeText(alert.org, 128)}`]),
		...(happenedAt === null ? [] : [`Happened: ${happenedAt}`]),
		...(tagText === "" ? [] : [`Tags: ${tagText}`]),
	];

	const signal = {
		source: "datadog" as const,
		kind: DATADOG_TRIGGERED_INCIDENT_KIND,
		severity,
		service,
		fingerprint: datadogIncidentFingerprint({ monitorId, tags: alert.tags }),
		title: boundText(
			`Datadog ${alertType ?? "alert"} on ${service}: ${safeText(
				alert.title,
				120,
			)}`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundMultiline(
			redactDatadogText(summaryLines.join("\n")),
			MAX_INCIDENT_SUMMARY_CHARS,
		),
		links: boundedLinks([
			{ label: "Monitor", url: monitorUrl },
			{ label: "Dashboard", url: alert.dashboardUrl },
			{ label: "Event", url: alert.url },
		]),
		receivedAt: receivedAtOf(options),
	};

	const validated = incidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
