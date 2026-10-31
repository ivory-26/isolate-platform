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
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { redactNewRelicText } from "./redact";
import {
	NEWRELIC_ACCOUNT_ID_PATTERN,
	type NewRelicAlertPayload,
	type NewRelicImpactedEntity,
	newRelicPrioritySchema,
	parseNewRelicAlertPayload,
} from "./schemas";

/**
 * New Relic alert normalization (`docs/connectors/newrelic.md` §1/§4).
 *
 * One verified workflow payload becomes at most one bounded incident signal:
 *
 * - only an `ACTIVATED` issue creates a task; `CLOSED` and `ACKNOWLEDGED` do
 *   not (dedupe by issue + state transition happens in intake);
 * - `CRITICAL`/`HIGH`/`MEDIUM`/`LOW`/`INFO` map onto the platform severity
 *   scale; unknown priorities are rejected by the strict schema;
 * - the fingerprint is stable across redeliveries: it hashes the configured
 *   account, policy, condition and impacted entity, never the issue id, the
 *   state or a delivery id;
 * - the service comes from entity tags (`service`, `service.name`, `app`,
 *   `appName`) with the entity name as fallback;
 * - a `createdAt` older than 15 minutes is rejected (no signed timestamp).
 *
 * The source literal is `"newrelic"`. `INCIDENT_SOURCES` does not include it
 * yet (docs/connector-usage.md §2.2 contract-first order); this module uses a
 * local literal type and validates the rest against `incidentSignalSchema`
 * with a temporary `"generic"` source so every shared cap still applies.
 */

export const NEWRELIC_ALERT_INCIDENT_KIND = "alert_activated";
/** The only state that opens a task. */
export const NEWRELIC_TRIGGERING_STATE = "ACTIVATED";
/** Freshness window for an unsigned delivery (`createdAt`). */
export const NEWRELIC_MAX_PAYLOAD_AGE_SECONDS = 900;
/** Small allowance for a clock ahead of the receiver. */
export const NEWRELIC_MAX_PAYLOAD_FUTURE_SECONDS = 300;

/** Local literal until the shared `INCIDENT_SOURCES` enum is extended. */
export type NewRelicIncidentSource = "newrelic";
export type NewRelicIncidentSignal = Omit<IncidentSignal, "source"> & {
	source: NewRelicIncidentSource;
};

export type NewRelicNormalizeOptions = {
	/** Configured account id (trusted code); never taken from the payload. */
	accountId: string | number;
	/** Receipt time from trusted code; defaults to wall clock. */
	receivedAt?: string;
	/** Trusted clock in epoch milliseconds; defaults to wall clock. */
	nowMs?: number;
};

const SEVERITY_BY_PRIORITY: Readonly<Record<string, IncidentSeverity>> = {
	CRITICAL: "critical",
	HIGH: "high",
	MEDIUM: "medium",
	LOW: "low",
	INFO: "info",
};

const SERVICE_TAG_KEYS = [
	"service",
	"service.name",
	"service_name",
	"app",
	"appname",
	"app.name",
] as const;

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

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

/**
 * Priority → platform severity (`docs/connectors/newrelic.md` §1). Case is
 * normalized; an unknown value maps to `medium` so a schema drift degrades
 * instead of silently escalating.
 */
export function newRelicSeverityOf(
	value: string | null | undefined,
): IncidentSeverity {
	const parsed = newRelicPrioritySchema.safeParse(
		nonEmpty(value)?.toUpperCase(),
	);
	return parsed.success ? SEVERITY_BY_PRIORITY[parsed.data] : "medium";
}

function accountIdOf(value: string | number): string {
	const text = typeof value === "number" ? String(value) : value.trim();
	if (!NEWRELIC_ACCOUNT_ID_PATTERN.test(text)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic accountId is invalid",
		);
	}
	return text;
}

function receivedAtOf(options: NewRelicNormalizeOptions): string {
	const candidate = options.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date().toISOString();
}

function nowOf(options: NewRelicNormalizeOptions): number {
	const value = options.nowMs ?? Date.now();
	return Number.isFinite(value) ? value : Date.now();
}

/**
 * True when `createdAt` is within the 15-minute replay window. A future
 * timestamp beyond five minutes is treated as invalid, not as fresh.
 */
export function isNewRelicPayloadFresh(
	createdAt: string,
	nowMs: number,
	maxAgeSeconds: number = NEWRELIC_MAX_PAYLOAD_AGE_SECONDS,
): boolean {
	const parsed = z.iso.datetime({ offset: true }).safeParse(createdAt);
	if (!parsed.success) return false;
	const createdMs = Date.parse(parsed.data);
	if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return false;
	const ageMs = nowMs - createdMs;
	return (
		ageMs <= maxAgeSeconds * 1000 &&
		ageMs >= -NEWRELIC_MAX_PAYLOAD_FUTURE_SECONDS * 1000
	);
}

/**
 * Source-stable dedupe key: `newrelic:<first32Hex(sha256(account|policy|
 * condition|entity))>`. The entity identity is the GUID when present, else the
 * entity name; state and issue id are excluded so a redelivery dedupes.
 */
export function newRelicIncidentFingerprint(input: {
	accountId: string;
	policyName: string;
	conditionName: string;
	entityIdentity: string;
}): string {
	const digest = createHash("sha256")
		.update(
			[
				input.accountId.trim(),
				input.policyName.trim().toLowerCase(),
				input.conditionName.trim().toLowerCase(),
				input.entityIdentity.trim().toLowerCase(),
			].join("|"),
		)
		.digest("hex")
		.slice(0, 32);
	const fingerprint = `newrelic:${digest}`;
	return fingerprint.length <= MAX_INCIDENT_FINGERPRINT_CHARS
		? fingerprint
		: fingerprint.slice(0, MAX_INCIDENT_FINGERPRINT_CHARS);
}

function entityIdentity(entity: NewRelicImpactedEntity): string {
	return nonEmpty(entity.guid) ?? nonEmpty(entity.id) ?? entity.name;
}

function entitySortKey(entity: NewRelicImpactedEntity): string {
	return `${entityIdentity(entity).toLowerCase()}|${entity.name.toLowerCase()}`;
}

/** Deterministic: the payload order is not a severity signal. */
function orderedEntities(
	entities: readonly NewRelicImpactedEntity[],
): NewRelicImpactedEntity[] {
	return [...entities].sort((left, right) =>
		compareStrings(entitySortKey(left), entitySortKey(right)),
	);
}

function serviceFromEntity(entity: NewRelicImpactedEntity): string {
	for (const wanted of SERVICE_TAG_KEYS) {
		for (const tag of entity.tags ?? []) {
			if (tag.key.trim().toLowerCase() !== wanted) continue;
			const value = nonEmpty(tag.values[0]);
			if (value === null) continue;
			const bounded = boundText(
				redactNewRelicText(value),
				MAX_INCIDENT_SERVICE_CHARS,
			);
			if (bounded.length > 0) return bounded;
		}
	}
	const name = boundText(
		redactNewRelicText(entity.name),
		MAX_INCIDENT_SERVICE_CHARS,
	);
	return name.length > 0 ? name : "newrelic";
}

function boundedLink(label: string, url: string): IncidentLink | null {
	if (!isBoundedHttpsUrl(url)) return null;
	let safe: string;
	try {
		const parsed = new URL(url);
		// Display-only: a query string can carry session or token material.
		parsed.search = "";
		parsed.hash = "";
		safe = parsed.toString();
	} catch {
		return null;
	}
	return { label: boundText(label, 120), url: safe };
}

function buildLinks(
	payload: NewRelicAlertPayload,
	entity: NewRelicImpactedEntity,
): IncidentLink[] {
	const candidates: IncidentLink[] = [];
	const issue = boundedLink("Issue", payload.issueUrl);
	if (issue !== null) candidates.push(issue);
	const guid = nonEmpty(entity.guid);
	if (guid !== null) {
		const entityLink = boundedLink(
			"Entity",
			`https://one.newrelic.com/redirect/entity/${encodeURIComponent(guid)}`,
		);
		if (entityLink !== null) candidates.push(entityLink);
	}
	const seen = new Set<string>();
	const links: IncidentLink[] = [];
	for (const link of candidates) {
		if (seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

/**
 * Normalizes one verified New Relic workflow payload, or returns `null` when it
 * must not create a task: a non-`ACTIVATED` state, a stale/future `createdAt`,
 * or a body that does not match the pinned strict template.
 *
 * Pure: no network, no credential. `accountId` comes from trusted
 * configuration; `receivedAt` comes from receipt, never from the payload.
 */
export function normalizeNewRelicIncident(
	payload: unknown,
	options: NewRelicNormalizeOptions,
): NewRelicIncidentSignal | null {
	if (options === null || typeof options !== "object") {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"newrelic normalize options are required",
		);
	}
	const accountId = accountIdOf(options.accountId);
	const parsed = parseNewRelicAlertPayload(payload);
	if (parsed === null) return null;
	if (parsed.state !== NEWRELIC_TRIGGERING_STATE) return null;
	if (!isNewRelicPayloadFresh(parsed.createdAt, nowOf(options))) return null;

	const entities = orderedEntities(parsed.impactedEntities);
	const chosen = entities[0];
	if (chosen === undefined) return null;

	const service = serviceFromEntity(chosen);
	const severity = newRelicSeverityOf(parsed.priority);
	const identity = entityIdentity(chosen);
	const entityNames = entities
		.slice(0, 5)
		.map((entity) => boundText(redactNewRelicText(entity.name), 120))
		.join(", ");
	const omittedEntities = entities.length - 5;

	const summaryLines = [
		`Issue: ${boundText(parsed.title, 200)}`,
		`State: ${parsed.state}`,
		`Priority: ${parsed.priority} -> ${severity}`,
		`Policy: ${boundText(parsed.policyName, 200)}`,
		`Condition: ${boundText(parsed.conditionName, 200)}`,
		`Entity: ${boundText(redactNewRelicText(chosen.name), 200)}`,
		`Entities: ${entityNames}`,
		...(omittedEntities > 0
			? [`Additional entities omitted: ${omittedEntities}`]
			: []),
		`Created: ${parsed.createdAt}`,
	];

	const signal = {
		source: "newrelic" as const,
		kind: NEWRELIC_ALERT_INCIDENT_KIND,
		severity,
		service,
		fingerprint: newRelicIncidentFingerprint({
			accountId,
			policyName: parsed.policyName,
			conditionName: parsed.conditionName,
			entityIdentity: identity,
		}),
		title: boundText(
			`New Relic alert "${boundText(
				redactNewRelicText(parsed.title),
				120,
			)}" on ${service}`,
			MAX_INCIDENT_TITLE_CHARS,
		),
		summary: boundMultiline(
			redactNewRelicText(summaryLines.join("\n"), {
				allowAccountIds: [accountId],
			}),
			MAX_INCIDENT_SUMMARY_CHARS,
		),
		links: buildLinks(parsed, chosen),
		receivedAt: receivedAtOf(options),
	};

	// Validate every shared cap and link rule with the source substituted; the
	// shared enum rejects `"newrelic"` until the coordinator extends it.
	const validated = incidentSignalSchema.safeParse({
		...signal,
		source: "generic",
	});
	if (!validated.success) return null;
	const { source: _source, ...rest } = validated.data;
	return { ...rest, source: "newrelic" };
}
