import {
	isBoundedHttpsUrl,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import {
	boundText,
	capHoneycombExcerpt,
	createHoneycombHttpClient,
	type HoneycombHttpClient,
	honeycombSha256Hex,
} from "./client";
import { redactHoneycombText } from "./redact";
import {
	HONEYCOMB_QUERY_MAX_ROWS,
	HONEYCOMB_QUERY_MAX_WINDOW_SECONDS,
	HONEYCOMB_QUERY_SUMMARY_MAX_CHARS,
	type HoneycombContextBundle,
	type HoneycombContextItem,
	type HoneycombQueryKind,
	type HoneycombQueryRequest,
	type HoneycombQueryResult,
	type HoneycombSlo,
	honeycombContextBundleSchema,
	honeycombContextInputSchema,
	honeycombContextItemSchema,
	honeycombDatasetSchema,
	honeycombQueryKindSchema,
	honeycombQueryRequestSchema,
	honeycombQueryResultSchema,
	honeycombQuerySpecResponseSchema,
	honeycombServiceSchema,
	honeycombSloListSchema,
	honeycombTriggerIdSchema,
	honeycombTriggerSnapshotSchema,
} from "./schemas";
import type {
	HoneycombContextDependencies,
	HoneycombContextInput,
	HoneycombEvidence,
	HoneycombEvidenceFailure,
} from "./types";

/**
 * Honeycomb incident-context reader (`docs/connectors/honeycomb.md` §5).
 *
 * One environment-scoped configuration key, one fixed plan and no
 * model-authored query:
 *
 * 1. trigger metadata from the already-normalized signal (0 calls);
 * 2. `POST /1/queries/{dataset}` — one fixed template by `kind`;
 * 3. `POST /1/query_results/{dataset}` — run it once, no polling loop;
 * 4. `GET /1/query_results/{dataset}/{id}` — one page;
 * 5. `GET /1/slos/{dataset}` — SLO state (empty on Free).
 *
 * At most four provider calls, one page each, 10-second timeout, 256 KiB per
 * response. Caps are enforced, not estimated: ≤8 items, ≤4,000 chars per
 * excerpt, ≤256 KiB of excerpts, ≤20 query rows and a ≤2,000-char query
 * summary. Redaction runs before truncation; the hash covers exactly the
 * excerpt the model sees.
 *
 * Raw spans/events are never fetched, `links` from provider payloads are never
 * followed, and query filters come from validated identifiers. 401/429 and
 * transport failures are typed errors; 403/404/5xx/parse failures on the
 * query or SLO drop that evidence and set `truncated` (partial bundles are
 * valid).
 */

export const HONEYCOMB_CONTEXT_MAX_ITEMS = 8;
export const HONEYCOMB_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const HONEYCOMB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const HONEYCOMB_CONTEXT_MAX_FETCH_CALLS = 4;
export const HONEYCOMB_CONTEXT_DEFAULT_WINDOW_MINUTES = 60;
export const HONEYCOMB_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const HONEYCOMB_CONTEXT_MAX_ROWS = HONEYCOMB_QUERY_MAX_ROWS;
export const HONEYCOMB_CONTEXT_MAX_SLO_ROWS = 20;
export const HONEYCOMB_CONTEXT_MAX_TRIGGER_CHARS = 2000;
export const HONEYCOMB_CONTEXT_MAX_SLO_SUMMARY_CHARS = 2000;

/** Group fields safe for prompt context; host/url/user fields are excluded. */
const HONEYCOMB_CONTEXT_GROUP_FIELDS = [
	"service.name",
	"http.route",
	"http.method",
	"http.status_code",
	"status_code",
	"error",
	"environment",
	"deployment.environment",
	"k8s.namespace.name",
	"k8s.pod.name",
] as const;

type Draft = {
	kind: string;
	title: string;
	url: string;
	excerpt: string;
};

type Config = {
	client: HoneycombHttpClient;
	dataset: string;
	nowMs: number;
	fetchedAt: string;
	maxItems: number;
	maxExcerptChars: number;
	extraSecrets: readonly string[];
};

const queryEvidenceInputSchema = z.strictObject({
	service: honeycombServiceSchema,
	kind: honeycombQueryKindSchema.optional(),
	windowMinutes: z.number().int().min(1).max(60).optional(),
});
export type HoneycombQueryEvidenceInput = z.output<
	typeof queryEvidenceInputSchema
>;

const sloEvidenceInputSchema = z.strictObject({});
export type HoneycombSloEvidenceInput = z.output<typeof sloEvidenceInputSchema>;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

function oneLine(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function createConfig(dependencies: HoneycombContextDependencies): Config {
	const dataset = honeycombDatasetSchema.safeParse(dependencies.dataset);
	if (!dataset.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb dataset must match the documented slug",
		);
	}
	const client = createHoneycombHttpClient({
		apiKey: dependencies.apiKey,
		apiBaseUrl: dependencies.apiBaseUrl,
		fetchImpl: dependencies.fetchImpl,
		timeoutMs: dependencies.timeoutMs,
	});
	const nowMs = (dependencies.now ?? (() => Date.now()))();
	const extraSecrets = [dependencies.apiKey, dependencies.webhookToken].filter(
		(value): value is string => typeof value === "string" && value.length >= 8,
	);
	return {
		client,
		dataset: dataset.data,
		nowMs,
		fetchedAt: new Date(nowMs).toISOString(),
		maxItems: clamp(
			dependencies.maxItems ?? HONEYCOMB_CONTEXT_MAX_ITEMS,
			1,
			HONEYCOMB_CONTEXT_MAX_ITEMS,
		),
		maxExcerptChars: clamp(
			dependencies.maxExcerptChars ?? HONEYCOMB_CONTEXT_MAX_EXCERPT_CHARS,
			1,
			HONEYCOMB_CONTEXT_MAX_EXCERPT_CHARS,
		),
		extraSecrets,
	};
}

function windowMinutesOf(value: number | undefined): number {
	if (value === undefined) return HONEYCOMB_CONTEXT_DEFAULT_WINDOW_MINUTES;
	return clamp(value, 1, HONEYCOMB_CONTEXT_MAX_WINDOW_MINUTES);
}

/**
 * Fixed query specification. The service comes from a validated identifier;
 * calculations, breakdowns and filters are selected only by `kind`.
 */
export function buildHoneycombQuery(input: {
	kind: HoneycombQueryKind;
	service: string;
	windowMinutes?: number;
}): HoneycombQueryRequest {
	const kind = honeycombQueryKindSchema.safeParse(input.kind);
	const service = honeycombServiceSchema.safeParse(input.service);
	if (!kind.success || !service.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb query template input is invalid",
		);
	}
	let calculations: HoneycombQueryRequest["calculations"];
	let breakdowns: HoneycombQueryRequest["breakdowns"];
	const filters: HoneycombQueryRequest["filters"] = [
		{ column: "service.name", op: "=", value: service.data },
	];
	switch (kind.data) {
		case "latency":
			calculations = [{ op: "P95", column: "duration_ms" }];
			breakdowns = ["http.route"];
			break;
		case "error_rate":
			calculations = [{ op: "COUNT" }];
			breakdowns = ["http.route"];
			filters.push({ column: "error", op: "=", value: true });
			break;
		case "saturation":
			calculations = [{ op: "AVG", column: "system.cpu.utilization" }];
			breakdowns = ["service.name"];
			break;
	}
	const windowMinutes = windowMinutesOf(input.windowMinutes);
	const request = {
		calculations,
		breakdowns,
		filters,
		time_range: Math.min(
			HONEYCOMB_QUERY_MAX_WINDOW_SECONDS,
			windowMinutes * 60,
		),
		limit: HONEYCOMB_CONTEXT_MAX_ROWS,
	};
	const parsed = honeycombQueryRequestSchema.safeParse(request);
	if (!parsed.success) {
		throw new PlatformError(
			"INTERNAL",
			"honeycomb query template violated its own bounds",
		);
	}
	return parsed.data;
}

function formatMetric(value: number): string {
	if (!Number.isFinite(value)) return "invalid";
	const rounded = Number.isInteger(value) ? value : Number(value.toFixed(3));
	return String(rounded);
}

function renderGroup(name: Record<string, unknown> | undefined): string {
	if (name === undefined) return "";
	const parts: string[] = [];
	for (const field of HONEYCOMB_CONTEXT_GROUP_FIELDS) {
		const value = name[field];
		if (value === null || value === undefined) continue;
		const text = oneLine(String(value));
		if (text.length === 0) continue;
		parts.push(`${field}=${boundText(text, 120)}`);
	}
	return parts.join(" ");
}

function renderPoint(point: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(point)) {
		if (key === "time") continue;
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		if (parts.length >= 4) break;
		parts.push(`${boundText(key, 40)}=${formatMetric(value)}`);
	}
	return parts.join(" ");
}

function buildQueryDraft(
	config: Config,
	kind: HoneycombQueryKind,
	windowMinutes: number,
	result: HoneycombQueryResult,
	resultId: string,
): { draft: Draft; truncated: boolean } {
	const series = result.data?.series ?? [];
	const rows = series.slice(0, HONEYCOMB_CONTEXT_MAX_ROWS);
	const lines = [
		`Query: ${kind}`,
		`Dataset: ${config.dataset}`,
		`Window: ${windowMinutes}m ending ${config.fetchedAt}`,
		`Rows: ${rows.length}${series.length > rows.length ? ` of ${series.length} (capped)` : ""}`,
	];
	if (rows.length === 0) {
		lines.push("No rows returned (absence of evidence, not proof of health)");
	}
	let truncated =
		series.length > HONEYCOMB_CONTEXT_MAX_ROWS || result.complete === false;
	for (const entry of rows) {
		if ((entry.data?.length ?? 0) > 1) truncated = true;
		const point = entry.data?.[entry.data.length - 1];
		const group = renderGroup(entry.name);
		const metrics = point === undefined ? "" : renderPoint(point);
		const row = [group, metrics].filter((part) => part.length > 0).join(" ");
		lines.push(`- ${row.length === 0 ? "group without numeric values" : row}`);
	}
	const excerpt = boundText(
		redactHoneycombText(lines.join("\n"), config.extraSecrets),
		HONEYCOMB_QUERY_SUMMARY_MAX_CHARS,
	);
	if (excerpt.length < lines.join("\n").length) truncated = true;
	return {
		draft: {
			kind: "query_result",
			title: `Honeycomb ${kind} query (${config.dataset})`,
			url: `${config.client.baseUrl}/1/query_results/${config.dataset}/${resultId}`,
			excerpt,
		},
		truncated,
	};
}

function formatPercent(value: number): string | null {
	if (!Number.isFinite(value)) return null;
	const percent = value <= 1.5 ? value * 100 : value;
	return `${Number(percent.toFixed(2))}%`;
}

function buildSloDraft(
	config: Config,
	slos: readonly HoneycombSlo[],
): {
	draft: Draft | null;
	truncated: boolean;
	failure: HoneycombEvidenceFailure;
} {
	if (slos.length === 0) {
		return { draft: null, truncated: true, failure: "none" };
	}
	const selected = slos.slice(0, HONEYCOMB_CONTEXT_MAX_SLO_ROWS);
	const lines = [`SLOs: ${selected.length}`];
	for (const slo of selected) {
		const name = boundText(oneLine(slo.name ?? slo.id), 120);
		const target =
			slo.target_per_million === undefined
				? slo.target === undefined
					? null
					: formatPercent(slo.target)
				: formatPercent(slo.target_per_million / 10_000);
		const current =
			slo.current === undefined ? null : formatPercent(slo.current);
		const parts = [`${name}:`];
		if (target !== null) parts.push(`target ${target}`);
		if (current !== null) parts.push(`current ${current}`);
		if (slo.time_window_days !== undefined) {
			parts.push(`window ${slo.time_window_days}d`);
		}
		if (slo.status !== undefined) parts.push(`status ${oneLine(slo.status)}`);
		lines.push(`- ${parts.join(" ")}`);
	}
	const excerpt = boundText(
		redactHoneycombText(lines.join("\n"), config.extraSecrets),
		HONEYCOMB_CONTEXT_MAX_SLO_SUMMARY_CHARS,
	);
	return {
		draft: {
			kind: "slo",
			title: `Honeycomb SLOs (${config.dataset})`,
			url: `${config.client.baseUrl}/1/slos/${config.dataset}`,
			excerpt,
		},
		truncated:
			slos.length > HONEYCOMB_CONTEXT_MAX_SLO_ROWS ||
			excerpt.length < lines.join("\n").length,
		failure: "none",
	};
}

function buildTriggerDraft(
	config: Config,
	trigger: {
		id: string;
		name: string;
		state: string;
		threshold?: { op: string; value: number };
		observed?: number;
		url?: string;
	},
): Draft {
	const lines = [
		`Trigger: ${oneLine(trigger.name)} (${trigger.id})`,
		`State: ${trigger.state}`,
		`Dataset: ${config.dataset}`,
	];
	if (trigger.threshold !== undefined) {
		lines.push(
			`Threshold: ${trigger.threshold.op} ${formatMetric(trigger.threshold.value)}`,
		);
	}
	if (trigger.observed !== undefined) {
		lines.push(`Observed: ${formatMetric(trigger.observed)}`);
	}
	const url =
		trigger.url !== undefined && isBoundedHttpsUrl(trigger.url)
			? trigger.url
			: `${config.client.baseUrl}/1/triggers/${config.dataset}/${trigger.id}`;
	return {
		kind: "trigger",
		title: `Honeycomb trigger ${oneLine(trigger.name)}`,
		url,
		excerpt: boundText(
			redactHoneycombText(lines.join("\n"), config.extraSecrets),
			HONEYCOMB_CONTEXT_MAX_TRIGGER_CHARS,
		),
	};
}

async function toContextItem(
	config: Config,
	draft: Draft,
): Promise<{ item: HoneycombContextItem | null; truncated: boolean }> {
	const redacted = redactHoneycombText(draft.excerpt, config.extraSecrets);
	const capped = capHoneycombExcerpt(
		redacted,
		config.maxExcerptChars,
		config.maxExcerptChars * 4,
	);
	if (capped.text.trim().length === 0) {
		return { item: null, truncated: true };
	}
	if (!isBoundedHttpsUrl(draft.url)) {
		return { item: null, truncated: true };
	}
	const candidate = {
		source: "honeycomb" as const,
		kind: boundText(draft.kind, 64),
		title: boundText(
			redactHoneycombText(draft.title, config.extraSecrets),
			200,
		),
		url: draft.url,
		excerpt: capped.text,
		fetchedAt: config.fetchedAt,
		trustLevel: "untrusted" as const,
		sha256: await honeycombSha256Hex(capped.text),
	};
	const parsed = honeycombContextItemSchema.safeParse(candidate);
	return {
		item: parsed.success ? parsed.data : null,
		truncated: capped.truncated || !parsed.success,
	};
}

function failureOf(kind: "denied" | "missing" | "failed"): {
	failure: HoneycombEvidenceFailure;
	truncated: true;
	item: null;
} {
	return { failure: kind, truncated: true, item: null };
}

/**
 * `honeycomb.run_query` evidence: create → run → fetch, exactly three calls.
 * No retry, no polling and no links followed.
 */
export async function fetchHoneycombQueryEvidence(
	dependencies: HoneycombContextDependencies,
	input: HoneycombQueryEvidenceInput | unknown,
): Promise<HoneycombEvidence> {
	const parsed = queryEvidenceInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb query evidence input is invalid",
		);
	}
	const config = createConfig(dependencies);
	const kind = parsed.data.kind ?? "latency";
	const windowMinutes = windowMinutesOf(parsed.data.windowMinutes);
	const request = buildHoneycombQuery({
		kind,
		service: parsed.data.service,
		windowMinutes,
	});

	const create = await config.client.call({
		method: "POST",
		path: `/1/queries/${config.dataset}`,
		body: request,
		step: "honeycomb query creation",
	});
	if (create.kind !== "ok") return failureOf(create.kind);
	const query = honeycombQuerySpecResponseSchema.safeParse(create.body);
	if (!query.success) {
		return { failure: "malformed", truncated: true, item: null };
	}

	const run = await config.client.call({
		method: "POST",
		path: `/1/query_results/${config.dataset}`,
		body: { query_id: query.data.id },
		step: "honeycomb query execution",
	});
	if (run.kind !== "ok") return failureOf(run.kind);
	const started = honeycombQueryResultSchema.safeParse(run.body);
	if (!started.success || started.data.id === undefined) {
		return { failure: "malformed", truncated: true, item: null };
	}

	const result = await config.client.call({
		method: "GET",
		path: `/1/query_results/${config.dataset}/${encodeURIComponent(started.data.id)}`,
		step: "honeycomb query result",
	});
	if (result.kind !== "ok") return failureOf(result.kind);
	const parsedResult = honeycombQueryResultSchema.safeParse(result.body);
	if (!parsedResult.success || parsedResult.data.id === undefined) {
		return { failure: "malformed", truncated: true, item: null };
	}

	const built = buildQueryDraft(
		config,
		kind,
		windowMinutes,
		parsedResult.data,
		parsedResult.data.id,
	);
	const materialized = await toContextItem(config, built.draft);
	return {
		item: materialized.item,
		truncated: built.truncated || materialized.truncated,
		failure: "none",
	};
}

/** `honeycomb.list_slos`: one call. Empty on Free is `truncated`, not error. */
export async function fetchHoneycombSloEvidence(
	dependencies: HoneycombContextDependencies,
	input: HoneycombSloEvidenceInput | unknown,
): Promise<HoneycombEvidence> {
	const parsed = sloEvidenceInputSchema.safeParse(input ?? {});
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb slo evidence input is invalid",
		);
	}
	const config = createConfig(dependencies);
	const result = await config.client.call({
		method: "GET",
		path: `/1/slos/${config.dataset}`,
		step: "honeycomb slo list",
	});
	if (result.kind !== "ok") return failureOf(result.kind);
	const slos = honeycombSloListSchema.safeParse(result.body);
	if (!slos.success) {
		return { failure: "malformed", truncated: true, item: null };
	}
	const built = buildSloDraft(config, slos.data);
	const materialized =
		built.draft === null
			? { item: null, truncated: true }
			: await toContextItem(config, built.draft);
	return {
		item: materialized.item,
		truncated: built.truncated || materialized.truncated,
		failure: built.failure,
	};
}

/**
 * `honeycomb.get_trigger`: the trigger snapshot captured at intake, never a
 * provider call. Fetching the full trigger definition is forbidden because it
 * may embed recipient lists and webhook URLs.
 */
export async function fetchHoneycombTriggerEvidence(
	dependencies: HoneycombContextDependencies,
	triggerId: string,
): Promise<HoneycombEvidence> {
	const parsed = honeycombTriggerIdSchema.safeParse(triggerId);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb trigger id is invalid",
		);
	}
	const config = createConfig(dependencies);
	if (dependencies.trigger === null || dependencies.trigger === undefined) {
		return { item: null, truncated: true, failure: "missing" };
	}
	const snapshot = honeycombTriggerSnapshotSchema.safeParse(
		dependencies.trigger,
	);
	if (!snapshot.success) {
		return { item: null, truncated: true, failure: "malformed" };
	}
	if (snapshot.data.id !== parsed.data) {
		return { item: null, truncated: true, failure: "missing" };
	}
	const materialized = await toContextItem(
		config,
		buildTriggerDraft(config, snapshot.data),
	);
	return {
		item: materialized.item,
		truncated: materialized.truncated,
		failure: "none",
	};
}

/**
 * The bounded, cited bundle for one incident. Partial bundles are valid:
 * 403/404/5xx/parse failures and an empty Free-plan SLO list set `truncated`
 * rather than failing the task. 401 and 429 remain typed errors.
 */
export async function fetchHoneycombIncidentContext(
	dependencies: HoneycombContextDependencies,
	input: HoneycombContextInput,
): Promise<HoneycombContextBundle> {
	const parsedInput = honeycombContextInputSchema.safeParse(input);
	if (!parsedInput.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb context input is invalid",
		);
	}
	const config = createConfig(dependencies);
	let truncated = false;
	const candidates: HoneycombContextItem[] = [];

	if (dependencies.trigger !== null && dependencies.trigger !== undefined) {
		const snapshot = honeycombTriggerSnapshotSchema.safeParse(
			dependencies.trigger,
		);
		if (snapshot.success) {
			const materialized = await toContextItem(
				config,
				buildTriggerDraft(config, snapshot.data),
			);
			if (materialized.item !== null) candidates.push(materialized.item);
			truncated = truncated || materialized.truncated;
		} else {
			truncated = true;
		}
	} else {
		truncated = true;
	}

	const query = await fetchHoneycombQueryEvidence(dependencies, {
		service: parsedInput.data.service,
		kind: parsedInput.data.kind,
		windowMinutes: parsedInput.data.windowMinutes,
	});
	if (query.item !== null) candidates.push(query.item);
	truncated = truncated || query.truncated;

	const slo = await fetchHoneycombSloEvidence(dependencies, {});
	if (slo.item !== null) candidates.push(slo.item);
	truncated = truncated || slo.truncated;

	const items: HoneycombContextItem[] = [];
	let usedBytes = 0;
	const encoder = new TextEncoder();
	for (const item of candidates) {
		if (items.length >= config.maxItems) {
			truncated = true;
			break;
		}
		const bytes = encoder.encode(item.excerpt).byteLength;
		if (usedBytes + bytes > HONEYCOMB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES) {
			truncated = true;
			break;
		}
		items.push(item);
		usedBytes += bytes;
	}

	const bundle = {
		incidentFingerprint: parsedInput.data.incidentFingerprint,
		items,
		truncated,
	};
	const validated = honeycombContextBundleSchema.safeParse(bundle);
	if (!validated.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"honeycomb context bundle violated the shared contract",
		);
	}
	return validated.data;
}
