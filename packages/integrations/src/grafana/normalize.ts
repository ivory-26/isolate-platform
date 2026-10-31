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
import { redactGrafanaText } from "./redact";
import {
	GRAFANA_UID_PATTERN,
	type GrafanaAlert,
	parseGrafanaAlertGroup,
} from "./schemas";

/**
 * Grafana alert normalization (`docs/connectors/grafana.md` §1/§4).
 *
 * One verified alert group becomes at most one bounded `IncidentSignal`:
 *
 * - only a `firing` alert in a **production** group creates a task;
 * - the highest-severity firing alert wins, with a deterministic tie-break by
 *   rule UID, alert fingerprint, alert name and stable label text;
 * - `resolved`, `DatasourceNoData` and `info`/`low` groups create nothing;
 * - the fingerprint is source-stable: `grafana:<ruleUID>:<first16Hex>` over
 *   `alertname|service|environment`, so a redelivery or a label-churn replay
 *   dedupes while a different rule, service or environment does not.
 *
 * The rule UID comes from trusted code or the `generatorURL` path, never from
 * `groupKey` (it changes with grouping) and never from `alerts[].fingerprint`
 * alone. `generatorURL` is parsed, never fetched.
 */

export const GRAFANA_FIRING_INCIDENT_KIND = "alert_firing";
export const GRAFANA_RESOLVED_INCIDENT_KIND = "alert_resolved";
export const GRAFANA_NODATA_INCIDENT_KIND = "alert_nodata";
/** Source-declared production environments; everything else is non-prod. */
export const GRAFANA_PRODUCTION_ENVIRONMENTS = ["production", "prod"] as const;
const NODATA_ALERTNAME_PREFIX = "DatasourceNoData";

const SEVERITY_RANK: Readonly<Record<IncidentSeverity, number>> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	info: 0,
};

export type GrafanaNormalizeOptions = {
	/** UID from provisioning or a trusted rule lookup; wins over the URL. */
	ruleUid?: string | null;
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
		: `${normalized.slice(0, maxChars - 1)}…`;
}

/** Preserves the field-per-line summary layout while enforcing the cap. */
function boundMultiline(value: string, maxChars: number): string {
	const normalized = value.trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, maxChars - 1)}…`;
}

function safeText(value: string | null | undefined, maxChars: number): string {
	return value === null || value === undefined
		? ""
		: boundText(redactGrafanaText(value), maxChars);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function label(labels: Record<string, string>, key: string): string | null {
	for (const [name, value] of Object.entries(labels)) {
		if (name.toLowerCase() === key) return nonEmpty(value);
	}
	return null;
}

function environmentOf(labels: Record<string, string>): string | null {
	return (
		label(labels, "environment") ??
		label(labels, "env") ??
		label(labels, "deployment_environment")
	);
}

/**
 * True only for a source-declared production environment. There is no
 * default: an absent environment is non-production, so the normalizer fails
 * closed rather than creating a task from an unlabelled alert.
 */
export function isGrafanaProductionEnvironment(
	environment: string | null | undefined,
): boolean {
	const value = nonEmpty(environment)?.toLowerCase();
	return (
		value !== null &&
		value !== undefined &&
		(GRAFANA_PRODUCTION_ENVIRONMENTS as readonly string[]).includes(value)
	);
}

/**
 * Source-severity mapping (`docs/connectors/grafana.md` §1, task W16):
 * `critical` → `critical`, `error` → `high`, `warning` → `medium`,
 * `info`/`low` → `low`, absent → `medium`. `low` never creates a task.
 */
export function grafanaSeverityOf(
	value: string | null | undefined,
): IncidentSeverity {
	switch (nonEmpty(value)?.toLowerCase()) {
		case "critical":
			return "critical";
		case "error":
			return "high";
		case "warning":
			return "medium";
		case "info":
		case "low":
			return "low";
		default:
			return "medium";
	}
}

/**
 * Extracts a rule UID from a display-only `generatorURL` path:
 * `/alerting/grafana/<uid>/view`, `/alerting/rule/<uid>`, or a `ruleUID`
 * query parameter. The URL is parsed only; it is never fetched and may point
 * at an internal host.
 */
export function grafanaRuleUidFromGeneratorUrl(
	value: string | null | undefined,
): string | null {
	const candidate = nonEmpty(value);
	if (candidate === null || candidate.length > 2048) return null;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	const pathMatch = url.pathname.match(
		/\/alerting\/(?:grafana|rule|rules)\/([A-Za-z0-9_-]{1,64})(?:\/|$)/,
	);
	if (pathMatch?.[1] !== undefined && GRAFANA_UID_PATTERN.test(pathMatch[1])) {
		return pathMatch[1];
	}
	for (const key of ["ruleUID", "ruleUid", "rule_uid"]) {
		const query = nonEmpty(url.searchParams.get(key));
		if (query !== null && GRAFANA_UID_PATTERN.test(query)) return query;
	}
	return null;
}

function anonRuleUid(alertname: string, environment: string): string {
	const digest = createHash("sha256")
		.update(`${alertname}|${environment}`)
		.digest("hex")
		.slice(0, 16);
	return `anon-${digest}`;
}

/**
 * Source-stable dedupe key:
 * `grafana:<ruleUID>:<first16Hex(sha256(alertname|service|environment))>`.
 * Label churn outside that stable subset does not change it.
 */
export function grafanaIncidentFingerprint(input: {
	ruleUid: string;
	alertname: string;
	service: string;
	environment: string;
}): string {
	const ruleUid = GRAFANA_UID_PATTERN.test(input.ruleUid)
		? input.ruleUid
		: anonRuleUid(input.alertname, input.environment);
	const digest = createHash("sha256")
		.update(
			`${input.alertname.trim()}|${input.service.trim()}|${input.environment
				.trim()
				.toLowerCase()}`,
		)
		.digest("hex")
		.slice(0, 16);
	const fingerprint = `grafana:${ruleUid}:${digest}`;
	return fingerprint.length <= MAX_INCIDENT_FINGERPRINT_CHARS
		? fingerprint
		: `grafana:${ruleUid.slice(0, 64)}:${digest}`;
}

function boundedLink(
	labelText: string,
	url: string | null | undefined,
	keepQuery = false,
): IncidentLink | null {
	if (url === null || url === undefined || !isBoundedHttpsUrl(url)) return null;
	let safe = url;
	try {
		const parsed = new URL(url);
		if (keepQuery) {
			for (const key of [...parsed.searchParams.keys()]) {
				if (/token|secret|password|passwd|auth|api[_-]?key|sig/i.test(key)) {
					parsed.searchParams.delete(key);
				}
			}
		} else {
			parsed.search = "";
		}
		parsed.hash = "";
		safe = parsed.toString();
	} catch {
		return null;
	}
	return { label: boundText(labelText, 120), url: safe };
}

function boundedLinks(
	candidates: ReadonlyArray<{
		label: string;
		url: string | null | undefined;
		keepQuery?: boolean;
	}>,
): IncidentLink[] {
	const seen = new Set<string>();
	const links: IncidentLink[] = [];
	for (const candidate of candidates) {
		const link = boundedLink(
			candidate.label,
			candidate.url,
			candidate.keepQuery === true,
		);
		if (link === null || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

function ruleUidOf(
	alert: GrafanaAlert,
	override: string | null | undefined,
	environment: string,
): string {
	const trusted = nonEmpty(override);
	if (trusted !== null && GRAFANA_UID_PATTERN.test(trusted)) return trusted;
	const fromLabel = label(alert.labels, "__rule_uid__");
	if (fromLabel !== null && GRAFANA_UID_PATTERN.test(fromLabel)) {
		return fromLabel;
	}
	return (
		grafanaRuleUidFromGeneratorUrl(alert.generatorURL) ??
		anonRuleUid(label(alert.labels, "alertname") ?? "unknown", environment)
	);
}

function serviceOf(alert: GrafanaAlert): string {
	const candidate =
		label(alert.labels, "service") ??
		label(alert.labels, "job") ??
		label(alert.labels, "app") ??
		label(alert.labels, "alertname") ??
		"grafana";
	return safeText(candidate, MAX_INCIDENT_SERVICE_CHARS) || "grafana";
}

function stableLabelText(alert: GrafanaAlert): string {
	return [label(alert.labels, "alertname") ?? "", serviceOf(alert)]
		.map((value) => value.toLowerCase())
		.join("|");
}

function receivedAtOf(options: GrafanaNormalizeOptions): string {
	const candidate = options.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date().toISOString();
}

function selectedAlert(
	alerts: readonly GrafanaAlert[],
	options: GrafanaNormalizeOptions,
): { alert: GrafanaAlert; ruleUid: string; severity: IncidentSeverity } | null {
	const candidates = alerts
		.filter((alert) => (alert.status ?? "firing") === "firing")
		.filter((alert) =>
			isGrafanaProductionEnvironment(environmentOf(alert.labels)),
		)
		.filter((alert) => {
			const alertname = label(alert.labels, "alertname");
			return (
				alertname !== null && !alertname.startsWith(NODATA_ALERTNAME_PREFIX)
			);
		})
		.map((alert) => {
			const environment = environmentOf(alert.labels) ?? "";
			const ruleUid = ruleUidOf(alert, options.ruleUid, environment);
			const severity = grafanaSeverityOf(label(alert.labels, "severity"));
			return { alert, ruleUid, severity };
		});
	if (candidates.length === 0) return null;
	candidates.sort((left, right) => {
		const bySeverity =
			SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
		if (bySeverity !== 0) return bySeverity;
		const byRule = compareStrings(left.ruleUid, right.ruleUid);
		if (byRule !== 0) return byRule;
		const byFingerprint = compareStrings(
			left.alert.fingerprint ?? "",
			right.alert.fingerprint ?? "",
		);
		if (byFingerprint !== 0) return byFingerprint;
		const byName = compareStrings(
			label(left.alert.labels, "alertname") ?? "",
			label(right.alert.labels, "alertname") ?? "",
		);
		if (byName !== 0) return byName;
		return compareStrings(
			stableLabelText(left.alert),
			stableLabelText(right.alert),
		);
	});
	const best = candidates[0];
	return best === undefined ? null : best;
}

/**
 * Normalizes one verified Grafana alert group, or returns `null` when it must
 * not create a task: `resolved`, no firing alert, `DatasourceNoData`, a
 * non-production environment, `info`/`low` severity, or an invalid payload.
 *
 * Pure: no network, no credential. `receivedAt` is supplied by trusted code or
 * defaults to the wall clock, never to a payload field.
 */
export function normalizeGrafanaIncident(
	payload: unknown,
	options: GrafanaNormalizeOptions = {},
): IncidentSignal | null {
	const group = parseGrafanaAlertGroup(payload);
	if (group === null) return null;
	if (group.status === "resolved") return null;

	const chosen = selectedAlert(group.alerts, options);
	if (chosen === null) return null;
	if (chosen.severity === "low") return null;

	const labels = chosen.alert.labels;
	const alertname = label(labels, "alertname");
	const environment = environmentOf(labels);
	if (alertname === null || !isGrafanaProductionEnvironment(environment)) {
		return null;
	}
	if (alertname.startsWith(NODATA_ALERTNAME_PREFIX)) return null;

	const service = serviceOf(chosen.alert);
	const sourceSeverity = label(labels, "severity")?.toLowerCase() ?? "absent";
	const annotations = chosen.alert.annotations ?? {};
	const annotationSummary = nonEmpty(annotations.summary);
	const annotationDescription = nonEmpty(annotations.description);
	const runbook = nonEmpty(annotations.runbook_url);

	const summaryLines = [
		`Alert: ${safeText(alertname, 200)}`,
		`Status: firing`,
		`Severity: ${sourceSeverity} -> ${chosen.severity}`,
		`Environment: ${safeText(environment, 64)}`,
		`Service: ${service}`,
		`Rule UID: ${chosen.ruleUid}`,
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
		...(group.truncatedAlerts === undefined || group.truncatedAlerts === 0
			? []
			: [`Group truncated: ${group.truncatedAlerts} alerts omitted`]),
	];

	const signal = {
		source: "grafana" as const,
		kind: GRAFANA_FIRING_INCIDENT_KIND,
		severity: chosen.severity,
		service,
		fingerprint: grafanaIncidentFingerprint({
			ruleUid: chosen.ruleUid,
			alertname,
			service,
			environment: environment ?? "",
		}),
		title: boundText(
			`Grafana alert "${safeText(alertname, 120)}" firing on ${service}`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundMultiline(
			redactGrafanaText(summaryLines.join("\n")),
			MAX_INCIDENT_SUMMARY_CHARS,
		),
		links: boundedLinks([
			{
				label: "Dashboard",
				url: chosen.alert.dashboardURL,
				keepQuery: true,
			},
			{ label: "Panel", url: chosen.alert.panelURL, keepQuery: true },
			{ label: "Alert rule", url: chosen.alert.generatorURL },
			{ label: "Silence", url: chosen.alert.silenceURL },
		]),
		receivedAt: receivedAtOf(options),
	};

	const validated = incidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
