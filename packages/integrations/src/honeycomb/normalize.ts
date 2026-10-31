import { createHash } from "node:crypto";
import {
	type IncidentLink,
	type IncidentSeverity,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINK_LABEL_CHARS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactHoneycombText } from "./redact";
import {
	HONEYCOMB_TRIGGERING_STATES,
	type HoneycombAlertState,
	type HoneycombIncidentSignal,
	type HoneycombThreshold,
	honeycombIncidentSignalSchema,
	honeycombTriggerWebhookSchema,
} from "./schemas";
import type { HoneycombIncidentDelivery } from "./types";

/**
 * Honeycomb trigger normalization (`docs/connectors/honeycomb.md` §4).
 *
 * One verified delivery becomes one bounded `IncidentSignal`. Only
 * allowlisted fields are composed into the signal: dataset, service name,
 * trigger identity/state/threshold, the observed value and display-only links.
 * Recipient lists, trigger descriptions, raw result groups and free-form
 * provider text never enter the signal.
 *
 * Severity follows status first, then the threshold breach: a `critical`
 * state is critical; a warning is medium; `triggered`/`firing` is high unless
 * the observed value crosses the threshold by at least 2x (or falls to at most
 * half for a lower-bound threshold), which is critical. `ok`, `resolved` and
 * `recovered` are lifecycle updates, not incidents.
 *
 * The fingerprint is source-stable
 * (`honeycomb:<dataset>:<trigger-id>:<alert-state>`), so a redelivery or a
 * repeated breach of the same trigger dedupes; the delivery id is
 * traceability only. A timestamp older than 15 minutes is rejected.
 */

export const HONEYCOMB_TRIGGER_INCIDENT_KIND = "trigger_triggered";
export const HONEYCOMB_ALERT_MAX_AGE_MS = 15 * 60 * 1000;
export const HONEYCOMB_ALERT_MAX_FUTURE_MS = 5 * 60 * 1000;

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

function safeText(value: string | null | undefined): string {
	return redactHoneycombText(lineValue(value) ?? "");
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

function crossedThresholdTwice(input: {
	threshold: HoneycombThreshold;
	observed: number;
}): boolean {
	const { op, value } = input.threshold;
	if (!(value > 0)) return false;
	if (op === ">" || op === ">=") return input.observed >= value * 2;
	return input.observed <= value / 2;
}

/** Severity from trigger state, refined by the fixed threshold rule. */
export function honeycombIncidentSeverity(input: {
	state: HoneycombAlertState;
	threshold?: HoneycombThreshold;
	observed?: number;
}): IncidentSeverity | null {
	if (!HONEYCOMB_TRIGGERING_STATES.has(input.state)) return null;
	if (input.state === "warning") return "medium";
	if (input.state === "critical") return "critical";
	if (
		input.threshold !== undefined &&
		input.observed !== undefined &&
		crossedThresholdTwice({
			threshold: input.threshold,
			observed: input.observed,
		})
	) {
		return "critical";
	}
	return "high";
}

/**
 * Source-stable dedupe key:
 * `honeycomb:<dataset>:<trigger-id>:<alert-state>`.
 *
 * Long components are truncated and suffixed with a digest of the full value,
 * so two long prefixes cannot silently merge two different incidents.
 */
export function honeycombIncidentFingerprint(input: {
	dataset: string;
	triggerId: string;
	state: HoneycombAlertState;
}): string {
	const dataset = boundedComponent(input.dataset, 64);
	const trigger = boundedComponent(input.triggerId, 64);
	const state = boundedComponent(input.state, 16);
	const full = `honeycomb:${dataset}:${trigger}:${state}`;
	if (full.length <= MAX_INCIDENT_FINGERPRINT_CHARS) return full;

	const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
	return `honeycomb:${dataset.slice(0, 34)}:${trigger.slice(0, 34)}:${state.slice(
		0,
		16,
	)}~${digest}`;
}

function receivedAtOf(
	delivery: HoneycombIncidentDelivery,
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
		label: boundText(redactHoneycombText(label), MAX_INCIDENT_LINK_LABEL_CHARS),
		url,
	};
}

/**
 * Normalizes one delivery, or returns `null` when it is not a triggering
 * incident (resolved/ok state, stale or future timestamp, malformed envelope,
 * unknown fields).
 *
 * Pure: no clock beyond the injected `nowMs`, no network, no credential.
 */
export function normalizeHoneycombIncident(
	payload: unknown,
	delivery: HoneycombIncidentDelivery = {},
): HoneycombIncidentSignal | null {
	const parsed = honeycombTriggerWebhookSchema.safeParse(payload);
	if (!parsed.success) return null;
	const data = parsed.data;

	const state = data.alert?.state ?? data.trigger.state;
	if (!HONEYCOMB_TRIGGERING_STATES.has(state)) return null;

	const timestamp = data.alert?.timestamp ?? data.timestamp;
	if (timestamp === undefined) return null;
	const timestampMs = Date.parse(timestamp);
	if (!Number.isFinite(timestampMs)) return null;
	const fallbackNow = delivery.nowMs ?? Date.now();
	const receivedAtMs =
		typeof delivery.receivedAt === "string"
			? Date.parse(delivery.receivedAt)
			: fallbackNow;
	const nowMs = Number.isFinite(receivedAtMs) ? receivedAtMs : fallbackNow;
	if (nowMs - timestampMs > HONEYCOMB_ALERT_MAX_AGE_MS) return null;
	if (timestampMs - nowMs > HONEYCOMB_ALERT_MAX_FUTURE_MS) return null;

	const observed = data.result?.value;
	const severity = honeycombIncidentSeverity({
		state,
		threshold: data.trigger.threshold,
		observed,
	});
	if (severity === null) return null;

	const triggerName = safeText(data.trigger.name);
	const service = safeText(data.service.name);
	if (triggerName.length === 0 || service.length === 0) return null;

	const threshold = data.trigger.threshold;
	const summaryLines = [
		`State: ${state}`,
		`Dataset: ${safeText(data.dataset)}`,
		`Trigger: ${safeText(data.trigger.id)} (${triggerName})`,
		`Service: ${service}`,
	];
	const environment = safeText(data.environment);
	if (environment.length > 0) summaryLines.push(`Environment: ${environment}`);
	if (threshold !== undefined) {
		summaryLines.push(`Threshold: ${threshold.op} ${threshold.value}`);
	}
	if (observed !== undefined) summaryLines.push(`Observed: ${observed}`);
	const alertId = safeText(data.alert?.id);
	if (alertId.length > 0) summaryLines.push(`Alert: ${alertId}`);
	if (delivery.deliveryId !== undefined) {
		summaryLines.push(`Delivery: ${safeText(delivery.deliveryId)}`);
	}

	const links: IncidentLink[] = [];
	const triggerLink = boundedLink("Honeycomb trigger", data.trigger.url);
	if (triggerLink !== null) links.push(triggerLink);
	const alertLink = boundedLink("Honeycomb alert", data.alert?.url);
	if (alertLink !== null) links.push(alertLink);

	const signal = {
		source: "honeycomb" as const,
		kind: HONEYCOMB_TRIGGER_INCIDENT_KIND,
		severity,
		service,
		fingerprint: honeycombIncidentFingerprint({
			dataset: data.dataset,
			triggerId: data.trigger.id,
			state,
		}),
		title: boundText(
			`Honeycomb trigger "${triggerName}" ${state} on ${service} (${data.dataset})`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundText(summaryLines.join("\n"), MAX_INCIDENT_SUMMARY_CHARS),
		links,
		receivedAt: receivedAtOf(delivery, nowMs),
	};
	const validated = honeycombIncidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
