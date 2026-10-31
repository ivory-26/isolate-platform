import { createHash } from "node:crypto";
import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	contextItemSchema,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { redactNewRelicText } from "./redact";
import {
	NEWRELIC_ACCOUNT_ID_PATTERN,
	NEWRELIC_ENTITY_GUID_PATTERN,
	NEWRELIC_MAX_ALERT_POLICIES,
	NEWRELIC_MAX_NRQL_ROWS,
	NEWRELIC_MAX_SEARCH_ENTITIES,
	type NerdGraphResponse,
	type NewRelicAlertPolicy,
	type NewRelicEntity,
	type NewRelicNrqlRow,
	nerdGraphResponseSchema,
	newRelicAlertPoliciesDataSchema,
	newRelicEntityDataSchema,
	newRelicEntitySearchDataSchema,
	newRelicNrqlDataSchema,
} from "./schemas";

/**
 * New Relic read-only context reader (`docs/connectors/newrelic.md` §5).
 *
 * One user API key, one injected NerdGraph endpoint (US or EU, matching the
 * account) and a fixed, trusted-code query plan:
 *
 * 1. entity lookup by GUID, or one entity search by service name;
 * 2. one aggregate NRQL query over the incident window
 *    (`SELECT count(*) … FROM Transaction … FACET error.class`).
 *
 * At most two GraphQL operations, 10 s each, 256 KiB per response, ≤20 NRQL
 * rows, 2,000 chars per aggregate summary, 4,000 chars per item and 256 KiB
 * per bundle. The model cannot author NRQL here, select an account, widen the
 * window or fetch `Transaction`/`Log` rows; only aggregate cells are read.
 *
 * Redaction runs **before** truncation; the SHA-256 covers exactly the excerpt
 * the model sees. A partial bundle is valid: 403/404/parse failure on the
 * optional entity drops it and sets `truncated`; 401 and 429 fail closed.
 *
 * The source literal is `"newrelic"` and the shared enum does not include it
 * yet, so this module exposes local `NewRelicContextItem`/`Bundle` types and
 * validates caps with the shared schemas by substituting `"generic"`.
 */

export const NEWRELIC_US_ENDPOINT = "https://api.newrelic.com/graphql";
export const NEWRELIC_EU_ENDPOINT = "https://api.eu.newrelic.com/graphql";
export const NEWRELIC_CONTEXT_MAX_ITEMS = 10;
export const NEWRELIC_CONTEXT_MAX_FETCH_CALLS = 4;
export const NEWRELIC_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
export const NEWRELIC_CONTEXT_MAX_SUMMARY_CHARS = 2000;
export const NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const NEWRELIC_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const NEWRELIC_CONTEXT_MIN_WINDOW_MINUTES = 15;
export const NEWRELIC_CONTEXT_MAX_WINDOW_MINUTES = 60;
export const NEWRELIC_CONTEXT_DEFAULT_WINDOW_MINUTES = 30;
export const NEWRELIC_CONTEXT_PRE_START_MINUTES = 15;
/** Free-plan retention floor; a requested window older than this is partial. */
export const NEWRELIC_FREE_RETENTION_DAYS = 8;

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const REQUEST_USER_AGENT = "isolate-platform";
const ONE_NEW_RELIC = "https://one.newrelic.com";

/** Local literal until `INCIDENT_SOURCES` includes the value. */
export type NewRelicContextItem = Omit<ContextItem, "source"> & {
	source: "newrelic";
};
export type NewRelicContextBundle = Omit<ContextBundle, "items"> & {
	items: NewRelicContextItem[];
};

/** Narrow fetch shape; injectable without Bun-specific extensions. */
export type NewRelicFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type NewRelicContextDependencies = {
	/** User API key (`NRAK-…`); only ever placed in the `API-Key` header. */
	apiKey: string;
	/** Account id from configuration; never from a webhook payload. */
	accountId: string | number;
	/** `https://api.newrelic.com/graphql` (default) or the EU host. */
	endpoint?: string;
	fetchImpl?: NewRelicFetchLike;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the per-source budget (10). */
	maxItems?: number;
	/** Clamped to 4,000 chars. */
	maxExcerptChars?: number;
};

export type NewRelicContextInput = {
	incidentFingerprint: string;
	service: string;
	entityGuid?: string | null;
	startsAt?: string;
	windowMinutes?: number;
};

/** One evidence item plus the outcome, so a tool can map 403/404 explicitly. */
export type NewRelicEvidenceResult = {
	item: NewRelicContextItem | null;
	truncated: boolean;
	outcome: "ok" | "missing" | "denied" | "failed";
};

type Config = {
	apiKey: string;
	accountId: string;
	endpoint: string;
	fetchImpl: NewRelicFetchLike;
	now: () => number;
	timeoutMs: number;
};

type CallOutcome =
	| { kind: "ok"; data: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "failed" };

type HttpClient = {
	call(
		query: string,
		variables: Record<string, unknown>,
		step: string,
	): Promise<CallOutcome>;
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

/** Validates and canonicalizes the NerdGraph endpoint; throws a fixed error. */
export function normalizeNewRelicEndpoint(value?: string): string {
	const candidate = value ?? NEWRELIC_US_ENDPOINT;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic endpoint is invalid",
		);
	}
	const allowedOrigin =
		url.origin === "https://api.newrelic.com" ||
		url.origin === "https://api.eu.newrelic.com";
	if (
		!allowedOrigin ||
		url.pathname !== "/graphql" ||
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic endpoint is invalid",
		);
	}
	return `${url.origin}/graphql`;
}

/** Account id is configuration: a positive integer, never a body field. */
export function normalizeNewRelicAccountId(value: string | number): string {
	const text = typeof value === "number" ? String(value) : value.trim();
	if (!NEWRELIC_ACCOUNT_ID_PATTERN.test(text)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic accountId is invalid",
		);
	}
	return text;
}

function prepare(dependencies: NewRelicContextDependencies): Config {
	const apiKey = nonEmpty(dependencies.apiKey);
	if (apiKey === null) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"newrelic user API key is not configured",
		);
	}
	const endpoint = normalizeNewRelicEndpoint(dependencies.endpoint);
	const accountId = normalizeNewRelicAccountId(dependencies.accountId);
	const timeoutMs = Math.min(
		MAX_TIMEOUT_MS,
		Math.max(MIN_TIMEOUT_MS, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	);
	return {
		apiKey,
		accountId,
		endpoint,
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
		async call(query, variables, step) {
			if (client.calls >= NEWRELIC_CONTEXT_MAX_FETCH_CALLS) {
				return { kind: "failed" };
			}
			client.calls += 1;
			let response: Response;
			try {
				response = await config.fetchImpl(config.endpoint, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/json",
						"User-Agent": REQUEST_USER_AGENT,
						"API-Key": config.apiKey,
					},
					body: JSON.stringify({ query, variables }),
					// Refuse redirects: a provider hop must not forward the key.
					redirect: "error",
					signal: AbortSignal.timeout(config.timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed to reach newrelic`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by newrelic (status 401)`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by newrelic`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > NEWRELIC_CONTEXT_MAX_RESPONSE_BYTES
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
				encoder.encode(text).byteLength > NEWRELIC_CONTEXT_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return { kind: "failed" };
			}
			const envelope = nerdGraphResponseSchema.safeParse(body);
			if (!envelope.success) return { kind: "failed" };
			const parsed: NerdGraphResponse = envelope.data;
			if ((parsed.errors?.length ?? 0) > 0) return { kind: "failed" };
			if (parsed.data === undefined || parsed.data === null) {
				return { kind: "failed" };
			}
			return { kind: "ok", data: parsed.data };
		},
	};
	return client;
}

const ENTITY_FIELDS =
	"guid accountId name type domain alertSeverity reporting tags { key values }";

export function newRelicEntityLookupGraphQl(): string {
	return `query Entity($guid: EntityGuid!) { actor { entity(guid: $guid) { ${ENTITY_FIELDS} } } }`;
}

export function newRelicEntitySearchGraphQl(): string {
	return `query EntitySearch($q: String!) { actor { entitySearch(query: $q) { count results { entities { ${ENTITY_FIELDS} } } } } }`;
}

export function newRelicNrqlGraphQl(accountId: string): string {
	const safeAccountId = normalizeNewRelicAccountId(accountId);
	return `query Nrql($query: Nrql!) { actor { account(id: ${safeAccountId}) { nrql(query: $query) { results } } } }`;
}

export function newRelicAlertPoliciesGraphQl(accountId: string): string {
	const safeAccountId = normalizeNewRelicAccountId(accountId);
	return `query AlertPolicies { actor { account(id: ${safeAccountId}) { alerts { policies { id name } } } } }`;
}

/** NRQL/entity-search strings allow a fixed character set; payload text is inert. */
export function escapeNewRelicQueryValue(value: string): string {
	let out = "";
	for (const character of value.slice(0, 100)) {
		out += /[A-Za-z0-9 ._:-]/.test(character) ? character : " ";
	}
	return out.replace(/\s+/g, " ").trim();
}

/** The only entity-search template: a bounded service-name match. */
export function newRelicEntitySearchTerm(service: string): string {
	const safe = escapeNewRelicQueryValue(service);
	return safe.length === 0 ? "" : `name LIKE '%${safe}%'`;
}

/** The only NRQL template in the reader: an aggregate, never raw rows. */
export function newRelicServiceNrql(service: string): string {
	const safe = escapeNewRelicQueryValue(service);
	return `SELECT count(*) AS 'events' FROM Transaction WHERE appName = '${safe}' AND error IS TRUE FACET error.class`;
}

export type NewRelicWindow = {
	fromMs: number;
	toMs: number;
	/** The requested start predates the Free-plan retention floor. */
	retentionGap: boolean;
};

export function clampNewRelicWindowMinutes(value: number | undefined): number {
	const minutes = value ?? NEWRELIC_CONTEXT_DEFAULT_WINDOW_MINUTES;
	if (!Number.isFinite(minutes)) {
		return NEWRELIC_CONTEXT_DEFAULT_WINDOW_MINUTES;
	}
	return Math.min(
		NEWRELIC_CONTEXT_MAX_WINDOW_MINUTES,
		Math.max(NEWRELIC_CONTEXT_MIN_WINDOW_MINUTES, Math.round(minutes)),
	);
}

/**
 * Incident window: `startsAt − 15 min` through `now`, never wider than 60
 * minutes. A requested start older than the 8-day Free retention is clamped,
 * and the bundle is marked partial rather than implying complete evidence.
 */
export function resolveNewRelicWindow(input: {
	nowMs: number;
	startsAt?: string;
	windowMinutes?: number;
}): NewRelicWindow {
	const spanMs = clampNewRelicWindowMinutes(input.windowMinutes) * 60_000;
	const toMs = input.nowMs;
	let fromMs = toMs - spanMs;
	let retentionGap = false;
	const startsAt = nonEmpty(input.startsAt);
	if (startsAt !== null) {
		const parsed = z.iso.datetime({ offset: true }).safeParse(startsAt);
		if (parsed.success) {
			const startMs = Math.min(Date.parse(parsed.data), toMs);
			retentionGap =
				startMs < toMs - NEWRELIC_FREE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
			fromMs = Math.max(
				startMs - NEWRELIC_CONTEXT_PRE_START_MINUTES * 60_000,
				toMs - NEWRELIC_CONTEXT_MAX_WINDOW_MINUTES * 60_000,
			);
		}
	}
	if (!(fromMs < toMs)) fromMs = toMs - 15 * 60_000;
	return { fromMs, toMs, retentionGap };
}

function entityAccountId(entity: NewRelicEntity): string | null {
	if (entity.accountId === undefined) return null;
	return typeof entity.accountId === "number"
		? String(entity.accountId)
		: entity.accountId;
}

function entityMatchesAccount(config: Config, entity: NewRelicEntity): boolean {
	return entityAccountId(entity) === config.accountId;
}

function buildItem(input: {
	kind: string;
	title: string;
	url: string;
	excerpt: string;
	fetchedAt: string;
}): NewRelicContextItem {
	return {
		source: "newrelic",
		kind: input.kind,
		title: boundText(redactNewRelicText(input.title), 200),
		url: input.url,
		excerpt: input.excerpt,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(input.excerpt),
	};
}

const ENTITY_TAG_ALLOWLIST: ReadonlySet<string> = new Set([
	"service",
	"service.name",
	"service_name",
	"app",
	"appname",
	"app.name",
	"environment",
	"env",
	"team",
	"language",
	"runtime",
]);

function entityTagLines(config: Config, entity: NewRelicEntity): string[] {
	const lines: string[] = [];
	for (const tag of entity.tags ?? []) {
		const key = tag.key.trim().toLowerCase();
		if (!ENTITY_TAG_ALLOWLIST.has(key)) continue;
		const value = nonEmpty(tag.values[0]);
		if (value === null) continue;
		const redacted = redactNewRelicText(value, {
			allowAccountIds: [config.accountId],
		});
		lines.push(`${boundText(key, 64)}=${boundText(redacted, 160)}`);
		if (lines.length >= 12) break;
	}
	return lines;
}

function entityExcerpt(config: Config, entity: NewRelicEntity): string {
	const tagLines = entityTagLines(config, entity);
	const lines = [
		`Entity: ${boundText(entity.name, 200)}`,
		`GUID: ${boundText(entity.guid, 200)}`,
		`Account: ${config.accountId}`,
		...(entity.type === undefined || entity.type === null
			? []
			: [`Type: ${boundText(entity.type, 64)}`]),
		...(entity.domain === undefined || entity.domain === null
			? []
			: [`Domain: ${boundText(entity.domain, 64)}`]),
		...(entity.alertSeverity === undefined || entity.alertSeverity === null
			? []
			: [`Alert severity: ${boundText(entity.alertSeverity, 32)}`]),
		...(entity.reporting === undefined || entity.reporting === null
			? []
			: [`Reporting: ${entity.reporting ? "yes" : "no"}`]),
		...(tagLines.length === 0 ? [] : [`Tags: ${tagLines.join(", ")}`]),
	];
	return lines.join("\n");
}

function entityUrl(guid: string): string {
	return `${ONE_NEW_RELIC}/redirect/entity/${encodeURIComponent(guid)}`;
}

function entityItem(
	config: Config,
	entity: NewRelicEntity,
	fetchedAt: string,
): NewRelicContextItem {
	const capped = capExcerpt(
		redactNewRelicText(entityExcerpt(config, entity), {
			allowAccountIds: [config.accountId],
		}),
		NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS,
		NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return buildItem({
		kind: "entity",
		title: `Entity: ${entity.name}`,
		url: entityUrl(entity.guid),
		excerpt: capped.text,
		fetchedAt,
	});
}

async function fetchEntityByGuid(
	config: Config,
	client: HttpClient,
	input: { guid: string; fetchedAt: string },
): Promise<NewRelicEvidenceResult> {
	const outcome = await client.call(
		newRelicEntityLookupGraphQl(),
		{ guid: input.guid },
		"newrelic entity lookup",
	);
	if (outcome.kind === "denied") {
		return { item: null, truncated: true, outcome: "denied" };
	}
	if (outcome.kind === "missing") {
		return { item: null, truncated: true, outcome: "missing" };
	}
	if (outcome.kind !== "ok") {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const parsed = newRelicEntityDataSchema.safeParse(outcome.data);
	if (!parsed.success) {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const entity = parsed.data.actor.entity;
	// A GUID from another tenant (or an unverifiable account) is not evidence.
	if (
		entity === null ||
		entity.guid !== input.guid ||
		!entityMatchesAccount(config, entity)
	) {
		return { item: null, truncated: true, outcome: "missing" };
	}
	return {
		item: entityItem(config, entity, input.fetchedAt),
		truncated: false,
		outcome: "ok",
	};
}

async function fetchEntityBySearch(
	config: Config,
	client: HttpClient,
	input: { service: string; fetchedAt: string },
): Promise<NewRelicEvidenceResult> {
	const term = newRelicEntitySearchTerm(input.service);
	if (term.length === 0) {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const outcome = await client.call(
		newRelicEntitySearchGraphQl(),
		{ q: term },
		"newrelic entity search",
	);
	if (outcome.kind === "denied") {
		return { item: null, truncated: true, outcome: "denied" };
	}
	if (outcome.kind === "missing") {
		return { item: null, truncated: true, outcome: "missing" };
	}
	if (outcome.kind !== "ok") {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const parsed = newRelicEntitySearchDataSchema.safeParse(outcome.data);
	if (!parsed.success) {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const search = parsed.data.actor.entitySearch;
	const entities = (search?.results.entities ?? [])
		.filter((entity) => entityMatchesAccount(config, entity))
		.slice(0, NEWRELIC_MAX_SEARCH_ENTITIES);
	if (entities.length === 0) {
		return { item: null, truncated: true, outcome: "missing" };
	}
	entities.sort((left, right) => {
		const byGuid = left.guid < right.guid ? -1 : left.guid > right.guid ? 1 : 0;
		if (byGuid !== 0) return byGuid;
		return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	});
	const chosen = entities[0];
	if (chosen === undefined) {
		return { item: null, truncated: true, outcome: "missing" };
	}
	return {
		item: entityItem(config, chosen, input.fetchedAt),
		truncated: entities.length > 1,
		outcome: "ok",
	};
}

function cellText(value: NewRelicRowCell): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return boundText(redactNewRelicText(value), 160);
}

type NewRelicRowCell = string | number | boolean | null;

function renderRows(
	config: Config,
	rows: readonly NewRelicNrqlRow[],
	window: NewRelicWindow,
	retentionGap: boolean,
	queryLabel: string,
): { text: string; truncated: boolean } {
	const lines = [
		`NRQL window: ${new Date(window.fromMs).toISOString()} → ${new Date(
			window.toMs,
		).toISOString()}`,
		`Query: ${queryLabel}`,
		`Rows: ${rows.length}`,
	];
	rows.slice(0, NEWRELIC_MAX_NRQL_ROWS).forEach((row, index) => {
		const cells = Object.keys(row)
			.sort()
			.map((key) => {
				const value = row[key];
				const cell = value === undefined ? "null" : cellText(value);
				return `${boundText(key, 60)}=${cell}`;
			});
		lines.push(`Row ${index + 1}: ${cells.join(", ")}`);
	});
	if (retentionGap) {
		lines.push(
			"Retention gap: the requested start predates the Free-plan 8-day window",
		);
	}
	const redacted = redactNewRelicText(lines.join("\n"), {
		allowAccountIds: [config.accountId],
	});
	const capped = capExcerpt(
		redacted,
		NEWRELIC_CONTEXT_MAX_SUMMARY_CHARS,
		NEWRELIC_CONTEXT_MAX_SUMMARY_CHARS * 4,
	);
	return { text: capped.text, truncated: capped.truncated };
}

async function fetchNrql(
	config: Config,
	client: HttpClient,
	input: {
		nrql: string;
		window: NewRelicWindow;
		title: string;
		fetchedAt: string;
		kind: string;
		queryLabel: string;
	},
): Promise<NewRelicEvidenceResult> {
	const query = `${input.nrql} SINCE ${input.window.fromMs} UNTIL ${input.window.toMs} LIMIT ${NEWRELIC_MAX_NRQL_ROWS}`;
	const outcome = await client.call(
		newRelicNrqlGraphQl(config.accountId),
		{ query },
		"newrelic nrql",
	);
	if (outcome.kind === "denied") {
		return { item: null, truncated: true, outcome: "denied" };
	}
	if (outcome.kind === "missing") {
		return { item: null, truncated: true, outcome: "missing" };
	}
	if (outcome.kind !== "ok") {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const parsed = newRelicNrqlDataSchema.safeParse(outcome.data);
	if (!parsed.success) {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const rows = parsed.data.actor.account?.nrql?.results ?? [];
	const rendered = renderRows(
		config,
		rows,
		input.window,
		input.window.retentionGap,
		input.queryLabel,
	);
	return {
		item: buildItem({
			kind: input.kind,
			title: input.title,
			url: `${ONE_NEW_RELIC}/data-exploration`,
			excerpt: rendered.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: rendered.truncated || input.window.retentionGap,
		outcome: "ok",
	};
}

function policiesExcerpt(policies: readonly NewRelicAlertPolicy[]): string {
	const lines = [`Alert policies: ${policies.length}`];
	policies.slice(0, NEWRELIC_MAX_ALERT_POLICIES).forEach((policy) => {
		lines.push(
			`- ${boundText(redactNewRelicText(policy.name), 200)} (${boundText(
				policy.id,
				64,
			)})`,
		);
	});
	return lines.join("\n");
}

async function fetchAlertPolicies(
	config: Config,
	client: HttpClient,
	input: { limit: number; fetchedAt: string },
): Promise<NewRelicEvidenceResult> {
	const outcome = await client.call(
		newRelicAlertPoliciesGraphQl(config.accountId),
		{},
		"newrelic alert policies",
	);
	if (outcome.kind === "denied") {
		return { item: null, truncated: true, outcome: "denied" };
	}
	if (outcome.kind === "missing") {
		return { item: null, truncated: true, outcome: "missing" };
	}
	if (outcome.kind !== "ok") {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const parsed = newRelicAlertPoliciesDataSchema.safeParse(outcome.data);
	if (!parsed.success) {
		return { item: null, truncated: true, outcome: "failed" };
	}
	const policies =
		parsed.data.actor.account?.alerts.policies.slice(0, input.limit) ?? [];
	const excerpt = capExcerpt(
		redactNewRelicText(policiesExcerpt(policies), {
			allowAccountIds: [config.accountId],
		}),
		NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS,
		NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS * 4,
	);
	return {
		item: buildItem({
			kind: "alert_policies",
			title: `Alert policies (${policies.length})`,
			url: `${ONE_NEW_RELIC}/alerts-ai`,
			excerpt: excerpt.text,
			fetchedAt: input.fetchedAt,
		}),
		truncated: excerpt.truncated,
		outcome: "ok",
	};
}

/** Validates one local item against the shared contract (source substituted). */
function validateItem(item: NewRelicContextItem): NewRelicContextItem | null {
	const { source: _source, ...rest } = item;
	const parsed = contextItemSchema.safeParse({ ...rest, source: "generic" });
	if (!parsed.success) return null;
	return { ...parsed.data, source: "newrelic" };
}

function validateBundle(input: {
	incidentFingerprint: string;
	items: NewRelicContextItem[];
	truncated: boolean;
}): NewRelicContextBundle {
	const parsed = contextBundleSchema.safeParse({
		incidentFingerprint: input.incidentFingerprint,
		items: input.items.map((item) => ({ ...item, source: "generic" })),
		truncated: input.truncated,
	});
	if (!parsed.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"newrelic context bundle violated the shared contract",
		);
	}
	return {
		incidentFingerprint: parsed.data.incidentFingerprint,
		items: input.items,
		truncated: parsed.data.truncated,
	};
}

/**
 * Fixed two-call plan. Throws only `PlatformError` with a fixed message: no
 * URL, header, key or provider text is ever part of an error.
 */
export async function fetchNewRelicContext(
	dependencies: NewRelicContextDependencies,
	input: NewRelicContextInput,
): Promise<NewRelicContextBundle> {
	const config = prepare(dependencies);
	const nowMs = config.now();
	if (!Number.isFinite(nowMs)) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"newrelic clock is unavailable",
		);
	}
	if (input === null || typeof input !== "object") {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic context input is required",
		);
	}
	const incidentFingerprint = nonEmpty(input.incidentFingerprint);
	if (incidentFingerprint === null || incidentFingerprint.length > 128) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"incidentFingerprint is required",
		);
	}
	const service = nonEmpty(input.service);
	if (service === null || service.length > 128) {
		throw new PlatformError("VALIDATION_FAILED", "service is required");
	}
	let entityGuid: string | null = null;
	if (input.entityGuid !== undefined && input.entityGuid !== null) {
		const candidate = nonEmpty(input.entityGuid);
		if (candidate === null || !NEWRELIC_ENTITY_GUID_PATTERN.test(candidate)) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"entityGuid is not a New Relic entity GUID",
			);
		}
		entityGuid = candidate;
	}
	const window = resolveNewRelicWindow({
		nowMs,
		startsAt: input.startsAt,
		windowMinutes: input.windowMinutes,
	});
	const fetchedAt = new Date(nowMs).toISOString();
	const client = createClient(config);

	const entity =
		entityGuid === null
			? await fetchEntityBySearch(config, client, { service, fetchedAt })
			: await fetchEntityByGuid(config, client, {
					guid: entityGuid,
					fetchedAt,
				});
	const nrql = await fetchNrql(config, client, {
		nrql: newRelicServiceNrql(service),
		window,
		title: "Transaction error aggregate",
		fetchedAt,
		kind: "nrql_aggregate",
		queryLabel: "count(*) FROM Transaction FACET error.class",
	});

	const requestedItems = dependencies.maxItems ?? NEWRELIC_CONTEXT_MAX_ITEMS;
	const maxItems = Number.isFinite(requestedItems)
		? Math.max(
				1,
				Math.min(Math.trunc(requestedItems), NEWRELIC_CONTEXT_MAX_ITEMS),
			)
		: NEWRELIC_CONTEXT_MAX_ITEMS;
	const requestedChars =
		dependencies.maxExcerptChars ?? NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS;
	const maxExcerptChars = Number.isFinite(requestedChars)
		? Math.max(
				1,
				Math.min(
					Math.trunc(requestedChars),
					NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS,
				),
			)
		: NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS;
	const encoder = new TextEncoder();
	const items: NewRelicContextItem[] = [];
	let usedBytes = 0;
	let truncated = entity.truncated || nrql.truncated;

	for (const candidate of [entity.item, nrql.item]) {
		if (candidate === null) {
			truncated = true;
			continue;
		}
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = NEWRELIC_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
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
		const rebuilt = validateItem({
			...candidate,
			excerpt: capped.text,
			sha256: sha256Hex(capped.text),
		});
		if (rebuilt === null) {
			truncated = true;
			continue;
		}
		items.push(rebuilt);
		usedBytes += encoder.encode(rebuilt.excerpt).byteLength;
	}

	return validateBundle({
		incidentFingerprint,
		items,
		truncated,
	});
}

/**
 * Single-resource variants used by the read-only tools. Each has its own call
 * budget and the same caps; none mutates provider state. `missing`/`denied`
 * are returned so the tool layer can map them to `NOT_FOUND`/`POLICY_DENIED`.
 */
export async function fetchNewRelicEntityEvidence(
	dependencies: NewRelicContextDependencies,
	input: { guid: string; fetchedAt?: string },
): Promise<NewRelicEvidenceResult> {
	const config = prepare(dependencies);
	const guid = nonEmpty(input.guid);
	if (guid === null || !NEWRELIC_ENTITY_GUID_PATTERN.test(guid)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"entityGuid is not a New Relic entity GUID",
		);
	}
	return fetchEntityByGuid(config, createClient(config), {
		guid,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
}

export async function fetchNewRelicNrqlEvidence(
	dependencies: NewRelicContextDependencies,
	input: {
		nrql: string;
		startsAt?: string;
		windowMinutes?: number;
		fetchedAt?: string;
	},
): Promise<NewRelicEvidenceResult> {
	const config = prepare(dependencies);
	const nowMs = config.now();
	const window = resolveNewRelicWindow({
		nowMs,
		startsAt: input.startsAt,
		windowMinutes: input.windowMinutes,
	});
	return fetchNrql(config, createClient(config), {
		nrql: input.nrql,
		window,
		title: "NRQL aggregate result",
		fetchedAt: input.fetchedAt ?? new Date(nowMs).toISOString(),
		kind: "nrql_aggregate",
		queryLabel: "SELECT aggregate (guarded)",
	});
}

export async function fetchNewRelicAlertPolicyEvidence(
	dependencies: NewRelicContextDependencies,
	input: { limit?: number; fetchedAt?: string } = {},
): Promise<NewRelicEvidenceResult> {
	const config = prepare(dependencies);
	const limit = Math.max(
		1,
		Math.min(input.limit ?? 10, NEWRELIC_MAX_ALERT_POLICIES),
	);
	return fetchAlertPolicies(config, createClient(config), {
		limit,
		fetchedAt: input.fetchedAt ?? new Date(config.now()).toISOString(),
	});
}
