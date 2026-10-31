import { createHash } from "node:crypto";
import {
	type IncidentLink,
	type IncidentSeverity,
	incidentSignalSchema,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINKS,
	MAX_INCIDENT_SERVICE_CHARS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactAxiomText } from "./redact";
import {
	type AxiomWebhookPayload,
	MAX_AXIOM_MONITOR_NAME_CHARS,
	parseAxiomWebhookPayload,
} from "./schemas";
import { isAxiomAlertFresh } from "./webhook";

/**
 * Axiom alert normalization (`docs/connectors/axiom.md` §4–§6).
 *
 * One strict, pinned webhook payload becomes at most one bounded
 * `IncidentSignal`:
 *
 * - only a `triggered` monitor action creates a task; `resolved`/`ok` create
 *   nothing, and an unrecognized action fails closed;
 * - the signal is dropped when its unsigned `timestamp` is outside the
 *   15-minute replay window (Axiom signs nothing, so age is the only replay
 *   control the receiver owns);
 * - severity comes from the payload's severity field (`critical`, `error`,
 *   `warning`, `info`/`low`) and defaults to `high` for a binary monitor;
 * - the fingerprint is source-stable:
 *   `axiom:<monitor-id>:<first24Hex(sha256(monitor|dataset|group|state))>`,
 *   so a redelivery dedupes while a different monitor, dataset, group or state
 *   does not. A delivery id is never part of it.
 *
 * The monitor read API path is UNVERIFIED, so this function uses only the
 * pinned payload. Provider text is untrusted and is redacted before bounding.
 */

export const AXIOM_INCIDENT_KIND = "monitor_alert";
/**
 * The shared enum does not yet contain `axiom` (contract change pending). This
 * schema is the shared contract with only `source` narrowed to the literal; the
 * coordinator must add `"axiom"` to `INCIDENT_SOURCES` before registration.
 */
export const axiomIncidentSignalSchema = incidentSignalSchema.extend({
	source: z.literal("axiom"),
});
export type AxiomIncidentSignal = z.output<typeof axiomIncidentSignalSchema>;

const TRIGGERED_ACTIONS: ReadonlySet<string> = new Set([
	"triggered",
	"trigger",
	"firing",
	"alert",
	"alerting",
]);
const RESOLVED_ACTIONS: ReadonlySet<string> = new Set([
	"resolved",
	"resolve",
	"recovered",
	"recovery",
	"ok",
	"normal",
]);

export type AxiomNormalizeOptions = {
	/** Receipt time from trusted code; defaults to the injected/wall clock. */
	receivedAt?: string;
	/** Trusted clock for the freshness check; defaults to wall clock. */
	nowMs?: number;
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
		: boundText(redactAxiomText(value), maxChars);
}

/**
 * Binary monitor severity. An explicit severity label wins; a triggered
 * threshold monitor without one is `high`, not `info`.
 */
export function axiomSeverityOf(
	value: string | null | undefined,
): IncidentSeverity {
	switch (nonEmpty(value)?.toLowerCase()) {
		case "critical":
		case "fatal":
			return "critical";
		case "error":
		case "high":
			return "high";
		case "warning":
		case "warn":
		case "medium":
			return "medium";
		case "info":
		case "low":
			return "low";
		default:
			return "high";
	}
}

/**
 * Source-stable dedupe key. The monitor id is kept readable up to 48 chars and
 * the stable subset (monitor, dataset, group, state) is hashed, so the result
 * always fits the shared 128-character fingerprint cap.
 */
export function axiomIncidentFingerprint(input: {
	monitorId: string;
	dataset: string;
	groupKey?: string | null;
	state?: string | null;
}): string {
	const monitorId = input.monitorId.trim();
	const digest = createHash("sha256")
		.update(
			[
				monitorId,
				input.dataset.trim(),
				input.groupKey?.trim() ?? "",
				input.state?.trim() ?? "",
			].join("|"),
		)
		.digest("hex")
		.slice(0, 24);
	const fingerprint = `axiom:${monitorId.slice(0, 48)}:${digest}`;
	return fingerprint.length <= MAX_INCIDENT_FINGERPRINT_CHARS
		? fingerprint
		: fingerprint.slice(0, MAX_INCIDENT_FINGERPRINT_CHARS);
}

function boundedLink(
	labelText: string,
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
	return { label: boundText(labelText, 120), url: safe };
}

function fieldOf(
	payload: AxiomWebhookPayload,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const direct = payload.fields?.[key];
		const found = nonEmpty(direct);
		if (found !== null) return found;
	}
	return null;
}

function serviceOf(payload: AxiomWebhookPayload): string {
	const candidate =
		nonEmpty(payload.service) ??
		fieldOf(payload, ["service", "app", "job", "container"]) ??
		nonEmpty(payload.monitor_name) ??
		"axiom";
	const service = safeText(candidate, MAX_INCIDENT_SERVICE_CHARS);
	return service.length > 0 ? service : "axiom";
}

function scalarText(
	value: AxiomWebhookPayload["value"] | AxiomWebhookPayload["threshold"],
): string | null {
	if (value === undefined) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(Number(value.toPrecision(8))) : null;
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	return safeText(value, 100) || null;
}

function incidentStateOf(
	payload: AxiomWebhookPayload,
): "triggered" | "resolved" | null {
	const action = payload.action.toLowerCase();
	const state = payload.state?.toLowerCase() ?? null;
	if (RESOLVED_ACTIONS.has(action)) return "resolved";
	if (!TRIGGERED_ACTIONS.has(action)) return null;
	return state !== null && RESOLVED_ACTIONS.has(state)
		? "resolved"
		: "triggered";
}

function receivedAtOf(options: AxiomNormalizeOptions, nowMs: number): string {
	const candidate = options.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date(nowMs).toISOString();
}

/**
 * Normalizes one webhook delivery or returns `null` when it must not create a
 * task: a resolved/unknown action, a stale or unparsable timestamp, or an
 * invalid/unknown-field payload. Pure: no network and no credential.
 */
export function normalizeAxiomIncident(
	payload: unknown,
	options: AxiomNormalizeOptions = {},
): AxiomIncidentSignal | null {
	const parsed = parseAxiomWebhookPayload(payload);
	if (parsed === null) return null;

	const nowMs = options.nowMs ?? Date.now();
	if (!Number.isFinite(nowMs)) return null;
	if (!isAxiomAlertFresh(parsed.timestamp, nowMs)) return null;

	const state = incidentStateOf(parsed);
	if (state !== "triggered") return null;

	const monitorName = nonEmpty(parsed.monitor_name);
	const service = serviceOf(parsed);
	const severity = axiomSeverityOf(parsed.severity);
	const environment = nonEmpty(parsed.environment);
	const group = nonEmpty(parsed.group);
	const value = scalarText(parsed.value);
	const threshold = scalarText(parsed.threshold);

	const summaryLines = [
		`Monitor: ${safeText(monitorName ?? parsed.monitor_id, 200)}`,
		`Monitor id: ${parsed.monitor_id}`,
		`Dataset: ${parsed.dataset}`,
		`Action: ${safeText(parsed.action, 32)}`,
		`State: ${state}`,
		`Severity: ${safeText(parsed.severity, 32) || "absent"} -> ${severity}`,
		`Service: ${service}`,
		...(environment === null
			? []
			: [`Environment: ${safeText(environment, 64)}`]),
		...(group === null ? [] : [`Group: ${safeText(group, 200)}`]),
		...(value === null ? [] : [`Value: ${value}`]),
		...(threshold === null ? [] : [`Threshold: ${threshold}`]),
		`Timestamp: ${parsed.timestamp}`,
	];

	const links: IncidentLink[] = [];
	const monitorLink = boundedLink("Monitor", parsed.url);
	if (monitorLink !== null) links.push(monitorLink);
	const runbookLink = boundedLink(
		"Runbook",
		fieldOf(parsed, ["runbook_url", "runbook"]),
	);
	if (
		runbookLink !== null &&
		!links.some((link) => link.url === runbookLink.url)
	) {
		links.push(runbookLink);
	}

	const signal = {
		source: "axiom" as const,
		kind: AXIOM_INCIDENT_KIND,
		severity,
		service,
		fingerprint: axiomIncidentFingerprint({
			monitorId: parsed.monitor_id,
			dataset: parsed.dataset,
			groupKey: group,
			state,
		}),
		title: boundText(
			`Axiom monitor "${safeText(monitorName ?? parsed.monitor_id, MAX_AXIOM_MONITOR_NAME_CHARS)}" triggered on ${service}`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundMultiline(
			redactAxiomText(summaryLines.join("\n")),
			MAX_INCIDENT_SUMMARY_CHARS,
		),
		links: links.slice(0, MAX_INCIDENT_LINKS),
		receivedAt: receivedAtOf(options, nowMs),
	};

	const validated = axiomIncidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
