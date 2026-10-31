import { createHash } from "node:crypto";
import {
	CONTEXT_SHA256_PATTERN,
	contextTrustLevelSchema,
	incidentUrlSchema,
	isBoundedHttpsUrl,
	isRepoRelativePath,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_KIND_CHARS,
	MAX_CONTEXT_TITLE_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { redactAxiomText } from "./redact";
import {
	AXIOM_DATASET_PATTERN,
	AXIOM_MONITOR_ID_PATTERN,
	type AxiomAplCell,
	type AxiomAplResponse,
	type AxiomDataset,
	type AxiomMonitorDescriptor,
	axiomAplRequestSchema,
	axiomAplResponseSchema,
	axiomDatasetListResponseSchema,
	axiomMonitorSchema,
	MAX_AXIOM_APL_CHARS,
	MAX_AXIOM_APL_FIELDS,
	MAX_AXIOM_DATASETS,
	MAX_AXIOM_SERVICE_CHARS,
} from "./schemas";

/**
 * Axiom read-only context reader (`docs/connectors/axiom.md` §5).
 *
 * One query-only token, a fixed plan and no model-authored query in the
 * context plane:
 *
 * 1. `GET /v1/datasets` — validate the configured dataset against the
 *    allowlist (the local allowlist is enforced **before any request**);
 * 2. `POST /v1/query/_apl?format=tabular` — one bounded aggregate over
 *    `startsAt − 15 min` through `now`, never wider than 60 minutes.
 *
 * Monitor metadata is never fetched: the monitor read path is UNVERIFIED in
 * the connector page, so monitors are resolved from trusted server-side
 * configuration and the webhook payload carries the monitor state.
 *
 * Caps are enforced, not estimated: ≤3 provider calls, ≤20 rendered rows,
 * ≤2,000 characters per summary, ≤4,000 characters per item, 256 KiB per
 * response and per bundle, 8 items. Redaction runs **before** every truncation.
 * A partial bundle is valid; `truncated` reports a 403/404, a dropped table, a
 * cap hit or a parse failure.
 *
 * Error mapping (`docs/connector-usage.md` §7): 401 and transport/timeout →
 * `INTEGRATION_UNAVAILABLE`, 429 → `RATE_LIMITED`, 403/404 on an optional
 * resource → drop it and set `truncated`, 5xx or malformed JSON → drop it.
 */

export const AXIOM_CONTEXT_MAX_ITEMS = 8;
export const AXIOM_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const AXIOM_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const AXIOM_CONTEXT_MAX_FETCH_CALLS = 3;
export const AXIOM_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
export const AXIOM_CONTEXT_MAX_ROWS = 20;
export const AXIOM_CONTEXT_MAX_SUMMARY_CHARS = 2000;
export const AXIOM_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const AXIOM_CONTEXT_MIN_WINDOW_MINUTES = 5;
export const AXIOM_CONTEXT_DEFAULT_WINDOW_MINUTES = 30;
export const AXIOM_CONTEXT_PRE_START_MINUTES = 15;
export const AXIOM_DATASET_LIST_MAX_RENDERED = 50;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BASE_URL_CHARS = 300;
const MAX_BASE_PATH_CHARS = 200;
const REQUEST_USER_AGENT = "isolate-platform";

/**
 * The shared `ContextItem` schema does not yet accept `source: "axiom"`; this
 * is the same contract with only the source narrowed. The coordinator must add
 * `"axiom"` to `INCIDENT_SOURCES` before registration.
 */
export const axiomContextItemSchema = z
	.strictObject({
		source: z.literal("axiom"),
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
export type AxiomContextItem = z.output<typeof axiomContextItemSchema>;

export const axiomContextBundleSchema = z
	.strictObject({
		incidentFingerprint: z
			.string()
			.trim()
			.min(1)
			.max(MAX_INCIDENT_FINGERPRINT_CHARS),
		items: z.array(axiomContextItemSchema).max(MAX_CONTEXT_ITEMS),
		truncated: z.boolean(),
	})
	.strict()
	.refine(
		(bundle) =>
			new TextEncoder().encode(
				bundle.items.map((item) => item.excerpt).join(""),
			).byteLength <= MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		{ message: "total context excerpt exceeds 256 KiB" },
	);
export type AxiomContextBundle = z.output<typeof axiomContextBundleSchema>;

export type AxiomFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type AxiomContextDependencies = {
	/** API host: https, no userinfo, no query or fragment. */
	baseUrl: string;
	/** Query-only Advanced token; only ever in the Authorization header. */
	token: string;
	/** Default dataset; must also be in `allowedDatasets`. */
	dataset: string;
	/** Dataset allowlist; defaults to `[dataset]`. */
	allowedDatasets?: readonly string[];
	/** Trusted monitor registry (the read path is UNVERIFIED). */
	monitors?: readonly AxiomMonitorDescriptor[];
	fetchImpl?: AxiomFetchLike;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the per-source budget (8). */
	maxItems?: number;
	maxExcerptChars?: number;
};

export type AxiomContextInput = {
	incidentFingerprint: string;
	service: string;
	/** Must be in the allowlist; defaults to the configured dataset. */
	dataset?: string;
	monitorId?: string;
	startsAt?: string;
	windowMinutes?: number;
};

export type AxiomEvidenceResult = {
	item: AxiomContextItem | null;
	/** True when evidence was dropped, capped or malformed. */
	truncated: boolean;
};

type Config = {
	baseUrl: string;
	token: string;
	dataset: string;
	allowedDatasets: ReadonlySet<string>;
	monitors: readonly AxiomMonitorDescriptor[];
	fetchImpl: AxiomFetchLike;
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

export type AxiomWindow = { fromMs: number; toMs: number };

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

/** Validates and canonicalizes the API host; throws a fixed error. */
export function normalizeAxiomBaseUrl(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_BASE_URL_CHARS
	) {
		throw new PlatformError("VALIDATION_FAILED", "axiom baseUrl is invalid");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "axiom baseUrl is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PlatformError("VALIDATION_FAILED", "axiom baseUrl is invalid");
	}
	if (url.pathname.length > MAX_BASE_PATH_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "axiom baseUrl is invalid");
	}
	const pathname =
		url.pathname.endsWith("/") && url.pathname.length > 1
			? url.pathname.slice(0, -1)
			: url.pathname;
	return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function requireDataset(
	value: string | null | undefined,
	field: string,
): string {
	const candidate = nonEmpty(value);
	if (candidate === null || !AXIOM_DATASET_PATTERN.test(candidate)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`${field} is not an axiom dataset name`,
		);
	}
	return candidate;
}

function prepare(dependencies: AxiomContextDependencies): Config {
	const baseUrl = normalizeAxiomBaseUrl(dependencies.baseUrl);
	const token = nonEmpty(dependencies.token);
	if (token === null) {
		throw new PlatformError("MISSING_CONFIG", "axiom token is not configured");
	}
	const dataset = requireDataset(dependencies.dataset, "dataset");
	const allowed = new Set<string>();
	for (const entry of dependencies.allowedDatasets ?? [dataset]) {
		allowed.add(requireDataset(entry, "allowedDatasets"));
	}
	if (!allowed.has(dataset)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"axiom dataset is not in the configured allowlist",
		);
	}
	const monitors: AxiomMonitorDescriptor[] = [];
	for (const entry of dependencies.monitors ?? []) {
		const parsed = axiomMonitorSchema.safeParse(entry);
		if (!parsed.success) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"axiom monitor registry entry is invalid",
			);
		}
		monitors.push(parsed.data);
	}
	const timeoutMs = Math.min(
		MAX_TIMEOUT_MS,
		Math.max(1000, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	);
	return {
		baseUrl,
		token,
		dataset,
		allowedDatasets: allowed,
		monitors,
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
			if (client.calls >= AXIOM_CONTEXT_MAX_FETCH_CALLS) {
				return { kind: "failed" };
			}
			client.calls += 1;
			const headers: Record<string, string> = {
				Accept: "application/json",
				"User-Agent": REQUEST_USER_AGENT,
				Authorization: `Bearer ${config.token}`,
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
					`${step} failed to reach axiom`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by axiom (status 401)`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by axiom`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > AXIOM_CONTEXT_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			let text: string;
			try {
				text = await response.text();
			} catch {
				return { kind: "failed" };
			}
			if (encoder.encode(text).byteLength > AXIOM_CONTEXT_MAX_RESPONSE_BYTES) {
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

/* ------------------------------------------------------------------ */
/* APL guard: a single read-only pipeline, dataset-bound, no wildcard. */
/* ------------------------------------------------------------------ */

/** Pipeline operators a read-only APL statement may start a stage with. */
export const AXIOM_APL_ALLOWED_OPERATORS: readonly string[] = [
	"where",
	"summarize",
	"extend",
	"project",
	"project-away",
	"project-keep",
	"order",
	"sort",
	"top",
	"limit",
	"take",
	"count",
	"distinct",
	"bin",
	"make-series",
	"parse",
	"parse-where",
];

/** Functions a read-only APL statement may call. Anything else is rejected. */
export const AXIOM_APL_ALLOWED_FUNCTIONS: readonly string[] = [
	"abs",
	"ago",
	"any",
	"arg_max",
	"arg_min",
	"array_length",
	"avg",
	"bin",
	"bin_auto",
	"case",
	"ceiling",
	"coalesce",
	"count",
	"countif",
	"dcount",
	"endofday",
	"exp",
	"extract",
	"floor",
	"format_datetime",
	"iff",
	"isempty",
	"isnotnull",
	"isnull",
	"log",
	"make_list",
	"make_set",
	"max",
	"max_of",
	"min",
	"min_of",
	"notempty",
	"now",
	"pack",
	"pack_array",
	"parse_csv",
	"parse_json",
	"percentile",
	"replace_string",
	"round",
	"split",
	"sqrt",
	"startofday",
	"startofweek",
	"stdev",
	"strcat",
	"strlen",
	"substring",
	"sum",
	"tobool",
	"todatetime",
	"todouble",
	"toint",
	"tolong",
	"tolower",
	"tostring",
	"toupper",
	"trim",
	"unixtime",
	"variance",
];

const AXIOM_APL_FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
	"alter",
	"attach",
	"call",
	"create",
	"datatable",
	"delete",
	"detach",
	"disable",
	"drop",
	"enable",
	"exec",
	"execute",
	"externaldata",
	"grant",
	"ingest",
	"insert",
	"invoke",
	"let",
	"merge",
	"move",
	"print",
	"rename",
	"replace",
	"revoke",
	"set",
	"truncate",
	"update",
	"upsert",
	"write",
]);

const ALLOWED_OPERATORS = new Set(AXIOM_APL_ALLOWED_OPERATORS);
const ALLOWED_FUNCTIONS = new Set(AXIOM_APL_ALLOWED_FUNCTIONS);

type AplToken = {
	kind: "identifier" | "quoted" | "string" | "number" | "punct";
	value: string;
};

const APL_TOKEN_PATTERN =
	/\s+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[["'][^"']*["']\]|[A-Za-z_][A-Za-z0-9_.-]*|[0-9]+(?:\.[0-9]+)?|[|()[\],=<>!+\-*/%.?:]/y;

function invalidApl(): PlatformError {
	return new PlatformError(
		"VALIDATION_FAILED",
		"axiom APL must be a single read-only pipeline",
	);
}

/** Tokenizes an APL statement; any character outside the grammar rejects it. */
function tokenizeAxiomApl(apl: string): AplToken[] {
	const tokens: AplToken[] = [];
	let index = 0;
	while (index < apl.length) {
		APL_TOKEN_PATTERN.lastIndex = index;
		const match = APL_TOKEN_PATTERN.exec(apl);
		if (match === null || match.index !== index) throw invalidApl();
		const raw = match[0];
		index += raw.length;
		if (/^\s+$/.test(raw)) continue;
		if (raw.startsWith("[")) {
			tokens.push({ kind: "quoted", value: raw.slice(2, -2) });
		} else if (raw.startsWith('"') || raw.startsWith("'")) {
			tokens.push({ kind: "string", value: raw });
		} else if (/^[0-9]/.test(raw)) {
			tokens.push({ kind: "number", value: raw });
		} else if (/^[A-Za-z_]/.test(raw)) {
			tokens.push({ kind: "identifier", value: raw });
		} else {
			tokens.push({ kind: "punct", value: raw });
		}
	}
	return tokens;
}

/** Returns the first (dataset) token of a well-formed statement. */
function firstAxiomAplDataset(tokens: readonly AplToken[]): string | null {
	const first = tokens[0];
	if (first === undefined) return null;
	if (first.kind !== "identifier" && first.kind !== "quoted") return null;
	return AXIOM_DATASET_PATTERN.test(first.value) ? first.value : null;
}

/**
 * Read-only APL allowlist guard. A statement must be one pipeline that begins
 * with a single dataset reference, and every stage must start with an allowed
 * operator. Function calls must be allowlisted; mutation-like keywords,
 * wildcard projections, joins across other datasets and multiple statements are
 * rejected before any request is made.
 */
export function assertReadOnlyAxiomApl(
	apl: string,
	expectedDataset?: string,
): string {
	if (typeof apl !== "string") throw invalidApl();
	const trimmed = apl.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > MAX_AXIOM_APL_CHARS ||
		trimmed.includes("//") ||
		trimmed.includes("\0")
	) {
		throw invalidApl();
	}
	const tokens = tokenizeAxiomApl(trimmed);
	const dataset = firstAxiomAplDataset(tokens);
	if (dataset === null) throw invalidApl();
	const separator = tokens[1];
	if (separator?.kind !== "punct" || separator.value !== "|") {
		throw invalidApl();
	}
	if (expectedDataset !== undefined && dataset !== expectedDataset) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"axiom APL must query the configured dataset",
		);
	}

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token.kind === "punct") {
			if (token.value === "*") throw invalidApl();
			if (token.value === "|") {
				const next = tokens[index + 1];
				if (
					next === undefined ||
					next.kind !== "identifier" ||
					!ALLOWED_OPERATORS.has(next.value.toLowerCase())
				) {
					throw invalidApl();
				}
			}
			continue;
		}
		if (token.kind !== "identifier") continue;
		const lower = token.value.toLowerCase();
		if (AXIOM_APL_FORBIDDEN_KEYWORDS.has(lower)) throw invalidApl();
		const next = tokens[index + 1];
		if (next?.kind === "punct" && next.value === "(") {
			if (!ALLOWED_FUNCTIONS.has(lower)) throw invalidApl();
		}
	}
	return trimmed;
}

/** Dataset reference of a guarded statement, or `null` for an invalid one. */
export function axiomAplDataset(apl: string): string | null {
	try {
		return firstAxiomAplDataset(tokenizeAxiomApl(apl.trim()));
	} catch {
		return null;
	}
}

/** Escapes a service value for an APL string literal; payload text is inert. */
export function escapeAxiomString(value: string): string {
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

/**
 * The only context template: a dataset-bound aggregate over the allowed
 * dimensions. It selects `service`, `environment`, `status` and `error.kind`
 * plus a count — never raw rows and never `project *`.
 */
export function buildAxiomApl(input: {
	dataset: string;
	service: string;
	rowLimit?: number;
}): string {
	const dataset = requireDataset(input.dataset, "dataset");
	const limit = Math.min(
		AXIOM_CONTEXT_MAX_ROWS,
		Math.max(1, Math.trunc(input.rowLimit ?? AXIOM_CONTEXT_MAX_ROWS)),
	);
	return [
		`['${dataset}']`,
		`| where service == "${escapeAxiomString(input.service)}"`,
		"| summarize count = count() by service, environment, status, error_kind = tostring(['error.kind'])",
		"| order by count desc",
		`| limit ${limit}`,
	].join("\n");
}

export function clampAxiomWindowMinutes(value: number | undefined): number {
	const minutes = value ?? AXIOM_CONTEXT_DEFAULT_WINDOW_MINUTES;
	if (!Number.isFinite(minutes)) {
		return AXIOM_CONTEXT_DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(
		AXIOM_CONTEXT_MAX_WINDOW_MINUTES,
		Math.max(AXIOM_CONTEXT_MIN_WINDOW_MINUTES, Math.round(minutes)),
	);
}

/**
 * Incident window: `startsAt − 15 min` through `now`, never wider than 60
 * minutes. A future `startsAt` is clamped to now.
 */
export function resolveAxiomWindow(input: {
	nowMs: number;
	startsAt?: string;
	windowMinutes?: number;
}): AxiomWindow {
	const spanMs = clampAxiomWindowMinutes(input.windowMinutes) * 60_000;
	const toMs = input.nowMs;
	let fromMs = toMs - spanMs;
	const startsAt = nonEmpty(input.startsAt);
	if (startsAt !== null) {
		const parsed = z.iso.datetime({ offset: true }).safeParse(startsAt);
		if (parsed.success) {
			const startMs = Math.min(Date.parse(parsed.data), toMs);
			fromMs = Math.max(
				startMs - AXIOM_CONTEXT_PRE_START_MINUTES * 60_000,
				toMs - AXIOM_CONTEXT_MAX_WINDOW_MINUTES * 60_000,
			);
		}
	}
	if (!(fromMs < toMs)) fromMs = Math.max(0, toMs - 15 * 60_000);
	return { fromMs, toMs };
}

/* ------------------------------------------------------------------ */
/* Evidence building.                                                 */
/* ------------------------------------------------------------------ */

function datasetUrl(config: Config, dataset: string): string {
	return `${config.baseUrl}/datasets/${encodeURIComponent(dataset)}`;
}

function buildContextItem(input: {
	kind: string;
	title: string;
	url: string;
	excerpt: string;
	fetchedAt: string;
}): AxiomContextItem {
	return {
		source: "axiom",
		kind: input.kind,
		title: boundText(redactAxiomText(input.title), 200),
		url: input.url,
		excerpt: input.excerpt,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(input.excerpt),
	};
}

function shortNumber(value: number): string {
	if (!Number.isFinite(value)) return "nan";
	return String(Number(value.toPrecision(8)));
}

function cellText(cell: AxiomAplCell, extraSecrets: readonly string[]): string {
	if (cell === null) return "null";
	if (typeof cell === "number") return shortNumber(cell);
	if (typeof cell === "boolean") return cell ? "true" : "false";
	return boundText(redactAxiomText(cell, extraSecrets), 200);
}

function tableOf(response: AxiomAplResponse): {
	fields: string[];
	rows: AxiomAplCell[][];
} | null {
	for (const match of response.matches ?? []) {
		const fields = match.fields ?? match.columns;
		const rows = match.data ?? match.rows;
		if (fields !== undefined && rows !== undefined) return { fields, rows };
	}
	if (response.columns !== undefined && response.rows !== undefined) {
		return { fields: response.columns, rows: response.rows };
	}
	return null;
}

/**
 * Renders a bounded table: at most 20 rows and 2,000 characters after
 * redaction. Raw rows are never returned; only the aggregate table is.
 */
export function renderAxiomTableSummary(input: {
	dataset: string;
	fromMs: number;
	toMs: number;
	fields: readonly string[];
	rows: readonly (readonly AxiomAplCell[])[];
	totalRows: number;
	extraSecrets?: readonly string[];
}): { text: string; truncated: boolean } {
	const extraSecrets = input.extraSecrets ?? [];
	const shownRows = input.rows.slice(0, AXIOM_CONTEXT_MAX_ROWS);
	let truncated = input.totalRows > shownRows.length;
	const width = Math.min(
		MAX_AXIOM_APL_FIELDS,
		Math.max(
			input.fields.length,
			...shownRows.map((row) => Math.min(row.length, MAX_AXIOM_APL_FIELDS)),
		),
	);
	const headers = Array.from({ length: width }, (_, index) => {
		const name = input.fields[index];
		return boundText(
			redactAxiomText(name === undefined ? `col_${index + 1}` : name),
			64,
		);
	});
	const lines = [
		`Window: ${new Date(input.fromMs).toISOString()} → ${new Date(input.toMs).toISOString()}`,
		`Dataset: ${input.dataset}`,
		`Rows: ${input.totalRows}${shownRows.length < input.totalRows ? ` (showing ${shownRows.length})` : ""}`,
		headers.join(" | "),
	];
	for (const row of shownRows) {
		const cells: string[] = [];
		for (let index = 0; index < width; index += 1) {
			cells.push(cellText(row[index] ?? null, extraSecrets));
		}
		const line = cells.join(" | ");
		if (line.length > 500) truncated = true;
		lines.push(boundText(line, 500));
	}
	const capped = capExcerpt(
		redactAxiomText(lines.join("\n"), extraSecrets),
		AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
		AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
	);
	return { text: capped.text, truncated: truncated || capped.truncated };
}

async function fetchDatasetEvidence(
	config: Config,
	client: HttpClient,
	input: { dataset: string; fetchedAt: string },
): Promise<AxiomEvidenceResult> {
	const outcome = await client.request(
		"/v1/datasets",
		{ method: "GET" },
		"axiom dataset list",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = axiomDatasetListResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const datasets: readonly AxiomDataset[] = parsed.data;
	const found = datasets.find((entry) => entry.name === input.dataset);
	if (found === undefined) return { item: null, truncated: true };
	const excerpt = [
		`Dataset: ${found.name}`,
		`ID: ${found.id ?? "unknown"}`,
	].join("\n");
	return {
		item: buildContextItem({
			kind: "dataset",
			title: `Dataset: ${found.name}`,
			url: datasetUrl(config, input.dataset),
			excerpt,
			fetchedAt: input.fetchedAt,
		}),
		truncated: false,
	};
}

async function fetchAplEvidence(
	config: Config,
	client: HttpClient,
	input: {
		apl: string;
		dataset: string;
		window: AxiomWindow;
		fetchedAt: string;
	},
): Promise<AxiomEvidenceResult> {
	const request = axiomAplRequestSchema.safeParse({
		apl: input.apl,
		startTime: new Date(input.window.fromMs).toISOString(),
		endTime: new Date(input.window.toMs).toISOString(),
	});
	if (!request.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"axiom APL request is invalid",
		);
	}
	const outcome = await client.request(
		"/v1/query/_apl?format=tabular",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request.data),
		},
		"axiom APL query",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = axiomAplResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const table = tableOf(parsed.data);
	if (table === null) return { item: null, truncated: true };
	if (table.rows.length === 0) return { item: null, truncated: false };

	const summary = renderAxiomTableSummary({
		dataset: input.dataset,
		fromMs: input.window.fromMs,
		toMs: input.window.toMs,
		fields: table.fields,
		rows: table.rows.slice(0, AXIOM_CONTEXT_MAX_ROWS),
		totalRows: table.rows.length,
		extraSecrets: [config.token],
	});
	if (summary.text.trim().length === 0) return { item: null, truncated: true };
	return {
		item: buildContextItem({
			kind: "apl_aggregate",
			title: `APL aggregate: ${input.dataset} (${Math.min(
				table.rows.length,
				AXIOM_CONTEXT_MAX_ROWS,
			)} rows)`,
			url: datasetUrl(config, input.dataset),
			excerpt: summary.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: summary.truncated,
	};
}

function monitorValueText(
	value: AxiomMonitorDescriptor["value"] | undefined,
): string | null {
	if (value === undefined) return null;
	if (typeof value === "number") return shortNumber(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	return boundText(redactAxiomText(value), 100) || null;
}

function monitorEvidence(
	config: Config,
	monitor: AxiomMonitorDescriptor,
	fetchedAt: string,
): AxiomEvidenceResult {
	const value = monitorValueText(monitor.value);
	const excerpt = [
		`Monitor: ${boundText(redactAxiomText(monitor.name), 200)}`,
		`Monitor id: ${monitor.id}`,
		`Dataset: ${monitor.dataset}`,
		...(monitor.state === undefined ? [] : [`State: ${monitor.state}`]),
		...(monitor.threshold === undefined
			? []
			: [`Threshold: ${shortNumber(monitor.threshold)}`]),
		...(value === null ? [] : [`Value: ${value}`]),
	].join("\n");
	return {
		item: buildContextItem({
			kind: "monitor",
			title: `Monitor: ${monitor.name}`,
			url: safeUrl(monitor.url) ?? datasetUrl(config, monitor.dataset),
			excerpt: capExcerpt(
				redactAxiomText(excerpt),
				AXIOM_CONTEXT_MAX_EXCERPT_CHARS,
				AXIOM_CONTEXT_MAX_EXCERPT_CHARS * 4,
			).text,
			fetchedAt,
		}),
		truncated: false,
	};
}

function monitorById(
	config: Config,
	monitorId: string,
): AxiomMonitorDescriptor | null {
	return config.monitors.find((monitor) => monitor.id === monitorId) ?? null;
}

function nowIso(config: Config): string {
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"axiom clock is unavailable",
		);
	}
	return new Date(nowMs).toISOString();
}

/* ------------------------------------------------------------------ */
/* Public reads.                                                      */
/* ------------------------------------------------------------------ */

function validateContextInput(
	input: AxiomContextInput,
	config: Config,
): {
	service: string;
	dataset: string;
	monitorId: string | null;
	window: AxiomWindow;
} {
	if (
		input === null ||
		typeof input !== "object" ||
		typeof input.incidentFingerprint !== "string" ||
		input.incidentFingerprint.trim().length === 0 ||
		input.incidentFingerprint.length > MAX_INCIDENT_FINGERPRINT_CHARS
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"incidentFingerprint is required",
		);
	}
	const service = nonEmpty(input.service);
	if (service === null || service.length > MAX_AXIOM_SERVICE_CHARS) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	const dataset =
		input.dataset === undefined
			? config.dataset
			: requireDataset(input.dataset, "dataset");
	if (!config.allowedDatasets.has(dataset)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"axiom dataset is not in the configured allowlist",
		);
	}
	let monitorId: string | null = null;
	if (input.monitorId !== undefined) {
		const candidate = nonEmpty(input.monitorId);
		if (candidate === null || !AXIOM_MONITOR_ID_PATTERN.test(candidate)) {
			throw new PlatformError("VALIDATION_FAILED", "monitorId is invalid");
		}
		monitorId = candidate;
	}
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"axiom clock is unavailable",
		);
	}
	return {
		service,
		dataset,
		monitorId,
		window: resolveAxiomWindow({
			nowMs,
			startsAt: input.startsAt,
			windowMinutes: input.windowMinutes,
		}),
	};
}

/**
 * Fixed two-call context plan (dataset validation, then one APL aggregate).
 * Throws only `PlatformError` with a fixed message: no URL, header, token or
 * provider text is ever part of an error.
 */
export async function fetchAxiomIncidentContext(
	dependencies: AxiomContextDependencies,
	input: AxiomContextInput,
): Promise<AxiomContextBundle> {
	const config = prepare(dependencies);
	const validated = validateContextInput(input, config);
	const client = createClient(config);
	const fetchedAt = nowIso(config);

	const candidates: AxiomContextItem[] = [];
	let truncated = false;

	// 1. Dataset validation before the aggregate (and after the local allowlist
	//    check in `validateContextInput`). A denial here drops only the dataset
	//    item; the aggregate may still be readable.
	const datasetEvidence = await fetchDatasetEvidence(config, client, {
		dataset: validated.dataset,
		fetchedAt,
	});
	truncated = truncated || datasetEvidence.truncated;

	// 2. One bounded APL aggregate. This is the primary evidence item.
	const aplEvidence = await fetchAplEvidence(config, client, {
		apl: buildAxiomApl({
			dataset: validated.dataset,
			service: validated.service,
		}),
		dataset: validated.dataset,
		window: validated.window,
		fetchedAt,
	});
	truncated = truncated || aplEvidence.truncated;
	if (aplEvidence.item !== null) candidates.push(aplEvidence.item);

	if (validated.monitorId !== null) {
		const monitor = monitorById(config, validated.monitorId);
		if (monitor !== null && config.allowedDatasets.has(monitor.dataset)) {
			const evidence = monitorEvidence(config, monitor, fetchedAt);
			truncated = truncated || evidence.truncated;
			if (evidence.item !== null) candidates.push(evidence.item);
		}
	}

	if (datasetEvidence.item !== null) candidates.push(datasetEvidence.item);

	const maxItems = Math.max(
		1,
		Math.min(
			dependencies.maxItems ?? AXIOM_CONTEXT_MAX_ITEMS,
			AXIOM_CONTEXT_MAX_ITEMS,
		),
	);
	const maxExcerptChars = Math.max(
		1,
		Math.min(
			dependencies.maxExcerptChars ?? AXIOM_CONTEXT_MAX_EXCERPT_CHARS,
			AXIOM_CONTEXT_MAX_EXCERPT_CHARS,
		),
	);
	const encoder = new TextEncoder();
	const items: AxiomContextItem[] = [];
	let usedBytes = 0;

	for (const candidate of candidates) {
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = AXIOM_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
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
	const parsedBundle = axiomContextBundleSchema.safeParse(bundle);
	if (!parsedBundle.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"axiom context bundle violated the shared contract",
		);
	}
	return parsedBundle.data;
}

/**
 * Single-query variant used by the read-only `axiom.query_apl` tool. The APL is
 * guarded against the configured dataset, bounded to the incident window and
 * rendered as ≤20 rows / ≤2,000 characters; it never returns raw rows.
 */
export async function fetchAxiomAplEvidence(
	dependencies: AxiomContextDependencies,
	input: {
		apl: string;
		startsAt?: string;
		windowMinutes?: number;
	},
): Promise<AxiomEvidenceResult> {
	const config = prepare(dependencies);
	const apl = assertReadOnlyAxiomApl(input.apl, config.dataset);
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"axiom clock is unavailable",
		);
	}
	const window = resolveAxiomWindow({
		nowMs,
		startsAt: input.startsAt,
		windowMinutes: input.windowMinutes,
	});
	return fetchAplEvidence(config, createClient(config), {
		apl,
		dataset: config.dataset,
		window,
		fetchedAt: new Date(nowMs).toISOString(),
	});
}

/** `axiom.list_datasets`: one bounded list call, names and ids only. */
export async function fetchAxiomDatasetListEvidence(
	dependencies: AxiomContextDependencies,
): Promise<AxiomEvidenceResult> {
	const config = prepare(dependencies);
	const client = createClient(config);
	const fetchedAt = nowIso(config);
	const outcome = await client.request(
		"/v1/datasets",
		{ method: "GET" },
		"axiom dataset list",
	);
	if (outcome.kind !== "ok") return { item: null, truncated: true };
	const parsed = axiomDatasetListResponseSchema.safeParse(outcome.body);
	if (!parsed.success) return { item: null, truncated: true };
	const datasets = [...parsed.data].sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	const shown = datasets.slice(0, AXIOM_DATASET_LIST_MAX_RENDERED);
	const lines = [
		`Datasets: ${datasets.length}`,
		...shown.map((dataset) =>
			dataset.id === undefined
				? `- ${dataset.name}`
				: `- ${dataset.name} (${dataset.id})`,
		),
	];
	const capped = capExcerpt(
		redactAxiomText(lines.join("\n")),
		AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
		AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
	);
	return {
		item: buildContextItem({
			kind: "dataset_list",
			title: `Datasets (${datasets.length})`,
			url: `${config.baseUrl}/datasets`,
			excerpt: capped.text,
			fetchedAt,
		}),
		truncated:
			datasets.length > shown.length ||
			datasets.length > MAX_AXIOM_DATASETS ||
			capped.truncated,
	};
}

/**
 * `axiom.get_monitor`: a registry lookup, never an HTTP call. The monitor read
 * API path is UNVERIFIED, so an unknown id is `NOT_FOUND` and an out-of-scope
 * dataset is `POLICY_DENIED`; no path is invented.
 */
export function fetchAxiomMonitorEvidence(
	dependencies: AxiomContextDependencies,
	input: { monitorId: string },
): AxiomEvidenceResult {
	const config = prepare(dependencies);
	const monitorId = nonEmpty(input.monitorId);
	if (monitorId === null || !AXIOM_MONITOR_ID_PATTERN.test(monitorId)) {
		throw new PlatformError("VALIDATION_FAILED", "monitorId is invalid");
	}
	if (config.monitors.length === 0) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"axiom monitor registry is not configured",
		);
	}
	const monitor = monitorById(config, monitorId);
	if (monitor === null) {
		throw new PlatformError(
			"NOT_FOUND",
			"axiom monitor is not in the configured registry",
		);
	}
	if (!config.allowedDatasets.has(monitor.dataset)) {
		throw new PlatformError(
			"POLICY_DENIED",
			"axiom monitor dataset is not in the configured allowlist",
		);
	}
	return monitorEvidence(config, monitor, nowIso(config));
}
