import { createHash } from "node:crypto";
import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	isBoundedHttpsUrl,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { redactDatadogText } from "./redact";
import {
	DATADOG_INCIDENT_ID_PATTERN,
	DATADOG_MONITOR_ID_PATTERN,
	DATADOG_SERVICE_PATTERN,
	type DatadogIncident,
	type DatadogLogEntry,
	type DatadogLogsSearchRequest,
	type DatadogMetricSeries,
	type DatadogMetricsQueryRequest,
	type DatadogMonitor,
	datadogIncidentSchema,
	datadogLogsSearchResponseSchema,
	datadogMetricsQueryResponseSchema,
	datadogMonitorSchema,
	MAX_DATADOG_LOG_ENTRIES,
	MAX_DATADOG_METRIC_POINTS,
	MAX_DATADOG_METRIC_SERIES,
} from "./schemas";

/**
 * Datadog read-only context reader (`docs/connectors/datadog.md` §5).
 *
 * One pair of read-only credentials (`DD-API-KEY` + scoped
 * `DD-APPLICATION-KEY`), a fixed four-step plan and no model-authored query,
 * id or window:
 *
 * 1. `GET /api/v2/incidents/{id}` — incident metadata;
 * 2. `GET /api/v1/monitor/{id}` — monitor state;
 * 3. `POST /api/v2/query/timeseries` — two templated metric queries over a
 *    15–60 minute window;
 * 4. `POST /api/v2/logs/events/search` — at most 20 entries, aggregated into
 *    status-class and error-kind counts. Message bodies are never modelled.
 *
 * Caps are enforced, not estimated: ≤3 series and ≤20 points per series,
 * ≤1,500 chars of metric summary, ≤20 log entries / ≤2,000 chars of aggregate,
 * ≤12 items, ≤4 provider calls, 256 KiB per response and per bundle, 4,000
 * chars per item. Redaction runs **before** every truncation. A partial bundle
 * is valid; `truncated` reports a skipped call, a 403/404, a cap hit or a
 * parse failure.
 *
 * Never fetched: raw log message bodies, request bodies/query strings,
 * incident notes, responders, monitor `message`/`options`, dashboard JSON, or
 * any payload-supplied URL.
 *
 * Error mapping (`docs/connector-usage.md` §7): 401 and transport/timeout →
 * `INTEGRATION_UNAVAILABLE`, 429 → `RATE_LIMITED`, 403/404 on an optional
 * resource → drop it and set `truncated`, 5xx or malformed JSON → drop it and
 * set `truncated`.
 */

export const DATADOG_CONTEXT_MAX_ITEMS = 12;
export const DATADOG_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const DATADOG_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const DATADOG_CONTEXT_MAX_FETCH_CALLS = 6;
export const DATADOG_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
export const DATADOG_CONTEXT_MAX_SERIES = MAX_DATADOG_METRIC_SERIES;
export const DATADOG_CONTEXT_MAX_POINTS = MAX_DATADOG_METRIC_POINTS;
export const DATADOG_CONTEXT_MAX_LOG_ENTRIES = MAX_DATADOG_LOG_ENTRIES;
export const DATADOG_CONTEXT_MAX_LOG_CHARS = 2000;
export const DATADOG_CONTEXT_MAX_METRIC_SUMMARY_CHARS = 1500;
export const DATADOG_CONTEXT_MIN_WINDOW_MINUTES = 15;
export const DATADOG_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const DATADOG_CONTEXT_DEFAULT_WINDOW_MINUTES = 30;
/** The metric window starts this long before `startsAt`. */
export const DATADOG_CONTEXT_PRE_START_MINUTES = 15;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BASE_URL_CHARS = 300;
const REQUEST_USER_AGENT = "isolate-platform";
const METRIC_QUERY_NAMES = ["cpu", "errors"] as const;

export type DatadogContextDependencies = {
	/** API origin for the configured site, e.g. `https://api.datadoghq.com`. */
	baseUrl: string;
	/** Organization-wide API key; sent only in `DD-API-KEY`. */
	apiKey: string;
	/** Scoped application key; sent only in `DD-APPLICATION-KEY`. */
	appKey: string;
	fetchImpl?: DatadogFetchLike;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the per-source budget (12). */
	maxItems?: number;
	maxExcerptChars?: number;
	/** Free-tier accounts may not have Log Management; false skips the call. */
	logsEnabled?: boolean;
};

/** Narrow fetch shape; injectable without Bun's `preconnect` extension. */
export type DatadogFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type DatadogContextInput = {
	incidentFingerprint: string;
	service: string;
	incidentId?: string | null;
	monitorId?: string | number | null;
	startsAt?: string;
	windowMinutes?: number;
	/** Display-only, validated https; never fetched. */
	dashboardUrl?: string;
};

export type DatadogEvidenceResult = {
	item: ContextItem | null;
	/** True when evidence was dropped, capped, skipped or malformed. */
	truncated: boolean;
};

type Config = {
	baseUrl: string;
	apiKey: string;
	appKey: string;
	fetchImpl: DatadogFetchLike;
	now: () => number;
	timeoutMs: number;
	logsEnabled: boolean;
};

type CallOutcome =
	| { kind: "ok"; body: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "failed" };

type HttpClient = {
	request(path: string, init: RequestInit, step: string): Promise<CallOutcome>;
	calls: number;
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

function capExcerpt(
	text: string,
	maxChars: number,
	maxBytes: number,
): { text: string; truncated: boolean } {
	let out = text;
	let truncated = false;
	if (out.length > maxChars) {
		out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
		truncated = true;
	}
	const encoder = new TextEncoder();
	while (out.length > 1 && encoder.encode(out).byteLength > maxBytes) {
		out = out.slice(0, Math.max(1, Math.floor(out.length * 0.9)));
		truncated = true;
	}
	return { text: out, truncated };
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function safeUrl(value: string | null | undefined): string | undefined {
	return typeof value === "string" && isBoundedHttpsUrl(value)
		? value
		: undefined;
}

/** Validates and canonicalizes the site API origin; throws a fixed error. */
export function normalizeDatadogBaseUrl(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_BASE_URL_CHARS
	) {
		throw new PlatformError("VALIDATION_FAILED", "datadog baseUrl is invalid");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "datadog baseUrl is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new PlatformError("VALIDATION_FAILED", "datadog baseUrl is invalid");
	}
	return url.origin;
}

function requireSecret(
	value: string | null | undefined,
	field: string,
): string {
	const candidate = nonEmpty(value);
	if (candidate === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			`datadog ${field} is not configured`,
		);
	}
	return candidate;
}

function requireService(value: string | null | undefined): string {
	const candidate = nonEmpty(value);
	if (
		candidate === null ||
		candidate.length > 128 ||
		!DATADOG_SERVICE_PATTERN.test(candidate)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"service is not a Datadog service",
		);
	}
	return candidate;
}

function optionalIncidentId(value: string | null | undefined): string | null {
	const candidate = nonEmpty(value);
	if (candidate === null) return null;
	if (!DATADOG_INCIDENT_ID_PATTERN.test(candidate)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"incidentId is not a Datadog incident id",
		);
	}
	return candidate;
}

function optionalMonitorId(
	value: string | number | null | undefined,
): string | null {
	if (value === null || value === undefined) return null;
	const candidate = nonEmpty(typeof value === "number" ? String(value) : value);
	if (candidate === null || !DATADOG_MONITOR_ID_PATTERN.test(candidate)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"monitorId is not a Datadog monitor id",
		);
	}
	return candidate;
}

function prepare(dependencies: DatadogContextDependencies): Config {
	const baseUrl = normalizeDatadogBaseUrl(dependencies.baseUrl);
	const timeoutMs = Math.min(
		MAX_TIMEOUT_MS,
		Math.max(1000, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	);
	return {
		baseUrl,
		apiKey: requireSecret(dependencies.apiKey, "apiKey"),
		appKey: requireSecret(dependencies.appKey, "appKey"),
		fetchImpl:
			dependencies.fetchImpl ?? ((request, init) => fetch(request, init)),
		now: dependencies.now ?? (() => Date.now()),
		timeoutMs,
		logsEnabled: dependencies.logsEnabled !== false,
	};
}

function createClient(config: Config): HttpClient {
	const encoder = new TextEncoder();
	const client: HttpClient = {
		calls: 0,
		async request(path, init, step) {
			if (client.calls >= DATADOG_CONTEXT_MAX_FETCH_CALLS) {
				return { kind: "failed" };
			}
			client.calls += 1;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"User-Agent": REQUEST_USER_AGENT,
				"DD-API-KEY": config.apiKey,
				"DD-APPLICATION-KEY": config.appKey,
				...(init.headers as Record<string, string> | undefined),
			};
			let response: Response;
			try {
				response = await config.fetchImpl(`${config.baseUrl}${path}`, {
					...init,
					headers,
					// Refuse redirects: a provider hop must not forward the key.
					redirect: "error",
					signal: AbortSignal.timeout(config.timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed to reach datadog`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by datadog (status 401)`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by datadog`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > DATADOG_CONTEXT_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			let text: string;
			try {
				text = await response.text();
			} catch {
				return { kind: "failed" };
			}
			if (
				encoder.encode(text).byteLength > DATADOG_CONTEXT_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			try {
				return { kind: "ok", body: JSON.parse(text) };
			} catch {
				return { kind: "failed" };
			}
		},
	};
	return client;
}

export function clampDatadogWindowMinutes(value: number | undefined): number {
	const minutes = value ?? DATADOG_CONTEXT_DEFAULT_WINDOW_MINUTES;
	if (!Number.isFinite(minutes)) {
		return DATADOG_CONTEXT_DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(
		DATADOG_CONTEXT_MAX_WINDOW_MINUTES,
		Math.max(DATADOG_CONTEXT_MIN_WINDOW_MINUTES, Math.round(minutes)),
	);
}

export type DatadogWindow = { fromMs: number; toMs: number };

/**
 * Incident window: `startsAt − 15 min` through `now`, never wider than 60
 * minutes and never backfilled beyond that. A future `startsAt` clamps to now.
 */
export function resolveDatadogWindow(input: {
	nowMs: number;
	startsAt?: string;
	windowMinutes?: number;
}): DatadogWindow {
	const spanMs = clampDatadogWindowMinutes(input.windowMinutes) * 60_000;
	const toMs = input.nowMs;
	let fromMs = toMs - spanMs;
	const startsAt = nonEmpty(input.startsAt);
	if (startsAt !== null) {
		const parsed = z.iso.datetime({ offset: true }).safeParse(startsAt);
		if (parsed.success) {
			const startMs = Math.min(Date.parse(parsed.data), toMs);
			fromMs = Math.max(
				startMs - DATADOG_CONTEXT_PRE_START_MINUTES * 60_000,
				toMs - DATADOG_CONTEXT_MAX_WINDOW_MINUTES * 60_000,
			);
		}
	}
	if (!(fromMs < toMs)) fromMs = toMs - 15 * 60_000;
	return { fromMs, toMs };
}

/** The only metric queries in the connector: bounded service selectors. */
export function buildDatadogMetricRequest(input: {
	service: string;
	fromMs: number;
	toMs: number;
}): DatadogMetricsQueryRequest {
	const service = requireService(input.service);
	return {
		data: {
			type: "timeseries_request",
			attributes: {
				// Datadog metrics v2 takes POSIX seconds, not milliseconds.
				from: Math.floor(input.fromMs / 1000),
				to: Math.floor(input.toMs / 1000),
				queries: [
					{
						name: "cpu",
						data_source: "metrics",
						query: `avg:system.cpu.user{service:${service}}`,
					},
					{
						name: "errors",
						data_source: "metrics",
						query: `sum:trace.http.request.errors{service:${service}}.as_count()`,
					},
				],
			},
		},
	};
}

/** The only log query in the connector: one bounded service selector. */
export function buildDatadogLogRequest(input: {
	service: string;
	fromMs: number;
	toMs: number;
}): DatadogLogsSearchRequest {
	const service = requireService(input.service);
	return {
		filter: {
			query: `service:${service}`,
			from: new Date(input.fromMs).toISOString(),
			to: new Date(input.toMs).toISOString(),
		},
		sort: "timestamp",
		page: { limit: DATADOG_CONTEXT_MAX_LOG_ENTRIES },
	};
}

function postJson(
	client: HttpClient,
	path: string,
	body: unknown,
	step: string,
): Promise<CallOutcome> {
	return client.request(
		path,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		step,
	);
}

function isoOrEmpty(ms: number): string {
	return new Date(ms).toISOString();
}

function shortNumber(value: number): string {
	if (!Number.isFinite(value)) return "nan";
	return String(Number(value.toPrecision(6)));
}

function buildContextItem(input: {
	kind: string;
	title: string;
	url: string;
	excerpt: string;
	fetchedAt: string;
}): ContextItem {
	return {
		source: "datadog",
		kind: input.kind,
		title: boundText(redactDatadogText(input.title), 200),
		url: input.url,
		excerpt: input.excerpt,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(input.excerpt),
	};
}

function incidentExcerpt(incident: DatadogIncident): string {
	const attributes = incident.data.attributes;
	const impactScope = nonEmpty(attributes.customer_impact_scope ?? null);
	const lines = [
		`Incident: ${boundText(attributes.title, 300)}`,
		`ID: ${incident.data.id}`,
		...(attributes.severity === undefined
			? []
			: [`Severity: ${boundText(attributes.severity, 32)}`]),
		...(attributes.state === undefined
			? []
			: [`State: ${boundText(attributes.state, 32)}`]),
		...(attributes.created === undefined
			? []
			: [`Created: ${attributes.created}`]),
		...(attributes.modified === undefined
			? []
			: [`Modified: ${attributes.modified}`]),
		...(attributes.customer_impacted === undefined
			? []
			: [`Customer impacted: ${attributes.customer_impacted ? "yes" : "no"}`]),
		...(impactScope === null
			? []
			: [`Impact scope: ${boundText(impactScope, 600)}`]),
	];
	return lines.join("\n");
}

function monitorExcerpt(monitor: DatadogMonitor): string {
	const allowedTagKeys = new Set([
		"service",
		"env",
		"environment",
		"version",
		"team",
		"cluster",
	]);
	const tags = (monitor.tags ?? [])
		.filter((tag) => {
			const separator = tag.indexOf(":");
			if (separator <= 0) return false;
			return allowedTagKeys.has(tag.slice(0, separator).trim().toLowerCase());
		})
		.slice(0, 10)
		.map((tag) => boundText(tag, 160));
	const lines = [
		`Monitor: ${boundText(monitor.name, 300)}`,
		`ID: ${String(monitor.id)}`,
		...(monitor.type === undefined
			? []
			: [`Type: ${boundText(monitor.type, 64)}`]),
		...(monitor.overall_state === undefined
			? []
			: [`State: ${boundText(monitor.overall_state, 32)}`]),
		...(monitor.priority === null || monitor.priority === undefined
			? []
			: [`Priority: P${monitor.priority}`]),
		...(monitor.created === undefined ? [] : [`Created: ${monitor.created}`]),
		...(monitor.modified === undefined
			? []
			: [`Modified: ${monitor.modified}`]),
		...(tags.length === 0 ? [] : [`Tags: ${tags.join(", ")}`]),
	];
	return lines.join("\n");
}

type MetricPoint = { t: number | null; v: number };

function metricPoints(series: DatadogMetricSeries): {
	points: MetricPoint[];
	truncated: boolean;
} {
	const raw: MetricPoint[] = [];
	if (series.pointlist !== undefined) {
		for (const [timestamp, value] of series.pointlist) {
			if (value === null || !Number.isFinite(value)) continue;
			raw.push({ t: timestamp, v: value });
		}
	} else if (series.times !== undefined && series.values !== undefined) {
		const length = Math.min(series.times.length, series.values.length);
		for (let index = 0; index < length; index += 1) {
			const value = series.values[index];
			if (value === null || value === undefined || !Number.isFinite(value)) {
				continue;
			}
			raw.push({ t: series.times[index] ?? null, v: value });
		}
	}
	const truncated = raw.length > DATADOG_CONTEXT_MAX_POINTS;
	return {
		points: truncated
			? raw.slice(raw.length - DATADOG_CONTEXT_MAX_POINTS)
			: raw,
		truncated,
	};
}

function metricSeriesName(series: DatadogMetricSeries, index: number): string {
	const queryName =
		series.query_index === undefined
			? `series_${index + 1}`
			: (METRIC_QUERY_NAMES[series.query_index] ?? `series_${index + 1}`);
	const scope = nonEmpty(series.scope);
	return scope === null ? queryName : `${queryName} ${boundText(scope, 120)}`;
}

export function renderDatadogMetricSummary(input: {
	service: string;
	fromMs: number;
	toMs: number;
	series: Array<{ name: string; points: MetricPoint[] }>;
	omittedSeries: number;
	truncatedPoints: boolean;
}): { text: string; truncated: boolean } {
	const lines = [
		`Metrics window: ${isoOrEmpty(input.fromMs)} → ${isoOrEmpty(input.toMs)}`,
		`Query: avg:system.cpu.user{service:${input.service}}`,
		`Query: sum:trace.http.request.errors{service:${input.service}}.as_count()`,
	];
	input.series.forEach((entry, index) => {
		const numbers = entry.points.map((point) => point.v);
		const sum = numbers.reduce((total, value) => total + value, 0);
		lines.push(
			`Series ${index + 1}: ${entry.name} — last=${shortNumber(
				numbers[numbers.length - 1] ?? 0,
			)} min=${shortNumber(Math.min(...numbers))} max=${shortNumber(
				Math.max(...numbers),
			)} avg=${shortNumber(sum / numbers.length)}`,
		);
		lines.push(
			`  points: ${entry.points
				.map((point) => shortNumber(point.v))
				.join(", ")}`,
		);
	});
	if (input.series.length === 0) lines.push("No series returned.");
	if (input.omittedSeries > 0) {
		lines.push(`Omitted series: ${input.omittedSeries}`);
	}
	if (input.truncatedPoints) lines.push("Points truncated to the last 20.");
	const capped = capExcerpt(
		redactDatadogText(lines.join("\n")),
		DATADOG_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
		DATADOG_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
	);
	return {
		text: capped.text,
		truncated:
			capped.truncated || input.omittedSeries > 0 || input.truncatedPoints,
	};
}

type LogStatusClass = "error" | "warn" | "info" | "other";

function statusClass(value: string | undefined): LogStatusClass {
	switch (value?.trim().toLowerCase()) {
		case "error":
		case "critical":
		case "fatal":
		case "emergency":
		case "alert":
			return "error";
		case "warn":
		case "warning":
			return "warn";
		case "info":
		case "debug":
		case "notice":
			return "info";
		default:
			return "other";
	}
}

const ERROR_KIND_KEYS = [
	"error.kind",
	"error.type",
	"error.kind_name",
	"error_category",
	"exception.type",
] as const;

function errorKindOf(entry: DatadogLogEntry): string | null {
	const attributes = entry.attributes?.attributes;
	if (attributes === undefined) return null;
	for (const key of ERROR_KIND_KEYS) {
		const value = attributes[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return boundText(value, 80);
		}
	}
	return null;
}

/** Aggregate of one bounded log page; never a raw line or a message body. */
export function renderDatadogLogSummary(input: {
	service: string;
	fromMs: number;
	toMs: number;
	entries: readonly DatadogLogEntry[];
	truncated: boolean;
}): { text: string; truncated: boolean } {
	const statuses: Record<LogStatusClass, number> = {
		error: 0,
		warn: 0,
		info: 0,
		other: 0,
	};
	const kinds = new Map<string, number>();
	for (const entry of input.entries) {
		statuses[statusClass(entry.attributes?.status)] += 1;
		const kind = errorKindOf(entry);
		if (kind !== null) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
	}
	const statusText = (
		Object.entries(statuses) as Array<[LogStatusClass, number]>
	)
		.filter(([, count]) => count > 0)
		.map(([name, count]) => `${name}=${count}`)
		.join(", ");
	const kindText = [...kinds.entries()]
		.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
		.slice(0, 10)
		.map(([kind, count]) => `${kind}=${count}`)
		.join(", ");
	const lines = [
		`Log window: ${isoOrEmpty(input.fromMs)} → ${isoOrEmpty(input.toMs)}`,
		`Query: service:${input.service}`,
		`Entries: ${input.entries.length} (limit ${DATADOG_CONTEXT_MAX_LOG_ENTRIES})`,
		`Status: ${statusText === "" ? "none" : statusText}`,
		`Error kinds: ${kindText === "" ? "none" : kindText}`,
		"Aggregate only; message bodies are never read.",
	];
	const capped = capExcerpt(
		redactDatadogText(lines.join("\n")),
		DATADOG_CONTEXT_MAX_LOG_CHARS,
		DATADOG_CONTEXT_MAX_LOG_CHARS,
	);
	return { text: capped.text, truncated: capped.truncated || input.truncated };
}

async function fetchIncident(
	config: Config,
	client: HttpClient,
	input: { incidentId: string; fetchedAt: string },
): Promise<DatadogEvidenceResult> {
	const outcome = await client.request(
		`/api/v2/incidents/${encodeURIComponent(input.incidentId)}`,
		{ method: "GET" },
		"datadog incident",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = datadogIncidentSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const excerpt = capExcerpt(
		redactDatadogText(incidentExcerpt(parsed.data)),
		DATADOG_CONTEXT_MAX_EXCERPT_CHARS,
		DATADOG_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildContextItem({
			kind: "incident",
			title: `Incident: ${parsed.data.data.attributes.title}`,
			url: `${config.baseUrl}/api/v2/incidents/${encodeURIComponent(
				parsed.data.data.id,
			)}`,
			excerpt: excerpt.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: excerpt.truncated,
	};
}

async function fetchMonitor(
	config: Config,
	client: HttpClient,
	input: { monitorId: string; fetchedAt: string },
): Promise<DatadogEvidenceResult> {
	const outcome = await client.request(
		`/api/v1/monitor/${encodeURIComponent(input.monitorId)}`,
		{ method: "GET" },
		"datadog monitor",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = datadogMonitorSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const excerpt = capExcerpt(
		redactDatadogText(monitorExcerpt(parsed.data)),
		DATADOG_CONTEXT_MAX_EXCERPT_CHARS,
		DATADOG_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildContextItem({
			kind: "monitor",
			title: `Monitor: ${parsed.data.name}`,
			url: `${config.baseUrl}/api/v1/monitor/${encodeURIComponent(
				String(parsed.data.id),
			)}`,
			excerpt: excerpt.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: excerpt.truncated,
	};
}

async function fetchMetrics(
	config: Config,
	client: HttpClient,
	input: {
		service: string;
		fromMs: number;
		toMs: number;
		fetchedAt: string;
		dashboardUrl?: string;
	},
): Promise<DatadogEvidenceResult> {
	const request = buildDatadogMetricRequest({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
	});
	const outcome = await postJson(
		client,
		"/api/v2/query/timeseries",
		request,
		"datadog metrics",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = datadogMetricsQueryResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	if ((parsed.data.errors?.length ?? 0) > 0) {
		return { item: null, truncated: true };
	}
	const collected: Array<{ name: string; points: MetricPoint[] }> = [];
	let truncated = false;
	let omittedSeries = 0;
	const series = parsed.data.data?.attributes?.series ?? [];
	series.forEach((entry, index) => {
		const points = metricPoints(entry);
		if (points.points.length === 0) return;
		truncated = truncated || points.truncated;
		if (collected.length >= DATADOG_CONTEXT_MAX_SERIES) {
			omittedSeries += 1;
			return;
		}
		collected.push({
			name: metricSeriesName(entry, index),
			points: points.points,
		});
	});
	const summary = renderDatadogMetricSummary({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
		series: collected,
		omittedSeries,
		truncatedPoints: truncated,
	});
	if (collected.length === 0) {
		return { item: null, truncated: summary.truncated };
	}
	return {
		item: buildContextItem({
			kind: "metrics",
			title: `Metrics window (${collected.length} series)`,
			url:
				safeUrl(input.dashboardUrl) ??
				`${config.baseUrl}/api/v2/query/timeseries`,
			excerpt: summary.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: summary.truncated,
	};
}

async function fetchLogs(
	config: Config,
	client: HttpClient,
	input: {
		service: string;
		fromMs: number;
		toMs: number;
		fetchedAt: string;
		dashboardUrl?: string;
	},
): Promise<DatadogEvidenceResult> {
	if (!config.logsEnabled) {
		return { item: null, truncated: true };
	}
	const request = buildDatadogLogRequest({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
	});
	const outcome = await postJson(
		client,
		"/api/v2/logs/events/search",
		request,
		"datadog logs",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = datadogLogsSearchResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	if ((parsed.data.errors?.length ?? 0) > 0) {
		return { item: null, truncated: true };
	}
	const responseEntries = parsed.data.data ?? [];
	const entries = responseEntries.slice(0, DATADOG_CONTEXT_MAX_LOG_ENTRIES);
	const moreAfter = parsed.data.meta?.page?.after;
	const truncated =
		responseEntries.length > entries.length ||
		(moreAfter !== null && moreAfter !== undefined);
	const summary = renderDatadogLogSummary({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
		entries,
		truncated,
	});
	if (entries.length === 0) {
		return { item: null, truncated: summary.truncated };
	}
	return {
		item: buildContextItem({
			kind: "logs",
			title: `Log counts (${entries.length} entries)`,
			url:
				safeUrl(input.dashboardUrl) ??
				`${config.baseUrl}/api/v2/logs/events/search`,
			excerpt: summary.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: summary.truncated,
	};
}

function validateInput(
	input: DatadogContextInput,
	config: Config,
): {
	service: string;
	incidentId: string | null;
	monitorId: string | null;
	window: DatadogWindow;
	dashboardUrl: string | undefined;
} {
	if (
		input === null ||
		typeof input !== "object" ||
		typeof input.incidentFingerprint !== "string" ||
		input.incidentFingerprint.trim().length === 0 ||
		input.incidentFingerprint.length > 128
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"incidentFingerprint is required",
		);
	}
	const service = requireService(input.service);
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"datadog clock is unavailable",
		);
	}
	return {
		service,
		incidentId: optionalIncidentId(input.incidentId),
		monitorId: optionalMonitorId(input.monitorId),
		window: resolveDatadogWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		dashboardUrl: safeUrl(input.dashboardUrl),
	};
}

/**
 * Fixed four-call plan. Throws only `PlatformError` with a fixed message: no
 * URL, header, key or provider text is ever part of an error.
 */
export async function fetchDatadogContext(
	dependencies: DatadogContextDependencies,
	input: DatadogContextInput,
): Promise<ContextBundle> {
	const config = prepare(dependencies);
	const validated = validateInput(input, config);
	const client = createClient(config);
	const fetchedAt = new Date(config.now()).toISOString();

	const incident =
		validated.incidentId === null
			? { item: null, truncated: true }
			: await fetchIncident(config, client, {
					incidentId: validated.incidentId,
					fetchedAt,
				});
	const monitor =
		validated.monitorId === null
			? { item: null, truncated: true }
			: await fetchMonitor(config, client, {
					monitorId: validated.monitorId,
					fetchedAt,
				});
	const metrics = await fetchMetrics(config, client, {
		service: validated.service,
		fromMs: validated.window.fromMs,
		toMs: validated.window.toMs,
		fetchedAt,
		dashboardUrl: validated.dashboardUrl,
	});
	const logs = await fetchLogs(config, client, {
		service: validated.service,
		fromMs: validated.window.fromMs,
		toMs: validated.window.toMs,
		fetchedAt,
		dashboardUrl: validated.dashboardUrl,
	});

	const maxItems = Math.max(
		1,
		Math.min(
			dependencies.maxItems ?? DATADOG_CONTEXT_MAX_ITEMS,
			DATADOG_CONTEXT_MAX_ITEMS,
		),
	);
	const maxExcerptChars = Math.max(
		1,
		Math.min(
			dependencies.maxExcerptChars ?? DATADOG_CONTEXT_MAX_EXCERPT_CHARS,
			DATADOG_CONTEXT_MAX_EXCERPT_CHARS,
		),
	);
	const encoder = new TextEncoder();
	const items: ContextItem[] = [];
	let usedBytes = 0;
	let truncated = incident.truncated || monitor.truncated || metrics.truncated;
	truncated = truncated || logs.truncated;

	for (const candidate of [
		incident.item,
		monitor.item,
		metrics.item,
		logs.item,
	]) {
		if (candidate === null) continue;
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = DATADOG_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
		if (remaining < 64) {
			truncated = true;
			break;
		}
		const capped = capExcerpt(
			candidate.excerpt,
			maxExcerptChars,
			Math.min(remaining, maxExcerptChars * 4),
		);
		if (capped.text.trim().length === 0) {
			truncated = true;
			continue;
		}
		if (capped.truncated) truncated = true;
		items.push({
			...candidate,
			excerpt: capped.text,
			sha256: sha256Hex(capped.text),
		});
		usedBytes += encoder.encode(capped.text).byteLength;
	}

	const bundle = {
		incidentFingerprint: input.incidentFingerprint.trim(),
		items,
		truncated,
	};
	const parsedBundle = contextBundleSchema.safeParse(bundle);
	if (!parsedBundle.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"datadog context bundle violated the shared contract",
		);
	}
	return parsedBundle.data;
}

/**
 * Single-resource variants used by the read-only tools. Each has its own call
 * budget and the same caps; none mutates provider state.
 */
export async function fetchDatadogIncidentEvidence(
	dependencies: DatadogContextDependencies,
	input: { incidentId: string; fetchedAt?: string },
): Promise<DatadogEvidenceResult> {
	const config = prepare(dependencies);
	const incidentId = optionalIncidentId(input.incidentId);
	if (incidentId === null) {
		throw new PlatformError("VALIDATION_FAILED", "incidentId is required");
	}
	return fetchIncident(config, createClient(config), {
		incidentId,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
}

export async function fetchDatadogMonitorEvidence(
	dependencies: DatadogContextDependencies,
	input: { monitorId: string | number; fetchedAt?: string },
): Promise<DatadogEvidenceResult> {
	const config = prepare(dependencies);
	const monitorId = optionalMonitorId(input.monitorId);
	if (monitorId === null) {
		throw new PlatformError("VALIDATION_FAILED", "monitorId is required");
	}
	return fetchMonitor(config, createClient(config), {
		monitorId,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
}

export async function fetchDatadogMetricEvidence(
	dependencies: DatadogContextDependencies,
	input: {
		service: string;
		startsAt?: string;
		windowMinutes?: number;
		dashboardUrl?: string;
	},
): Promise<DatadogEvidenceResult> {
	const config = prepare(dependencies);
	const service = requireService(input.service);
	const nowMs = config.now();
	return fetchMetrics(config, createClient(config), {
		service,
		...resolveDatadogWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		fetchedAt: new Date(nowMs).toISOString(),
		dashboardUrl: safeUrl(input.dashboardUrl),
	});
}

export async function fetchDatadogLogEvidence(
	dependencies: DatadogContextDependencies,
	input: {
		service: string;
		startsAt?: string;
		windowMinutes?: number;
		dashboardUrl?: string;
	},
): Promise<DatadogEvidenceResult> {
	const config = prepare(dependencies);
	const service = requireService(input.service);
	const nowMs = config.now();
	return fetchLogs(config, createClient(config), {
		service,
		...resolveDatadogWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		fetchedAt: new Date(nowMs).toISOString(),
		dashboardUrl: safeUrl(input.dashboardUrl),
	});
}
