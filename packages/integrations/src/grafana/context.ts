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
import { redactGrafanaText } from "./redact";
import {
	GRAFANA_UID_PATTERN,
	type GrafanaAlertRule,
	type GrafanaDataFrame,
	type GrafanaDatasourceQuery,
	type GrafanaDsQueryRequest,
	grafanaAlertRuleSchema,
	grafanaDsQueryResponseSchema,
	MAX_GRAFANA_DATAPOINTS,
	MAX_GRAFANA_LOG_LINES,
} from "./schemas";

/**
 * Grafana read-only context reader (`docs/connectors/grafana.md` §5).
 *
 * One service-account token, a fixed three-call plan and no model-authored
 * query, datasource UID or time range:
 *
 * 1. `GET /api/v1/provisioning/alert-rules/{uid}` — rule metadata;
 * 2. `POST /api/ds/query` — one bounded Prometheus window
 *    (`startsAt − 15 min` through `now`, clamped to 60 minutes);
 * 3. `POST /api/ds/query` — one bounded Loki tail (last 200 lines).
 *
 * Caps are enforced, not estimated: ≤5 series and ≤20 points rendered as a
 * ≤1,500-char summary, ≤200 log lines / ≤2,000 chars, one rule item, ≤4
 * provider calls, 256 KiB per response and per bundle, 4,000 chars per item.
 * Redaction runs **before** every truncation. A partial bundle is valid;
 * `truncated` reports every 403/404, dropped series, cap hit or parse failure.
 *
 * Never fetched: dashboard JSON, full rule history, full log windows, raw
 * series, `generatorURL` or any other payload-supplied URL.
 *
 * Error mapping (`docs/connector-usage.md` §7): 401 and transport/timeout →
 * `INTEGRATION_UNAVAILABLE`, 429 → `RATE_LIMITED`, 403/404 on an optional
 * resource → drop it and set `truncated`, 5xx or malformed JSON → drop it and
 * set `truncated`.
 */

export const GRAFANA_CONTEXT_MAX_ITEMS = 8;
export const GRAFANA_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const GRAFANA_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const GRAFANA_CONTEXT_MAX_FETCH_CALLS = 4;
export const GRAFANA_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
export const GRAFANA_CONTEXT_MAX_SERIES = 5;
export const GRAFANA_CONTEXT_MAX_POINTS = MAX_GRAFANA_DATAPOINTS;
export const GRAFANA_CONTEXT_MAX_LOG_LINES = MAX_GRAFANA_LOG_LINES;
export const GRAFANA_CONTEXT_MAX_LOG_CHARS = 2000;
export const GRAFANA_CONTEXT_MAX_METRIC_SUMMARY_CHARS = 1500;
export const GRAFANA_CONTEXT_MIN_WINDOW_MINUTES = 15;
export const GRAFANA_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const GRAFANA_CONTEXT_DEFAULT_WINDOW_MINUTES = 30;
/** The metric window starts this long before `startsAt`. */
export const GRAFANA_CONTEXT_PRE_START_MINUTES = 15;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BASE_URL_CHARS = 300;
const MAX_BASE_PATH_CHARS = 200;
const REQUEST_USER_AGENT = "isolate-platform";

export type GrafanaContextDependencies = {
	/** Stack URL: https, no userinfo, no query or fragment. */
	baseUrl: string;
	/** Service-account token; only ever placed in the Authorization header. */
	token: string;
	/** Sent as `X-Grafana-Org-Id` when the stack has several orgs. */
	orgId?: number | string | null;
	metricsDatasourceUid?: string | null;
	logsDatasourceUid?: string | null;
	fetchImpl?: GrafanaFetchLike;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the per-source budget (8). */
	maxItems?: number;
	maxExcerptChars?: number;
};

/** Narrow fetch shape; injectable without Bun's `preconnect` extension. */
export type GrafanaFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type GrafanaContextInput = {
	incidentFingerprint: string;
	service: string;
	alertRuleUid?: string | null;
	startsAt?: string;
	windowMinutes?: number;
	/** Display-only, validated https; never fetched. */
	dashboardUrl?: string;
	panelUrl?: string;
};

export type GrafanaEvidenceResult = {
	item: ContextItem | null;
	/** True when evidence was dropped, capped or malformed. */
	truncated: boolean;
};

type Config = {
	baseUrl: string;
	token: string;
	orgId: string | null;
	metricsUid: string | null;
	logsUid: string | null;
	fetchImpl: GrafanaFetchLike;
	now: () => number;
	timeoutMs: number;
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

/** Keeps the tail: the most recent logs matter when the cap is hit. */
function tailBound(
	text: string,
	maxChars: number,
): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `…${text.slice(text.length - Math.max(0, maxChars - 1))}`,
		truncated: true,
	};
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

/** Validates and canonicalizes the stack URL; throws a fixed error. */
export function normalizeGrafanaBaseUrl(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_BASE_URL_CHARS
	) {
		throw new PlatformError("VALIDATION_FAILED", "grafana baseUrl is invalid");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "grafana baseUrl is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PlatformError("VALIDATION_FAILED", "grafana baseUrl is invalid");
	}
	if (url.pathname.length > MAX_BASE_PATH_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "grafana baseUrl is invalid");
	}
	const pathname =
		url.pathname.endsWith("/") && url.pathname.length > 1
			? url.pathname.slice(0, -1)
			: url.pathname;
	return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function requireUid(value: string | null | undefined, field: string): string {
	const candidate = nonEmpty(value);
	if (candidate === null || !GRAFANA_UID_PATTERN.test(candidate)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`${field} is not a Grafana UID`,
		);
	}
	return candidate;
}

function optionalUid(
	value: string | null | undefined,
	field: string,
): string | null {
	const candidate = nonEmpty(value);
	if (candidate === null) return null;
	return requireUid(candidate, field);
}

function orgIdOf(value: number | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const text = typeof value === "number" ? String(value) : value.trim();
	if (!/^[1-9][0-9]{0,9}$/.test(text)) {
		throw new PlatformError("VALIDATION_FAILED", "grafana orgId is invalid");
	}
	return text;
}

function prepare(dependencies: GrafanaContextDependencies): Config {
	const baseUrl = normalizeGrafanaBaseUrl(dependencies.baseUrl);
	const token = nonEmpty(dependencies.token);
	if (token === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"grafana token is not configured",
		);
	}
	const timeoutMs = Math.min(
		MAX_TIMEOUT_MS,
		Math.max(1000, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	);
	return {
		baseUrl,
		token,
		orgId: orgIdOf(dependencies.orgId),
		metricsUid: optionalUid(
			dependencies.metricsDatasourceUid,
			"metricsDatasourceUid",
		),
		logsUid: optionalUid(dependencies.logsDatasourceUid, "logsDatasourceUid"),
		fetchImpl:
			dependencies.fetchImpl ?? ((request, init) => fetch(request, init)),
		now: dependencies.now ?? (() => Date.now()),
		timeoutMs,
	};
}

function createClient(config: Config): HttpClient {
	const encoder = new TextEncoder();
	const client: HttpClient = {
		calls: 0,
		async request(path, init, step) {
			if (client.calls >= GRAFANA_CONTEXT_MAX_FETCH_CALLS) {
				return { kind: "failed" };
			}
			client.calls += 1;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"User-Agent": REQUEST_USER_AGENT,
				Authorization: `Bearer ${config.token}`,
				...(init.headers as Record<string, string> | undefined),
			};
			if (config.orgId !== null) headers["X-Grafana-Org-Id"] = config.orgId;
			let response: Response;
			try {
				response = await config.fetchImpl(`${config.baseUrl}${path}`, {
					...init,
					headers,
					signal: AbortSignal.timeout(config.timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed to reach grafana`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by grafana (status 401)`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by grafana`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > GRAFANA_CONTEXT_MAX_RESPONSE_BYTES
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
				encoder.encode(text).byteLength > GRAFANA_CONTEXT_MAX_RESPONSE_BYTES
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

/** Escapes a label value for a PromQL/LogQL matcher; payload text is inert. */
export function escapeGrafanaLabelValue(value: string): string {
	let out = "";
	for (const character of value.slice(0, 100)) {
		const code = character.charCodeAt(0);
		if (character === "\\" || character === '"') {
			out += `\\${character}`;
		} else if (code < 32 || code === 127) {
			out += " ";
		} else {
			out += character;
		}
	}
	return out;
}

/** The only PromQL template in the connector: a bounded service selector. */
export function grafanaPromQlForService(service: string): string {
	return `{job="${escapeGrafanaLabelValue(service)}"}`;
}

/** The only LogQL template in the connector: the same selector. */
export function grafanaLogQlForService(service: string): string {
	return `{job="${escapeGrafanaLabelValue(service)}"}`;
}

export function clampGrafanaWindowMinutes(value: number | undefined): number {
	const minutes = value ?? GRAFANA_CONTEXT_DEFAULT_WINDOW_MINUTES;
	if (!Number.isFinite(minutes)) {
		return GRAFANA_CONTEXT_DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(
		GRAFANA_CONTEXT_MAX_WINDOW_MINUTES,
		Math.max(GRAFANA_CONTEXT_MIN_WINDOW_MINUTES, Math.round(minutes)),
	);
}

export type GrafanaWindow = { fromMs: number; toMs: number };

/**
 * Incident window: `startsAt − 15 min` through `now`, never wider than 60
 * minutes, never backfilled beyond that. A future `startsAt` is clamped to now.
 */
export function resolveGrafanaWindow(input: {
	nowMs: number;
	startsAt?: string;
	windowMinutes?: number;
}): GrafanaWindow {
	const spanMs = clampGrafanaWindowMinutes(input.windowMinutes) * 60_000;
	const toMs = input.nowMs;
	let fromMs = toMs - spanMs;
	const startsAt = nonEmpty(input.startsAt);
	if (startsAt !== null) {
		const parsed = z.iso.datetime({ offset: true }).safeParse(startsAt);
		if (parsed.success) {
			const startMs = Math.min(Date.parse(parsed.data), toMs);
			fromMs = Math.max(
				startMs - GRAFANA_CONTEXT_PRE_START_MINUTES * 60_000,
				toMs - GRAFANA_CONTEXT_MAX_WINDOW_MINUTES * 60_000,
			);
		}
	}
	if (!(fromMs < toMs)) fromMs = toMs - 15 * 60_000;
	return { fromMs, toMs };
}

export function buildGrafanaMetricRequest(input: {
	uid: string;
	service: string;
	fromMs: number;
	toMs: number;
}): GrafanaDsQueryRequest {
	const query: GrafanaDatasourceQuery = {
		refId: "metrics",
		datasource: { type: "prometheus", uid: input.uid },
		expr: grafanaPromQlForService(input.service),
		maxDataPoints: GRAFANA_CONTEXT_MAX_POINTS,
		intervalMs: Math.min(
			60_000,
			Math.max(
				1000,
				Math.floor((input.toMs - input.fromMs) / GRAFANA_CONTEXT_MAX_POINTS),
			),
		),
		format: "time_series",
		instant: false,
		range: true,
	};
	return {
		from: String(input.fromMs),
		to: String(input.toMs),
		queries: [query],
	};
}

export function buildGrafanaLogRequest(input: {
	uid: string;
	service: string;
	fromMs: number;
	toMs: number;
}): GrafanaDsQueryRequest {
	const query: GrafanaDatasourceQuery = {
		refId: "logs",
		datasource: { type: "loki", uid: input.uid },
		expr: grafanaLogQlForService(input.service),
		maxDataPoints: GRAFANA_CONTEXT_MAX_POINTS,
		intervalMs: 60_000,
		format: "table",
		queryType: "range",
		maxLines: GRAFANA_CONTEXT_MAX_LOG_LINES,
	};
	return {
		from: String(input.fromMs),
		to: String(input.toMs),
		queries: [query],
	};
}

function postDatasource(
	client: HttpClient,
	request: GrafanaDsQueryRequest,
	step: string,
): Promise<CallOutcome> {
	return client.request(
		"/api/ds/query",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		},
		step,
	);
}

function toEpochMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && value.trim() !== "") return numeric;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function isoOrEmpty(ms: number | null): string {
	return ms === null ? "" : new Date(ms).toISOString();
}

function shortNumber(value: number): string {
	if (!Number.isFinite(value)) return "nan";
	return String(Number(value.toPrecision(6)));
}

type MetricSeries = {
	name: string;
	points: Array<{ t: number | null; v: number }>;
};

const SERIES_LABEL_KEYS = new Set([
	"job",
	"instance",
	"namespace",
	"pod",
	"container",
	"le",
	"service",
	"method",
	"status",
	"code",
]);

function seriesNameOf(frame: GrafanaDataFrame, index: number): string {
	const field = frame.schema?.fields?.[index];
	const name = field?.name ?? `series_${index}`;
	const labels = field?.labels ?? {};
	const labelText = Object.entries(labels)
		.filter(([key]) => SERIES_LABEL_KEYS.has(key.toLowerCase()))
		.slice(0, 6)
		.map(([key, value]) => `${key}="${boundText(value, 80)}"`)
		.join(", ");
	return labelText === ""
		? boundText(name, 160)
		: `${boundText(name, 100)} {${labelText}}`;
}

/** Extracts numeric series from a frame, keeping the most recent points. */
export function extractGrafanaMetricSeries(frame: GrafanaDataFrame): {
	series: MetricSeries[];
	truncated: boolean;
} {
	const values = frame.data?.values ?? [];
	const fields = frame.schema?.fields ?? [];
	if (values.length === 0) return { series: [], truncated: false };
	const rows = Math.max(...values.map((column) => column.length), 0);
	const timeIndex = fields.findIndex(
		(field) =>
			field.type === "time" || (field.name ?? "").toLowerCase() === "time",
	);
	const series: MetricSeries[] = [];
	let truncated = false;
	values.forEach((column, index) => {
		if (index === timeIndex) return;
		const points: Array<{ t: number | null; v: number }> = [];
		for (let row = 0; row < rows; row += 1) {
			const value = column[row];
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			points.push({
				t: timeIndex >= 0 ? toEpochMs(values[timeIndex]?.[row]) : null,
				v: value,
			});
		}
		if (points.length === 0) return;
		if (points.length > GRAFANA_CONTEXT_MAX_POINTS) {
			points.splice(0, points.length - GRAFANA_CONTEXT_MAX_POINTS);
			truncated = true;
		}
		series.push({ name: seriesNameOf(frame, index), points });
	});
	return { series, truncated };
}

export function renderGrafanaMetricSummary(input: {
	service: string;
	fromMs: number;
	toMs: number;
	series: MetricSeries[];
	omittedSeries: number;
	truncatedPoints: boolean;
}): { text: string; truncated: boolean } {
	const lines = [
		`Metrics window: ${isoOrEmpty(input.fromMs)} → ${isoOrEmpty(input.toMs)}`,
		`Query: ${grafanaPromQlForService(input.service)}`,
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
		redactGrafanaText(lines.join("\n")),
		GRAFANA_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
		GRAFANA_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
	);
	return {
		text: capped.text,
		truncated:
			capped.truncated || input.omittedSeries > 0 || input.truncatedPoints,
	};
}

function logLinesOf(frame: GrafanaDataFrame): {
	lines: Array<{ t: number | null; line: string }>;
	truncated: boolean;
} {
	const values = frame.data?.values ?? [];
	const fields = frame.schema?.fields ?? [];
	if (values.length === 0) return { lines: [], truncated: false };
	const rows = Math.max(...values.map((column) => column.length), 0);
	const timeIndex = fields.findIndex(
		(field) =>
			field.type === "time" || (field.name ?? "").toLowerCase() === "time",
	);
	const preferred = ["line", "log", "message", "body"];
	let stringIndex = fields.findIndex(
		(field) =>
			preferred.includes((field.name ?? "").toLowerCase()) &&
			field.name !== undefined,
	);
	if (stringIndex < 0) {
		stringIndex = values.findIndex((column, index) => {
			if (index === timeIndex) return false;
			const name = (fields[index]?.name ?? "").toLowerCase();
			return (
				name !== "labels" && column.some((cell) => typeof cell === "string")
			);
		});
	}
	if (stringIndex < 0) return { lines: [], truncated: false };
	const column = values[stringIndex] ?? [];
	const lines: Array<{ t: number | null; line: string }> = [];
	for (let row = 0; row < rows; row += 1) {
		const value = column[row];
		if (typeof value !== "string" || value.length === 0) continue;
		lines.push({
			t: timeIndex >= 0 ? toEpochMs(values[timeIndex]?.[row]) : null,
			line: value,
		});
	}
	if (lines.every((entry) => entry.t !== null)) {
		lines.sort((left, right) => (left.t ?? 0) - (right.t ?? 0));
	}
	const truncated = lines.length > GRAFANA_CONTEXT_MAX_LOG_LINES;
	return {
		lines: truncated ? lines.slice(-GRAFANA_CONTEXT_MAX_LOG_LINES) : lines,
		truncated,
	};
}

export function renderGrafanaLogTail(input: {
	service: string;
	fromMs: number;
	toMs: number;
	lines: string[];
	truncated: boolean;
}): { text: string; truncated: boolean } {
	const header = [
		`Log window: ${isoOrEmpty(input.fromMs)} → ${isoOrEmpty(input.toMs)}`,
		`Query: ${grafanaLogQlForService(input.service)}`,
	].join("\n");
	const body = redactGrafanaText(input.lines.join("\n"));
	const capped = tailBound(`${header}\n${body}`, GRAFANA_CONTEXT_MAX_LOG_CHARS);
	return { text: capped.text, truncated: capped.truncated || input.truncated };
}

function buildContextItem(input: {
	kind: string;
	title: string;
	url: string | undefined;
	excerpt: string;
	fetchedAt: string;
}): ContextItem {
	return {
		source: "grafana",
		kind: input.kind,
		title: boundText(redactGrafanaText(input.title), 200),
		...(input.url === undefined ? {} : { url: input.url }),
		excerpt: input.excerpt,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(input.excerpt),
	};
}

function ruleExcerpt(rule: GrafanaAlertRule): string {
	const allowedAnnotations = ["summary", "description", "runbook_url"];
	const annotations = Object.entries(rule.annotations ?? {})
		.filter(([key]) => allowedAnnotations.includes(key))
		.slice(0, allowedAnnotations.length)
		.map(([key, value]) => `${key}=${boundText(value, 500)}`);
	const allowedLabels = [
		"alertname",
		"severity",
		"environment",
		"env",
		"service",
		"job",
		"instance",
		"namespace",
		"cluster",
	];
	const labels = Object.entries(rule.labels ?? {})
		.filter(([key]) => allowedLabels.includes(key))
		.slice(0, allowedLabels.length)
		.map(([key, value]) => `${key}=${boundText(value, 200)}`);
	const lines = [
		`Rule: ${boundText(rule.title ?? rule.uid, 200)}`,
		`UID: ${rule.uid}`,
		...(rule.folderUID === undefined ? [] : [`Folder: ${rule.folderUID}`]),
		...(rule.ruleGroup === undefined ? [] : [`Group: ${rule.ruleGroup}`]),
		...(rule.condition === undefined ? [] : [`Condition: ${rule.condition}`]),
		...(rule.for === undefined || rule.for === "" ? [] : [`For: ${rule.for}`]),
		...(rule.noDataState === undefined
			? []
			: [`No data state: ${rule.noDataState}`]),
		...(rule.execErrState === undefined
			? []
			: [`Execution error state: ${rule.execErrState}`]),
		...(rule.isPaused === undefined
			? []
			: [`Paused: ${rule.isPaused ? "yes" : "no"}`]),
		...(labels.length === 0 ? [] : [`Labels: ${labels.join(", ")}`]),
		...(annotations.length === 0
			? []
			: [`Annotations: ${annotations.join(", ")}`]),
	];
	return lines.join("\n");
}

async function fetchRule(
	config: Config,
	client: HttpClient,
	input: { ruleUid: string; fetchedAt: string },
): Promise<GrafanaEvidenceResult> {
	const outcome = await client.request(
		`/api/v1/provisioning/alert-rules/${encodeURIComponent(input.ruleUid)}`,
		{ method: "GET" },
		"grafana alert rule",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = grafanaAlertRuleSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const excerpt = capExcerpt(
		redactGrafanaText(ruleExcerpt(parsed.data)),
		GRAFANA_CONTEXT_MAX_EXCERPT_CHARS,
		GRAFANA_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildContextItem({
			kind: "alert_rule",
			title: `Alert rule: ${parsed.data.title ?? parsed.data.uid}`,
			url: `${config.baseUrl}/alerting/grafana/${encodeURIComponent(
				parsed.data.uid,
			)}/view`,
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
		panelUrl?: string;
	},
): Promise<GrafanaEvidenceResult> {
	if (config.metricsUid === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"grafana metrics datasource UID is not configured",
		);
	}
	const request = buildGrafanaMetricRequest({
		uid: config.metricsUid,
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
	});
	const outcome = await postDatasource(client, request, "grafana metrics");
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = grafanaDsQueryResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const result = parsed.data.results?.metrics;
	if (
		result?.error !== undefined ||
		(result?.status !== undefined && result.status >= 400)
	) {
		return { item: null, truncated: true };
	}
	const frames = result?.frames ?? [];
	const collected: MetricSeries[] = [];
	let truncated = false;
	let omittedSeries = 0;
	for (const frame of frames) {
		const extracted = extractGrafanaMetricSeries(frame);
		truncated = truncated || extracted.truncated;
		for (const entry of extracted.series) {
			if (collected.length >= GRAFANA_CONTEXT_MAX_SERIES) {
				omittedSeries += 1;
				continue;
			}
			collected.push(entry);
		}
	}
	if (collected.length === 0) {
		return { item: null, truncated: truncated || omittedSeries > 0 };
	}
	const summary = renderGrafanaMetricSummary({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
		series: collected,
		omittedSeries,
		truncatedPoints: truncated,
	});
	const url = safeUrl(input.panelUrl) ?? safeUrl(input.dashboardUrl);
	return {
		item: buildContextItem({
			kind: "metrics",
			title: `Metrics window (${collected.length} series)`,
			url: url ?? `${config.baseUrl}/explore`,
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
		panelUrl?: string;
	},
): Promise<GrafanaEvidenceResult> {
	if (config.logsUid === null) {
		// Logs are optional evidence; a missing datasource is not a failure.
		return { item: null, truncated: true };
	}
	const request = buildGrafanaLogRequest({
		uid: config.logsUid,
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
	});
	const outcome = await postDatasource(client, request, "grafana logs");
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = grafanaDsQueryResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const result = parsed.data.results?.logs;
	if (
		result?.error !== undefined ||
		(result?.status !== undefined && result.status >= 400)
	) {
		return { item: null, truncated: true };
	}
	const frames = result?.frames ?? [];
	const lines: string[] = [];
	let truncated = false;
	for (const frame of frames) {
		const extracted = logLinesOf(frame);
		truncated = truncated || extracted.truncated;
		for (const entry of extracted.lines) lines.push(entry.line);
	}
	if (lines.length === 0) return { item: null, truncated };
	const tail = lines.slice(-GRAFANA_CONTEXT_MAX_LOG_LINES);
	if (tail.length < lines.length) truncated = true;
	const summary = renderGrafanaLogTail({
		service: input.service,
		fromMs: input.fromMs,
		toMs: input.toMs,
		lines: tail,
		truncated,
	});
	const url = safeUrl(input.panelUrl) ?? safeUrl(input.dashboardUrl);
	return {
		item: buildContextItem({
			kind: "logs",
			title: `Log tail (${tail.length} lines)`,
			url: url ?? `${config.baseUrl}/explore`,
			excerpt: summary.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: summary.truncated,
	};
}

function validateInput(
	input: GrafanaContextInput,
	config: Config,
): {
	service: string;
	alertRuleUid: string | null;
	window: GrafanaWindow;
	dashboardUrl: string | undefined;
	panelUrl: string | undefined;
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
	const service = nonEmpty(input.service);
	if (service === null || service.length > 128) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	const alertRuleUid = optionalUid(input.alertRuleUid, "alertRuleUid");
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"grafana clock is unavailable",
		);
	}
	return {
		service,
		alertRuleUid,
		window: resolveGrafanaWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		dashboardUrl: safeUrl(input.dashboardUrl),
		panelUrl: safeUrl(input.panelUrl),
	};
}

/**
 * Fixed three-call plan. Throws only `PlatformError` with a fixed message:
 * no URL, header, token or provider text is ever part of an error.
 */
export async function fetchGrafanaContext(
	dependencies: GrafanaContextDependencies,
	input: GrafanaContextInput,
): Promise<ContextBundle> {
	const config = prepare(dependencies);
	const validated = validateInput(input, config);
	if (config.metricsUid === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"grafana metrics datasource UID is not configured",
		);
	}
	const client = createClient(config);
	const fetchedAt = new Date(config.now()).toISOString();

	const rule =
		validated.alertRuleUid === null
			? { item: null, truncated: true }
			: await fetchRule(config, client, {
					ruleUid: validated.alertRuleUid,
					fetchedAt,
				});
	const metrics = await fetchMetrics(config, client, {
		service: validated.service,
		fromMs: validated.window.fromMs,
		toMs: validated.window.toMs,
		fetchedAt,
		dashboardUrl: validated.dashboardUrl,
		panelUrl: validated.panelUrl,
	});
	const logs = await fetchLogs(config, client, {
		service: validated.service,
		fromMs: validated.window.fromMs,
		toMs: validated.window.toMs,
		fetchedAt,
		dashboardUrl: validated.dashboardUrl,
		panelUrl: validated.panelUrl,
	});

	const maxItems = Math.max(
		1,
		Math.min(
			dependencies.maxItems ?? GRAFANA_CONTEXT_MAX_ITEMS,
			GRAFANA_CONTEXT_MAX_ITEMS,
		),
	);
	const maxExcerptChars = Math.max(
		1,
		Math.min(
			dependencies.maxExcerptChars ?? GRAFANA_CONTEXT_MAX_EXCERPT_CHARS,
			GRAFANA_CONTEXT_MAX_EXCERPT_CHARS,
		),
	);
	const encoder = new TextEncoder();
	const items: ContextItem[] = [];
	let usedBytes = 0;
	let truncated = rule.truncated || metrics.truncated || logs.truncated;

	for (const candidate of [rule.item, metrics.item, logs.item]) {
		if (candidate === null) continue;
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = GRAFANA_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
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
			"grafana context bundle violated the shared contract",
		);
	}
	return parsedBundle.data;
}

/**
 * Single-resource variants used by the read-only tools. Each has its own call
 * budget and the same caps; none mutates provider state.
 */
export async function fetchGrafanaAlertRuleEvidence(
	dependencies: GrafanaContextDependencies,
	input: { ruleUid: string; fetchedAt?: string },
): Promise<GrafanaEvidenceResult> {
	const config = prepare(dependencies);
	const ruleUid = requireUid(input.ruleUid, "ruleUid");
	return fetchRule(config, createClient(config), {
		ruleUid,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
}

export async function fetchGrafanaMetricEvidence(
	dependencies: GrafanaContextDependencies,
	input: {
		service: string;
		startsAt?: string;
		windowMinutes?: number;
		dashboardUrl?: string;
		panelUrl?: string;
	},
): Promise<GrafanaEvidenceResult> {
	const config = prepare(dependencies);
	const service = nonEmpty(input.service);
	if (service === null || service.length > 128) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	const nowMs = config.now();
	return fetchMetrics(config, createClient(config), {
		service,
		...resolveGrafanaWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		fetchedAt: new Date(nowMs).toISOString(),
		dashboardUrl: safeUrl(input.dashboardUrl),
		panelUrl: safeUrl(input.panelUrl),
	});
}

export async function fetchGrafanaLogEvidence(
	dependencies: GrafanaContextDependencies,
	input: {
		service: string;
		startsAt?: string;
		windowMinutes?: number;
		dashboardUrl?: string;
		panelUrl?: string;
	},
): Promise<GrafanaEvidenceResult> {
	const config = prepare(dependencies);
	const service = nonEmpty(input.service);
	if (service === null || service.length > 128) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	const nowMs = config.now();
	return fetchLogs(config, createClient(config), {
		service,
		...resolveGrafanaWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
		fetchedAt: new Date(nowMs).toISOString(),
		dashboardUrl: safeUrl(input.dashboardUrl),
		panelUrl: safeUrl(input.panelUrl),
	});
}
