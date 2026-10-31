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
import { redactSignozText } from "./redact";
import {
	parseSignozWebhookPayload,
	SIGNOZ_RULE_ID_PATTERN,
	type SignozAlert,
	type SignozWebhookPayload,
} from "./schemas";

/**
 * SigNoz alert normalization (`docs/connectors/signoz.md` §1/§4/§6).
 *
 * One verified delivery becomes at most one bounded signal:
 *
 * - only a `firing` alert creates a signal (`resolved` is not an incident);
 * - the highest-severity firing alert wins, with a deterministic tie-break by
 *   rule id, alert fingerprint, alert name and stable label text;
 * - the fingerprint is source-stable: `signoz:<rule-id>:<first16Hex>` over
 *   `rule-id | alertname | service | state | stable labels`. Volatile,
 *   high-cardinality labels (pod, instance, container, node, user id, trace
 *   id) are excluded, so pod churn does not create a second task while a
 *   different rule, service or state does;
 * - the rule id comes from trusted code or a documented label, never from the
 *   payload's top-level `fingerprint` (which is a delivery fingerprint);
 * - severity comes from the `severity`/`priority` label and the alert state.
 *
 * `source` is `"signoz"`, which is **not yet** in `INCIDENT_SOURCES`. This
 * module therefore returns `SignozIncidentSignal` (the shared signal minus
 * `source`, plus `source: "signoz"`). A contract commit must add `"signoz"` to
 * `packages/shared/src/types/incident.ts` before intake can consume it; until
 * then the type is local and the signal must not be submitted.
 */

export type SignozIncidentSignal = Omit<IncidentSignal, "source"> & {
	source: "signoz";
};

export const SIGNOZ_FIRING_INCIDENT_KIND = "alert_firing";

const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	info: 0,
};

/** Labels that change with workload churn rather than with the incident. */
const VOLATILE_LABEL_KEYS: ReadonlySet<string> = new Set([
	"instance",
	"pod",
	"pod_name",
	"podname",
	"container",
	"container_id",
	"container_name",
	"node",
	"host",
	"hostname",
	"host_name",
	"ip",
	"ip_address",
	"user_id",
	"userid",
	"trace_id",
	"span_id",
	"request_id",
	"url",
	"http_url",
]);

const MAX_STABLE_LABELS = 32;
const MAX_STABLE_LABEL_CHARS = 2048;

export type SignozNormalizeOptions = {
	/** Rule id from trusted code or a rule re-fetch; wins over label values. */
	ruleId?: string | null;
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
		: boundText(redactSignozText(value), maxChars);
}

function label(labels: Record<string, string>, key: string): string | null {
	for (const [name, value] of Object.entries(labels)) {
		if (name.toLowerCase() === key) return nonEmpty(value);
	}
	return null;
}

function firstLabel(
	labels: Record<string, string>,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = label(labels, key);
		if (value !== null) return value;
	}
	return null;
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

/**
 * Source-severity mapping. SigNoz has no first-class severity field, so the
 * `severity` (or `priority`) label is the documented carrier:
 *
 * `critical`/`fatal` → `critical`; `error`/`high` → `high`;
 * `warning`/`warn`/`medium` → `medium`; `low` → `low`;
 * `info`/`debug` → `info`; absent or unrecognized → `medium`.
 */
export function signozSeverityOf(
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
		case "low":
			return "low";
		case "info":
		case "debug":
			return "info";
		default:
			return "medium";
	}
}

/** Deterministic label subset used by the fingerprint. */
function stableLabelText(labels: Record<string, string>): string {
	const entries = Object.entries(labels)
		.filter(([key]) => !VOLATILE_LABEL_KEYS.has(key.toLowerCase()))
		.sort(([left], [right]) =>
			compareStrings(left.toLowerCase(), right.toLowerCase()),
		)
		.slice(0, MAX_STABLE_LABELS)
		.map(([key, value]) => `${key.toLowerCase()}=${value}`);
	return entries.join("|").slice(0, MAX_STABLE_LABEL_CHARS);
}

function anonRuleId(alertName: string, service: string): string {
	const digest = createHash("sha256")
		.update(`${alertName}|${service}`)
		.digest("hex")
		.slice(0, 16);
	return `anon-${digest}`;
}

/**
 * Source-stable dedupe key: `signoz:<rule-id>:<first16Hex>` where the digest
 * covers alert name, service, alert state and the stable label subset.
 */
export function signozIncidentFingerprint(input: {
	ruleId: string;
	alertName: string;
	service: string;
	state: string;
	labels?: Record<string, string>;
}): string {
	const ruleId = SIGNOZ_RULE_ID_PATTERN.test(input.ruleId)
		? input.ruleId
		: anonRuleId(input.alertName, input.service);
	const digest = createHash("sha256")
		.update(
			[
				ruleId,
				input.alertName.trim(),
				input.service.trim().toLowerCase(),
				input.state.trim().toLowerCase(),
				stableLabelText(input.labels ?? {}),
			].join("|"),
		)
		.digest("hex")
		.slice(0, 16);
	const fingerprint = `signoz:${ruleId}:${digest}`;
	return fingerprint.length <= MAX_INCIDENT_FINGERPRINT_CHARS
		? fingerprint
		: `signoz:${ruleId.slice(0, 64)}:${digest}`;
}

export function signozRuleIdOf(
	alert: SignozAlert,
	override: string | null | undefined,
): string {
	const trusted = nonEmpty(override);
	if (trusted !== null && SIGNOZ_RULE_ID_PATTERN.test(trusted)) return trusted;
	const fromLabels = firstLabel(alert.labels, [
		"rule_id",
		"ruleid",
		"signoz_rule_id",
		"__rule_id__",
	]);
	if (fromLabels !== null && SIGNOZ_RULE_ID_PATTERN.test(fromLabels)) {
		return fromLabels;
	}
	return anonRuleId(
		label(alert.labels, "alertname") ?? "unknown",
		serviceOf(alert),
	);
}

function serviceOf(alert: SignozAlert): string {
	const candidate =
		firstLabel(alert.labels, [
			"service.name",
			"service_name",
			"servicename",
			"service",
			"job",
			"app",
			"k8s.deployment.name",
			"alertname",
		]) ?? "signoz";
	return safeText(candidate, MAX_INCIDENT_SERVICE_CHARS) || "signoz";
}

function alertNameOf(alert: SignozAlert): string {
	return (
		firstLabel(alert.labels, ["alertname", "alert_name", "alertName"]) ??
		"unnamed alert"
	);
}

function alertStateOf(
	alert: SignozAlert,
	payload: SignozWebhookPayload,
): string {
	return alert.status ?? payload.status ?? "firing";
}

function boundedLink(
	labelText: string,
	url: string | null | undefined,
): IncidentLink | null {
	const candidate = nonEmpty(url);
	if (candidate === null || !isBoundedHttpsUrl(candidate)) return null;
	let safe = candidate;
	try {
		const parsed = new URL(candidate);
		// Drop query and fragment: they routinely carry tokens and PII.
		parsed.search = "";
		parsed.hash = "";
		safe = parsed.toString();
	} catch {
		return null;
	}
	if (!isBoundedHttpsUrl(safe)) return null;
	return { label: boundText(labelText, 120), url: safe };
}

function boundedLinks(alert: SignozAlert): IncidentLink[] {
	const annotations = alert.annotations ?? {};
	const seen = new Set<string>();
	const links: IncidentLink[] = [];
	for (const candidate of [
		{ label: "Alert", url: alert.generatorURL },
		{
			label: "Dashboard",
			url: firstLabel(alert.labels, ["dashboard_url", "dashboardurl"]),
		},
		{ label: "Runbook", url: nonEmpty(annotations.runbook_url) },
	]) {
		const link = boundedLink(candidate.label, candidate.url);
		if (link === null || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

function receivedAtOf(options: SignozNormalizeOptions): string {
	const candidate = options.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date().toISOString();
}

function selectedAlert(
	payload: SignozWebhookPayload,
	options: SignozNormalizeOptions,
): {
	alert: SignozAlert;
	ruleId: string;
	severity: IncidentSeverity;
	state: string;
} | null {
	const candidates = payload.alerts
		.filter((alert) => alertStateOf(alert, payload) === "firing")
		.map((alert) => {
			const ruleId = signozRuleIdOf(alert, options.ruleId);
			const severity = signozSeverityOf(
				firstLabel(alert.labels, ["severity", "priority"]),
			);
			return {
				alert,
				ruleId,
				severity,
				state: alertStateOf(alert, payload),
			};
		});
	if (candidates.length === 0) return null;
	candidates.sort((left, right) => {
		const bySeverity =
			SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
		if (bySeverity !== 0) return bySeverity;
		const byRule = compareStrings(left.ruleId, right.ruleId);
		if (byRule !== 0) return byRule;
		const byFingerprint = compareStrings(
			left.alert.fingerprint ?? "",
			right.alert.fingerprint ?? "",
		);
		if (byFingerprint !== 0) return byFingerprint;
		const byName = compareStrings(
			alertNameOf(left.alert),
			alertNameOf(right.alert),
		);
		if (byName !== 0) return byName;
		return compareStrings(
			stableLabelText(left.alert.labels),
			stableLabelText(right.alert.labels),
		);
	});
	return candidates[0] ?? null;
}

/**
 * Normalizes one verified SigNoz delivery, or returns `null` when it must not
 * create a task: invalid payload, no firing alert, or a resolved-only delivery.
 *
 * Pure: no network, no credential. `receivedAt` is supplied by trusted code or
 * defaults to the wall clock, never to a payload field.
 */
export function normalizeSignozIncident(
	payload: unknown,
	options: SignozNormalizeOptions = {},
): SignozIncidentSignal | null {
	const parsed = parseSignozWebhookPayload(payload);
	if (parsed === null) return null;

	const chosen = selectedAlert(parsed, options);
	if (chosen === null) return null;

	const alertName = alertNameOf(chosen.alert);
	const service = serviceOf(chosen.alert);
	const annotations = chosen.alert.annotations ?? {};
	const sourceSeverity =
		firstLabel(chosen.alert.labels, ["severity", "priority"])?.toLowerCase() ??
		"absent";
	const annotationSummary = nonEmpty(annotations.summary);
	const annotationDescription = nonEmpty(annotations.description);
	const runbook = nonEmpty(annotations.runbook_url);

	const summaryLines = [
		`Alert: ${safeText(alertName, 200)}`,
		`State: ${chosen.state}`,
		`Severity: ${sourceSeverity} -> ${chosen.severity}`,
		`Service: ${service}`,
		`Rule ID: ${chosen.ruleId}`,
		...(chosen.alert.startsAt === undefined
			? []
			: [`Started: ${chosen.alert.startsAt}`]),
		...(annotationSummary === null
			? []
			: [`Summary: ${safeText(annotationSummary, 600)}`]),
		...(annotationDescription === null
			? []
			: [`Description: ${safeText(annotationDescription, 800)}`]),
		...(runbook === null ? [] : [`Runbook: ${safeText(runbook, 200)}`]),
		...(parsed.truncatedAlerts === undefined || parsed.truncatedAlerts === 0
			? []
			: [`Delivery truncated: ${parsed.truncatedAlerts} alerts omitted`]),
	];

	const signalWithoutSource = {
		kind: SIGNOZ_FIRING_INCIDENT_KIND,
		severity: chosen.severity,
		service,
		fingerprint: signozIncidentFingerprint({
			ruleId: chosen.ruleId,
			alertName,
			service,
			state: chosen.state,
			labels: chosen.alert.labels,
		}),
		title: boundText(
			`SigNoz alert "${safeText(alertName, 120)}" firing on ${service}`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundMultiline(
			redactSignozText(summaryLines.join("\n")),
			MAX_INCIDENT_SUMMARY_CHARS,
		),
		links: boundedLinks(chosen.alert),
		receivedAt: receivedAtOf(options),
	};

	// The shared signal schema is validated without `source`; the local source
	// value is added after validation because `INCIDENT_SOURCES` lacks it.
	const validated = incidentSignalSchema
		.omit({ source: true })
		.safeParse(signalWithoutSource);
	if (!validated.success) return null;
	return { ...validated.data, source: "signoz" };
}
