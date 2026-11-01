import { createHash } from "node:crypto";
import {
	CONTEXT_SHA256_PATTERN,
	type ContextBundle,
	type ContextItem,
	contextTrustLevelSchema,
	incidentUrlSchema,
	isRepoRelativePath,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_KIND_CHARS,
	MAX_CONTEXT_TITLE_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { readBoundedJson } from "../http/bounded-body";
import { redactSignozText } from "./redact";
import {
	isBoundedSignozPromql,
	MAX_SIGNOZ_METRIC_SUMMARY_CHARS,
	MAX_SIGNOZ_POINTS,
	MAX_SIGNOZ_QUERY_CHARS,
	MAX_SIGNOZ_RULES,
	MAX_SIGNOZ_SERIES,
	SIGNOZ_RULE_ID_PATTERN,
	type SignozQueryRangeRequest,
	type SignozQueryRangeResponse,
	type SignozRule,
	signozQueryRangeRequestSchema,
	signozQueryRangeResponseSchema,
	signozRuleListResponseSchema,
	signozRuleResponseSchema,
} from "./schemas";

/**
 * SigNoz read-only context reader (`docs/connectors/signoz.md` §5).
 *
 * One read-only API key (`SIGNOZ-API-KEY` header), a fixed two-call plan and no
 * model-authored query, datasource or time range:
 *
 * 1. `GET /api/v1/rules/{id}` — alert-rule metadata (when a rule id is known);
 * 2. `POST /api/v5/query_range` — one PromQL window built from that rule's own
 *    expression, keyed to the incident window.
 *
 * Log aggregates are count-only in the design and are **not** implemented
 * here: this reader never fetches raw log bodies, span attributes or trace
 * payloads. When the rule is a builder/threshold rule (no PromQL), the metric
 * query is skipped and `truncated` says so rather than inventing a query.
 *
 * Caps are enforced, not estimated: ≤2 provider calls, ≤5 series, ≤20 points
 * per series, a ≤1,500-char metric summary, 4,000-char items, 256 KiB per
 * response and per bundle, 10 s per call (clamped to 30 s), a 15–60 minute
 * window that never reaches further back than 60 minutes. Redaction runs
 * **before** every truncation. A partial bundle is valid; `truncated` reports
 * every 403/404, dropped series, cap hit or parse failure.
 *
 * Error mapping (`docs/connector-usage.md` §7): 401 and transport/timeout →
 * `INTEGRATION_UNAVAILABLE`, 429 → `RATE_LIMITED`, 403/404 on an optional
 * resource → drop it and set `truncated`, 5xx or malformed JSON → drop it and
 * set `truncated`.
 *
 * `source` is `"signoz"`, which `INCIDENT_SOURCES` does not yet contain, so the
 * item/bundle types are local (`SignozContextItem` / `SignozContextBundle`).
 * A contract commit must add `"signoz"` before the worker can consume them.
 */

export type SignozContextItem = Omit<ContextItem, "source"> & {
	source: "signoz";
};

export type SignozContextBundle = Omit<ContextBundle, "items"> & {
	items: SignozContextItem[];
};

export const SIGNOZ_CONTEXT_MAX_ITEMS = 8;
export const SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const SIGNOZ_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
/** Rule lookup plus one query_range; the design's optional aggregates are out. */
export const SIGNOZ_CONTEXT_MAX_FETCH_CALLS = 2;
export const SIGNOZ_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
export const SIGNOZ_CONTEXT_MAX_SERIES = MAX_SIGNOZ_SERIES;
export const SIGNOZ_CONTEXT_MAX_POINTS = MAX_SIGNOZ_POINTS;
export const SIGNOZ_CONTEXT_MAX_METRIC_SUMMARY_CHARS =
	MAX_SIGNOZ_METRIC_SUMMARY_CHARS;
export const SIGNOZ_CONTEXT_MIN_WINDOW_MINUTES = 15;
export const SIGNOZ_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const SIGNOZ_CONTEXT_DEFAULT_WINDOW_MINUTES = 30;
/** The metric window starts this long before `startsAt`. */
export const SIGNOZ_CONTEXT_PRE_START_MINUTES = 15;
/** API key header documented by SigNoz [S3]. */
export const SIGNOZ_API_KEY_HEADER = "SIGNOZ-API-KEY";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_BASE_URL_CHARS = 300;
const MAX_BASE_PATH_CHARS = 200;
const REQUEST_USER_AGENT = "isolate-platform";
const MAX_SERVICE_CHARS = 128;
const MAX_SUMMARY_SERIES_LABELS = 6;
const MAX_SUMMARY_LABEL_VALUE_CHARS = 80;

export type SignozFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type SignozContextDependencies = {
	/** SigNoz instance URL: https, no userinfo, no query or fragment. */
	baseUrl: string;
	/** Read-only API key; only ever placed in the `SIGNOZ-API-KEY` header. */
	apiKey: string;
	fetchImpl?: SignozFetchLike;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the per-source budget (8). */
	maxItems?: number;
	maxExcerptChars?: number;
};

export type SignozContextInput = {
	incidentFingerprint: string;
	service: string;
	/** Rule id from the signal; enables the rule lookup and the PromQL query. */
	ruleId?: string | null;
	startsAt?: string;
	windowMinutes?: number;
};

export type SignozEvidenceResult = {
	item: SignozContextItem | null;
	/** True when evidence was dropped, capped or malformed. */
	truncated: boolean;
};

type Config = {
	baseUrl: string;
	apiKey: string;
	fetchImpl: SignozFetchLike;
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

export type SignozWindow = { fromMs: number; toMs: number };

type MetricSeries = {
	name: string;
	points: Array<{ t: number; v: number }>;
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

/** Validates and canonicalizes the instance URL; throws a fixed error. */
export function normalizeSignozBaseUrl(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_BASE_URL_CHARS
	) {
		throw new PlatformError("VALIDATION_FAILED", "signoz baseUrl is invalid");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "signoz baseUrl is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PlatformError("VALIDATION_FAILED", "signoz baseUrl is invalid");
	}
	if (url.pathname.length > MAX_BASE_PATH_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "signoz baseUrl is invalid");
	}
	const pathname =
		url.pathname.endsWith("/") && url.pathname.length > 1
			? url.pathname.slice(0, -1)
			: url.pathname;
	return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function prepare(dependencies: SignozContextDependencies): Config {
	if (dependencies === null || typeof dependencies !== "object") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"signoz connection is not configured",
		);
	}
	const baseUrl = normalizeSignozBaseUrl(dependencies.baseUrl);
	const apiKey = nonEmpty(dependencies.apiKey);
	if (apiKey === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"signoz API key is not configured",
		);
	}
	const timeoutMs = Math.min(
		MAX_TIMEOUT_MS,
		Math.max(MIN_TIMEOUT_MS, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	);
	return {
		baseUrl,
		apiKey,
		fetchImpl:
			dependencies.fetchImpl ?? ((request, init) => fetch(request, init)),
		now: dependencies.now ?? (() => Date.now()),
		timeoutMs,
	};
}

function createClient(config: Config): HttpClient {
	const client: HttpClient = {
		calls: 0,
		async request(path, init, step) {
			if (client.calls >= SIGNOZ_CONTEXT_MAX_FETCH_CALLS) {
				return { kind: "failed" };
			}
			client.calls += 1;
			let response: Response;
			try {
				response = await config.fetchImpl(`${config.baseUrl}${path}`, {
					...init,
					headers: {
						Accept: "application/json",
						"User-Agent": REQUEST_USER_AGENT,
						[SIGNOZ_API_KEY_HEADER]: config.apiKey,
						...(init.headers as Record<string, string> | undefined),
					},
					// Refuse redirects: a provider hop must not forward the key.
					redirect: "error",
					signal: AbortSignal.timeout(config.timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed to reach signoz`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by signoz (status 401)`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by signoz`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > SIGNOZ_CONTEXT_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			// Chunked read: an oversized stream is abandoned at the cap, never buffered.
			const read = await readBoundedJson(response, {
				maxBytes: SIGNOZ_CONTEXT_MAX_RESPONSE_BYTES,
			});
			if (!read.ok) return { kind: "failed" };
			return { kind: "ok", body: read.data };
		},
	};
	return client;
}

export function clampSignozWindowMinutes(value: number | undefined): number {
	const minutes = value ?? SIGNOZ_CONTEXT_DEFAULT_WINDOW_MINUTES;
	if (!Number.isFinite(minutes)) {
		return SIGNOZ_CONTEXT_DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(
		SIGNOZ_CONTEXT_MAX_WINDOW_MINUTES,
		Math.max(SIGNOZ_CONTEXT_MIN_WINDOW_MINUTES, Math.round(minutes)),
	);
}

/**
 * Incident window: `startsAt − 15 min` through `now`, never wider than 60
 * minutes, never backfilled beyond that. A future `startsAt` is clamped to now.
 */
export function resolveSignozWindow(input: {
	nowMs: number;
	startsAt?: string;
	windowMinutes?: number;
}): SignozWindow {
	const spanMs = clampSignozWindowMinutes(input.windowMinutes) * 60_000;
	const toMs = input.nowMs;
	let fromMs = toMs - spanMs;
	const startsAt = nonEmpty(input.startsAt);
	if (startsAt !== null) {
		const parsed = z.iso.datetime({ offset: true }).safeParse(startsAt);
		if (parsed.success) {
			const startMs = Math.min(Date.parse(parsed.data), toMs);
			fromMs = Math.max(
				startMs - SIGNOZ_CONTEXT_PRE_START_MINUTES * 60_000,
				toMs - SIGNOZ_CONTEXT_MAX_WINDOW_MINUTES * 60_000,
			);
		}
	}
	if (!(fromMs < toMs)) fromMs = toMs - 15 * 60_000;
	return { fromMs, toMs };
}

/**
 * The only query template in this connector. `stepInterval` is chosen so the
 * series never exceeds 20 points; a caller-supplied step can widen it but
 * never below the floor implied by the point cap.
 */
export function buildSignozQueryRangeRequest(input: {
	query: string;
	fromMs: number;
	toMs: number;
	stepSeconds?: number;
}): SignozQueryRangeRequest {
	const spanSeconds = Math.max(
		1,
		Math.ceil((input.toMs - input.fromMs) / 1000),
	);
	const minimumStep = Math.max(
		30,
		Math.ceil(spanSeconds / SIGNOZ_CONTEXT_MAX_POINTS),
	);
	const requested = input.stepSeconds ?? minimumStep;
	const stepInterval = Math.min(
		300,
		Math.max(minimumStep, Math.round(requested)),
	);
	return {
		start: input.fromMs,
		end: input.toMs,
		stepInterval,
		compositeQuery: {
			queryType: "promql",
			panelType: "graph",
			promQueries: {
				A: {
					queryName: "A",
					promql: input.query.trim().slice(0, MAX_SIGNOZ_QUERY_CHARS),
				},
			},
		},
	};
}

/** A rule contributes a query only when it is explicitly a PromQL rule. */
export function signozRulePromql(rule: SignozRule): string | null {
	const ruleType = (rule.ruleType ?? "").toLowerCase();
	if (!ruleType.includes("promql")) return null;
	const candidate = nonEmpty(rule.alert);
	if (candidate === null) return null;
	return isBoundedSignozPromql(candidate) ? candidate : null;
}

function ruleExcerpt(rule: SignozRule): string {
	const allowedLabels = [
		"service.name",
		"service_name",
		"severity",
		"environment",
		"env",
		"namespace",
		"cluster",
		"deployment",
	];
	const labels = Object.entries(rule.labels ?? {})
		.filter(([key]) => allowedLabels.includes(key.toLowerCase()))
		.slice(0, allowedLabels.length)
		.map(([key, value]) => `${key}=${boundText(value, 200)}`);
	const annotations = Object.entries(rule.annotations ?? {})
		.filter(([key]) => ["summary", "description", "runbook_url"].includes(key))
		.slice(0, 3)
		.map(([key, value]) => `${key}=${boundText(value, 500)}`);
	const lines = [
		`Rule: ${boundText(rule.alertName ?? rule.id, 200)}`,
		`ID: ${rule.id}`,
		...(rule.ruleType === undefined || rule.ruleType === null
			? []
			: [`Type: ${boundText(rule.ruleType, 64)}`]),
		...(rule.state === undefined || rule.state === null
			? []
			: [`State: ${boundText(rule.state, 64)}`]),
		...(rule.evalWindow === undefined || rule.evalWindow === null
			? []
			: [`Evaluation window: ${boundText(rule.evalWindow, 32)}`]),
		...(rule.frequency === undefined || rule.frequency === null
			? []
			: [`Frequency: ${boundText(rule.frequency, 32)}`]),
		...(rule.disabled === true ? ["Disabled: yes"] : []),
		...(rule.description === undefined || rule.description === null
			? []
			: [`Description: ${boundText(rule.description, 500)}`]),
		...(labels.length === 0 ? [] : [`Labels: ${labels.join(", ")}`]),
		...(annotations.length === 0
			? []
			: [`Annotations: ${annotations.join(", ")}`]),
	];
	return lines.join("\n");
}

function buildContextItem(input: {
	kind: string;
	title: string;
	url: string | undefined;
	excerpt: string;
	fetchedAt: string;
}): SignozContextItem {
	return {
		source: "signoz",
		kind: input.kind,
		title: boundText(redactSignozText(input.title), 200),
		...(input.url === undefined ? {} : { url: input.url }),
		excerpt: input.excerpt,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(input.excerpt),
	};
}

type RuleEvidence = SignozEvidenceResult & { promql: string | null };

async function loadRule(
	config: Config,
	client: HttpClient,
	input: { ruleId: string; fetchedAt: string },
): Promise<RuleEvidence> {
	const outcome = await client.request(
		`/api/v1/rules/${encodeURIComponent(input.ruleId)}`,
		{ method: "GET" },
		"signoz alert rule",
	);
	if (outcome.kind !== "ok") {
		return { item: null, truncated: true, promql: null };
	}
	const parsed = signozRuleResponseSchema.safeParse(outcome.body);
	const rule = parsed.success ? parsed.data.data : undefined;
	if (rule === undefined || rule === null) {
		return { item: null, truncated: true, promql: null };
	}
	if (!SIGNOZ_RULE_ID_PATTERN.test(rule.id)) {
		return { item: null, truncated: true, promql: null };
	}
	const excerpt = capExcerpt(
		redactSignozText(ruleExcerpt(rule)),
		SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS,
		SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildContextItem({
			kind: "alert_rule",
			title: `Alert rule: ${rule.alertName ?? rule.id}`,
			url: `${config.baseUrl}/alerts/rules/${encodeURIComponent(rule.id)}`,
			excerpt: excerpt.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: excerpt.truncated,
		promql: signozRulePromql(rule),
	};
}

const SERIES_LABEL_KEYS: ReadonlySet<string> = new Set([
	"service.name",
	"service_name",
	"servicename",
	"service",
	"operation",
	"operation_name",
	"operationname",
	"scope_name",
	"http_status_code",
	"status_code",
	"deployment.environment",
	"environment",
	"job",
	"k8s.deployment.name",
	"le",
	"quantile",
]);

function seriesName(
	labels: Record<string, string> | undefined,
	index: number,
): string {
	if (labels === undefined) return `series_${index + 1}`;
	const parts = Object.entries(labels)
		.filter(([key]) => SERIES_LABEL_KEYS.has(key.toLowerCase()))
		.slice(0, MAX_SUMMARY_SERIES_LABELS)
		.map(
			([key, value]) =>
				`${key}="${boundText(value, MAX_SUMMARY_LABEL_VALUE_CHARS)}"`,
		);
	return parts.length === 0 ? `series_${index + 1}` : parts.join(", ");
}

function numericValue(value: number | string | null): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Keeps the most recent points and at most five series. */
export function extractSignozSeries(response: SignozQueryRangeResponse): {
	series: MetricSeries[];
	truncated: boolean;
} {
	const results = response.data?.data?.results ?? [];
	const series: MetricSeries[] = [];
	let truncated = false;
	for (const result of results) {
		for (const entry of result.series ?? []) {
			const points: Array<{ t: number; v: number }> = [];
			for (const point of entry.values ?? []) {
				const numeric = numericValue(point.value);
				if (numeric === null) continue;
				points.push({ t: point.timestamp, v: numeric });
			}
			if (points.length === 0) continue;
			points.sort((left, right) => left.t - right.t);
			if (points.length > SIGNOZ_CONTEXT_MAX_POINTS) {
				points.splice(0, points.length - SIGNOZ_CONTEXT_MAX_POINTS);
				truncated = true;
			}
			if (series.length >= SIGNOZ_CONTEXT_MAX_SERIES) {
				truncated = true;
				continue;
			}
			series.push({ name: seriesName(entry.labels, series.length), points });
		}
	}
	return { series, truncated };
}

function shortNumber(value: number): string {
	return String(Number(value.toPrecision(6)));
}

function isoOrEmpty(ms: number): string {
	return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export function renderSignozMetricSummary(input: {
	service: string;
	query: string;
	fromMs: number;
	toMs: number;
	series: MetricSeries[];
	truncatedPoints: boolean;
}): { text: string; truncated: boolean } {
	const lines = [
		`Metrics window: ${isoOrEmpty(input.fromMs)} → ${isoOrEmpty(input.toMs)}`,
		`Service: ${boundText(input.service, MAX_SERVICE_CHARS)}`,
		`Query: ${boundText(input.query, 200)}`,
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
	if (input.truncatedPoints) lines.push("Points/series truncated to the cap.");
	const capped = capExcerpt(
		redactSignozText(lines.join("\n")),
		SIGNOZ_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
		SIGNOZ_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
	);
	return {
		text: capped.text,
		truncated: capped.truncated || input.truncatedPoints,
	};
}

async function fetchMetrics(
	config: Config,
	client: HttpClient,
	input: {
		service: string;
		query: string;
		fromMs: number;
		toMs: number;
		stepSeconds?: number;
		fetchedAt: string;
	},
): Promise<SignozEvidenceResult> {
	const request = buildSignozQueryRangeRequest({
		query: input.query,
		fromMs: input.fromMs,
		toMs: input.toMs,
		...(input.stepSeconds === undefined
			? {}
			: { stepSeconds: input.stepSeconds }),
	});
	const template = signozQueryRangeRequestSchema.safeParse(request);
	if (!template.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"signoz query_range request violated its template",
		);
	}
	const outcome = await client.request(
		"/api/v5/query_range",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(template.data),
		},
		"signoz query_range",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = signozQueryRangeResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	if (
		(parsed.data.status !== undefined && parsed.data.status !== "success") ||
		parsed.data.error !== undefined
	) {
		return { item: null, truncated: true };
	}
	const extracted = extractSignozSeries(parsed.data);
	if (extracted.series.length === 0) {
		return { item: null, truncated: true };
	}
	const summary = renderSignozMetricSummary({
		service: input.service,
		query: input.query,
		fromMs: input.fromMs,
		toMs: input.toMs,
		series: extracted.series,
		truncatedPoints: extracted.truncated,
	});
	return {
		item: buildContextItem({
			kind: "metrics",
			title: `Metrics window (${extracted.series.length} series)`,
			url: `${config.baseUrl}/services`,
			excerpt: summary.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: summary.truncated,
	};
}

function validateContextInput(
	input: SignozContextInput,
	config: Config,
): {
	service: string;
	ruleId: string | null;
	window: SignozWindow;
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
	if (service === null || service.length > MAX_SERVICE_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	const ruleId = nonEmpty(input.ruleId);
	if (ruleId !== null && !SIGNOZ_RULE_ID_PATTERN.test(ruleId)) {
		throw new PlatformError("VALIDATION_FAILED", "ruleId is not a SigNoz id");
	}
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"signoz clock is unavailable",
		);
	}
	return {
		service,
		ruleId,
		window: resolveSignozWindow({
			nowMs,
			...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
			...(input.windowMinutes === undefined
				? {}
				: { windowMinutes: input.windowMinutes }),
		}),
	};
}

/**
 * The shared `ContextItem` contract minus `source`, restated locally because
 * `INCIDENT_SOURCES` does not yet contain `"signoz"` (a contract commit must
 * add it). Field caps and URL rules are the shared ones, not new numbers.
 */
const signozItemShape = z
	.strictObject({
		kind: z.string().trim().min(1).max(MAX_CONTEXT_KIND_CHARS),
		title: z.string().trim().min(1).max(MAX_CONTEXT_TITLE_CHARS),
		url: incidentUrlSchema.optional(),
		path: z
			.string()
			.refine(isRepoRelativePath, "repo-relative path required")
			.optional(),
		excerpt: z.string().max(MAX_CONTEXT_EXCERPT_CHARS),
		fetchedAt: z.iso.datetime({ offset: true }),
		trustLevel: contextTrustLevelSchema,
		sha256: z.string().regex(CONTEXT_SHA256_PATTERN),
	})
	.strict()
	.refine((item) => item.url !== undefined || item.path !== undefined, {
		message: "context item requires a url or a path",
	});

function validateItem(item: SignozContextItem): void {
	const parsed = signozItemShape.safeParse({
		kind: item.kind,
		title: item.title,
		...(item.url === undefined ? {} : { url: item.url }),
		excerpt: item.excerpt,
		fetchedAt: item.fetchedAt,
		trustLevel: item.trustLevel,
		sha256: item.sha256,
	});
	if (!parsed.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"signoz context item violated the shared contract",
		);
	}
}

/**
 * Applies the per-bundle caps (items, excerpt chars, total bytes), rebuilds
 * every hash over the redacted/truncated excerpt and validates each item
 * against the shared contract minus `source`.
 */
function assembleBundle(input: {
	incidentFingerprint: string;
	candidates: SignozContextItem[];
	truncated: boolean;
	maxItems: number;
	maxExcerptChars: number;
}): SignozContextBundle {
	const encoder = new TextEncoder();
	const items: SignozContextItem[] = [];
	let usedBytes = 0;
	let truncated = input.truncated;
	for (const candidate of input.candidates) {
		if (items.length >= input.maxItems) {
			truncated = true;
			break;
		}
		const remaining = SIGNOZ_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
		if (remaining < 64) {
			truncated = true;
			break;
		}
		const capped = capExcerpt(
			candidate.excerpt,
			input.maxExcerptChars,
			Math.min(remaining, input.maxExcerptChars * 4),
		);
		if (capped.text.trim().length === 0) {
			truncated = true;
			continue;
		}
		if (capped.truncated) truncated = true;
		const item: SignozContextItem = {
			...candidate,
			excerpt: capped.text,
			sha256: sha256Hex(capped.text),
		};
		validateItem(item);
		items.push(item);
		usedBytes += encoder.encode(capped.text).byteLength;
	}
	const fingerprint = input.incidentFingerprint.trim();
	const bundle: SignozContextBundle = {
		incidentFingerprint: fingerprint,
		items,
		truncated,
	};
	if (
		fingerprint.length === 0 ||
		fingerprint.length > 128 ||
		items.length > MAX_CONTEXT_ITEMS ||
		encoder.encode(items.map((item) => item.excerpt).join("")).byteLength >
			SIGNOZ_CONTEXT_MAX_TOTAL_EXCERPT_BYTES
	) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"signoz context bundle violated the shared contract",
		);
	}
	return bundle;
}

/**
 * Fixed two-call plan. Throws only `PlatformError` with a fixed message: no
 * URL, header, key or provider text is ever part of an error.
 */
export async function fetchSignozContext(
	dependencies: SignozContextDependencies,
	input: SignozContextInput,
): Promise<SignozContextBundle> {
	const config = prepare(dependencies);
	const validated = validateContextInput(input, config);
	const client = createClient(config);
	const fetchedAt = new Date(config.now()).toISOString();

	const rule =
		validated.ruleId === null
			? { item: null, truncated: false, promql: null }
			: await loadRule(config, client, {
					ruleId: validated.ruleId,
					fetchedAt,
				});

	const metrics =
		rule.promql === null
			? { item: null, truncated: true }
			: await fetchMetrics(config, client, {
					service: validated.service,
					query: rule.promql,
					fromMs: validated.window.fromMs,
					toMs: validated.window.toMs,
					fetchedAt,
				});

	const maxItems = Math.max(
		1,
		Math.min(
			dependencies.maxItems ?? SIGNOZ_CONTEXT_MAX_ITEMS,
			SIGNOZ_CONTEXT_MAX_ITEMS,
		),
	);
	const maxExcerptChars = Math.max(
		1,
		Math.min(
			dependencies.maxExcerptChars ?? SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS,
			SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS,
		),
	);

	const candidates: SignozContextItem[] = [];
	if (rule.item !== null) candidates.push(rule.item);
	if (metrics.item !== null) candidates.push(metrics.item);

	return assembleBundle({
		incidentFingerprint: input.incidentFingerprint,
		candidates,
		truncated: rule.truncated || metrics.truncated || metrics.item === null,
		maxItems,
		maxExcerptChars,
	});
}

/**
 * Single-resource variants used by the read-only tools. Each has its own call
 * budget and the same caps; none mutates provider state.
 */
export async function fetchSignozRuleEvidence(
	dependencies: SignozContextDependencies,
	input: { ruleId: string; fetchedAt?: string },
): Promise<SignozEvidenceResult> {
	const config = prepare(dependencies);
	const ruleId = nonEmpty(input.ruleId);
	if (ruleId === null || !SIGNOZ_RULE_ID_PATTERN.test(ruleId)) {
		throw new PlatformError("VALIDATION_FAILED", "ruleId is not a SigNoz id");
	}
	const rule = await loadRule(config, createClient(config), {
		ruleId,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
	return { item: rule.item, truncated: rule.truncated };
}

/**
 * `signoz.query_range` evidence: one bounded query over the incident window.
 * The query is caller-supplied but validated by `isBoundedSignozPromql`.
 */
export async function fetchSignozQueryEvidence(
	dependencies: SignozContextDependencies,
	input: {
		service: string;
		query: string;
		startsAt?: string;
		windowMinutes?: number;
		stepSeconds?: number;
	},
): Promise<SignozEvidenceResult> {
	const config = prepare(dependencies);
	const service = nonEmpty(input.service);
	if (service === null || service.length > MAX_SERVICE_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	if (!isBoundedSignozPromql(input.query)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"query is not a bounded PromQL expression",
		);
	}
	const nowMs = config.now();
	return fetchMetrics(config, createClient(config), {
		service,
		query: input.query.trim(),
		...resolveSignozWindow({
			nowMs,
			...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
			...(input.windowMinutes === undefined
				? {}
				: { windowMinutes: input.windowMinutes }),
		}),
		...(input.stepSeconds === undefined
			? {}
			: { stepSeconds: input.stepSeconds }),
		fetchedAt: new Date(nowMs).toISOString(),
	});
}

/**
 * `signoz.list_rules` evidence: a bounded rule summary. Rule definitions are
 * metadata only (id, name, type, state); expressions, channel destinations and
 * webhook URLs are never rendered.
 */
export async function fetchSignozRuleListEvidence(
	dependencies: SignozContextDependencies,
	input: { limit?: number; state?: string | null; ruleType?: string | null },
): Promise<SignozEvidenceResult> {
	const config = prepare(dependencies);
	const limit = Math.max(
		1,
		Math.min(input.limit ?? MAX_SIGNOZ_RULES, MAX_SIGNOZ_RULES),
	);
	const client = createClient(config);
	const outcome = await client.request(
		"/api/v1/rules",
		{ method: "GET" },
		"signoz rule list",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = signozRuleListResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const all = (parsed.data.data?.rules ?? []).filter(
		(rule): rule is SignozRule => rule !== null,
	);
	const stateFilter = nonEmpty(input.state)?.toLowerCase();
	const typeFilter = nonEmpty(input.ruleType)?.toLowerCase();
	const filtered = all.filter((rule) => {
		if (
			stateFilter !== undefined &&
			(rule.state ?? "").toLowerCase() !== stateFilter
		) {
			return false;
		}
		if (
			typeFilter !== undefined &&
			!(rule.ruleType ?? "").toLowerCase().includes(typeFilter)
		) {
			return false;
		}
		return true;
	});
	const selected = filtered.slice(0, limit);
	const truncated = filtered.length > selected.length;
	if (selected.length === 0) return { item: null, truncated };
	const lines = [
		`SigNoz alert rules: ${selected.length} of ${filtered.length} shown (${all.length} returned)`,
		...selected.map(
			(rule) =>
				`- ${rule.id} — ${boundText(rule.alertName ?? "unnamed", 120)} — ${boundText(
					rule.ruleType ?? "unknown",
					48,
				)} — ${boundText(rule.state ?? "unknown", 48)}`,
		),
	];
	const excerpt = capExcerpt(
		redactSignozText(lines.join("\n")),
		SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS,
		SIGNOZ_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildContextItem({
			kind: "rule_list",
			title: `Alert rules (${selected.length} shown)`,
			url: `${config.baseUrl}/alerts/rules`,
			excerpt: excerpt.text,
			fetchedAt: new Date(config.now()).toISOString(),
		}),
		truncated: excerpt.truncated || truncated,
	};
}
