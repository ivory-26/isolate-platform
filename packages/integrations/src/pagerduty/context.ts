import { createHash } from "node:crypto";
import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	isBoundedHttpsUrl,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import {
	createPagerDutyReadCaller,
	PAGERDUTY_MAX_CONTEXT_CALLS,
	type PagerDutyFetch,
} from "./client";
import { pagerDutyIncidentFingerprint } from "./normalize";
import { redactPagerDutyText } from "./redact";
import {
	type PagerDutyLogEntry,
	pagerDutyEscalationPolicyResponseSchema,
	pagerDutyIncidentResponseSchema,
	pagerDutyLogEntriesResponseSchema,
	pagerDutyServiceResponseSchema,
} from "./schemas";

/**
 * PagerDuty incident-context reader.
 *
 * Fixed query plan (never model-authored): incident → bounded log timeline →
 * service → escalation-policy name. At most 4 calls, one page each, 10 s per
 * call, 256 KiB per response. The reader never calls `/oncalls`, `/alerts`,
 * `/notes`, `include[]=channels` or `first_trigger_log_entries`: responders,
 * alert payloads and free-form notes are PII surface.
 *
 * Every item is composed only from allowlisted fields, redacted (emails,
 * phones, contact methods, token, `From` address), then truncated, then hashed.
 * `truncated` is set whenever a cap, 403/404, parse failure or budget dropped
 * evidence. A missing optional resource yields a valid partial bundle; a 401 or
 * 429 fails closed; a 403 on the incident itself is `POLICY_DENIED`.
 */

export const PAGERDUTY_CONTEXT_MAX_ITEMS = MAX_CONTEXT_ITEMS;
export const PAGERDUTY_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const PAGERDUTY_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
/** The log timeline is a single bounded item (one-line actions, no names). */
export const PAGERDUTY_CONTEXT_MAX_LOG_ENTRIES = 20;
export const PAGERDUTY_CONTEXT_MAX_LOG_EXCERPT_CHARS = 2000;
export const PAGERDUTY_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;

const INCIDENT_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export type PagerDutyContextDependencies = {
	/** Read-only account API key (`incidents.read`, `services.read`, ...). */
	token: string;
	baseUrl?: string;
	/** Optional `From` header; redacted from every excerpt and never logged. */
	fromEmail?: string;
	fetchImpl?: PagerDutyFetch;
	now?: () => number;
	timeoutMs?: number;
};

export type PagerDutyContextInput = {
	incidentId: string;
	/** Signal fingerprint this bundle answers; derived when omitted. */
	incidentFingerprint?: string;
};

type Candidate = {
	kind: string;
	title: string;
	url: string | undefined;
	excerpt: string;
	maxChars: number;
	priority: number;
};

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** Display-only, bounded https URL; anything else is dropped, never fetched. */
function safeUrl(value: string | undefined): string | undefined {
	return value !== undefined && isBoundedHttpsUrl(value) ? value : undefined;
}

function bound(text: string, maxChars: number): string {
	return text.length <= maxChars
		? text
		: `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Redact-then-truncate. The excerpt never exceeds the character cap or the
 * byte budget; `truncated` drives `ContextBundle.truncated`.
 */
export function capPagerDutyExcerpt(
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
		const nextLength = Math.max(1, Math.floor(out.length * 0.9));
		out = out.slice(0, nextLength);
		truncated = true;
	}
	return { text: out, truncated };
}

function validateInput(input: PagerDutyContextInput): {
	incidentId: string;
	incidentFingerprint?: string;
} {
	const incidentId =
		input !== null && typeof input === "object" ? input.incidentId : undefined;
	if (typeof incidentId !== "string" || !INCIDENT_ID_PATTERN.test(incidentId)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"incidentId must be a bounded pagerduty resource id",
		);
	}
	const fingerprint = input.incidentFingerprint;
	if (fingerprint !== undefined) {
		if (
			typeof fingerprint !== "string" ||
			fingerprint.trim().length === 0 ||
			fingerprint.length > 128
		) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"incidentFingerprint must be a bounded string",
			);
		}
	}
	return {
		incidentId,
		...(fingerprint === undefined
			? {}
			: { incidentFingerprint: fingerprint.trim() }),
	};
}

function timelineLine(entry: PagerDutyLogEntry): string {
	const actorRole = nonEmpty(entry.agent?.type) ?? "unknown";
	// The action type and actor *role* only: no names, summaries, notes or
	// contact details are ever read from the log entry.
	return `${entry.created_at} ${entry.type} — actor:${actorRole}`;
}

/**
 * Fetches one bounded bundle. Throws only `PlatformError` with a fixed message:
 * no response body, URL, header or token is ever part of an error.
 */
export async function fetchPagerDutyContext(
	dependencies: PagerDutyContextDependencies,
	input: PagerDutyContextInput,
): Promise<ContextBundle> {
	const { incidentId, incidentFingerprint } = validateInput(input);
	const caller = createPagerDutyReadCaller({
		token: dependencies.token,
		...(dependencies.baseUrl === undefined
			? {}
			: { baseUrl: dependencies.baseUrl }),
		...(dependencies.fromEmail === undefined
			? {}
			: { fromEmail: dependencies.fromEmail }),
		...(dependencies.fetchImpl === undefined
			? {}
			: { fetchImpl: dependencies.fetchImpl }),
		...(dependencies.timeoutMs === undefined
			? {}
			: { timeoutMs: dependencies.timeoutMs }),
		maxCalls: PAGERDUTY_MAX_CONTEXT_CALLS,
	});
	const nowMs = (dependencies.now ?? (() => Date.now()))();
	const fetchedAt = new Date(nowMs).toISOString();
	const secrets = [
		dependencies.token,
		...(dependencies.fromEmail === undefined ? [] : [dependencies.fromEmail]),
	];
	const redact = (text: string): string => redactPagerDutyText(text, secrets);
	const encoder = new TextEncoder();

	let truncated = false;
	const candidates: Candidate[] = [];

	// 1. Incident. A 403 here means the token cannot read the incident at all.
	const incidentResult = await caller.call(
		`/incidents/${encodeURIComponent(incidentId)}?include%5B%5D=services&include%5B%5D=priorities`,
		"pagerduty incident",
	);
	if (incidentResult.kind === "denied") {
		throw new PlatformError(
			"POLICY_DENIED",
			"pagerduty context access was denied (status 403)",
		);
	}

	let incident:
		| ReturnType<typeof pagerDutyIncidentResponseSchema.parse>["incident"]
		| null = null;
	if (incidentResult.kind === "ok") {
		const parsed = pagerDutyIncidentResponseSchema.safeParse(
			incidentResult.body,
		);
		if (parsed.success) {
			incident = parsed.data.incident;
		} else {
			truncated = true;
		}
	} else if (incidentResult.kind !== "budget") {
		// Absence of evidence, never "no problem found"; the tool surface maps a
		// 404 to NOT_FOUND, the bundle stays partial.
		truncated = true;
	}

	const incidentUrl = safeUrl(incident?.html_url);

	if (incident !== null) {
		const lines = [
			`Incident: ${incident.id}${incident.number === undefined ? "" : ` (#${incident.number})`}`,
			`Title: ${bound(redact(incident.title), 200)}`,
			`Status: ${incident.status}`,
			`Urgency: ${nonEmpty(incident.urgency) ?? "not set"}`,
			`Priority: ${nonEmpty(incident.priority?.name) ?? "not set"}`,
			`Service: ${bound(redact(nonEmpty(incident.service.name) ?? incident.service.id), 200)} (${incident.service.id})`,
			...(nonEmpty(incident.created_at) === null
				? []
				: [`Created: ${incident.created_at}`]),
			...(nonEmpty(incident.updated_at) === null
				? []
				: [`Updated: ${incident.updated_at}`]),
		];
		if (incidentUrl !== undefined) {
			candidates.push({
				kind: "incident",
				title: bound(
					redact(
						`PagerDuty incident${incident.number === undefined ? "" : ` #${incident.number}`}: ${incident.title}`,
					),
					200,
				),
				url: incidentUrl,
				excerpt: lines.join("\n"),
				maxChars: PAGERDUTY_CONTEXT_MAX_EXCERPT_CHARS,
				priority: 10,
			});
		} else {
			truncated = true;
		}
	}

	// 2. Log timeline: one page (`limit=20`), overview entries only. `is_overview`
	//    keeps arbitrary note/alert bodies out of the response.
	const logResult = await caller.call(
		`/incidents/${encodeURIComponent(incidentId)}/log_entries?limit=${PAGERDUTY_CONTEXT_MAX_LOG_ENTRIES}&is_overview=true`,
		"pagerduty incident log entries",
	);
	if (logResult.kind === "ok") {
		const parsed = pagerDutyLogEntriesResponseSchema.safeParse(logResult.body);
		if (parsed.success) {
			const entries = [...parsed.data.log_entries]
				.sort(
					(left, right) =>
						Date.parse(right.created_at) - Date.parse(left.created_at),
				)
				.slice(0, PAGERDUTY_CONTEXT_MAX_LOG_ENTRIES);
			if (
				parsed.data.log_entries.length > PAGERDUTY_CONTEXT_MAX_LOG_ENTRIES ||
				parsed.data.more === true
			) {
				truncated = true;
			}
			if (entries.length > 0) {
				const excerpt = entries.map(timelineLine).join("\n");
				const logUrl = incidentUrl ?? safeUrl(incident?.service.html_url);
				if (logUrl !== undefined) {
					candidates.push({
						kind: "log_entry",
						title: `PagerDuty log timeline (${entries.length} recent entries)`,
						url: logUrl,
						excerpt,
						maxChars: PAGERDUTY_CONTEXT_MAX_LOG_EXCERPT_CHARS,
						priority: 20,
					});
				} else {
					truncated = true;
				}
			}
		} else {
			truncated = true;
		}
	} else if (logResult.kind !== "budget") {
		truncated = true;
	}

	// 3. Service metadata. The service-to-repository binding uses the id, never
	//    the (non-unique) name.
	let service: {
		id: string;
		name: string;
		html_url?: string;
		escalation_policy?: { id: string; name?: string };
	} | null = null;
	const serviceId = incident?.service.id ?? null;
	if (serviceId !== null) {
		const serviceResult = await caller.call(
			`/services/${encodeURIComponent(serviceId)}`,
			"pagerduty service",
		);
		if (serviceResult.kind === "ok") {
			const parsed = pagerDutyServiceResponseSchema.safeParse(
				serviceResult.body,
			);
			if (parsed.success) {
				service = parsed.data.service;
			} else {
				truncated = true;
			}
		} else if (serviceResult.kind !== "budget") {
			truncated = true;
		}
	}

	// 4. Escalation-policy name only. Membership, schedules and responders are
	//    PII and are never requested.
	let policyName: string | null =
		nonEmpty(service?.escalation_policy?.name) ??
		nonEmpty(incident?.service.escalation_policy?.name);
	const policyId =
		service?.escalation_policy?.id ??
		incident?.service.escalation_policy?.id ??
		null;
	if (policyId !== null) {
		const policyResult = await caller.call(
			`/escalation_policies/${encodeURIComponent(policyId)}`,
			"pagerduty escalation policy",
		);
		if (policyResult.kind === "ok") {
			const parsed = pagerDutyEscalationPolicyResponseSchema.safeParse(
				policyResult.body,
			);
			if (parsed.success) {
				policyName = nonEmpty(parsed.data.escalation_policy.name) ?? policyName;
			} else {
				truncated = true;
			}
		} else if (policyResult.kind !== "budget") {
			truncated = true;
		}
	}

	if (service !== null) {
		const serviceUrl =
			safeUrl(service.html_url) ?? incidentUrl ?? safeUrl(incident?.html_url);
		const lines = [
			`Service: ${bound(redact(nonEmpty(service.name) ?? service.id), 200)}`,
			`Service ID: ${service.id}`,
			`Escalation policy: ${bound(redact(policyName ?? "not available"), 200)}`,
		];
		if (serviceUrl !== undefined) {
			candidates.push({
				kind: "service",
				title: bound(`PagerDuty service: ${service.name}`, 200),
				url: serviceUrl,
				excerpt: lines.join("\n"),
				maxChars: PAGERDUTY_CONTEXT_MAX_EXCERPT_CHARS,
				priority: 30,
			});
		} else {
			truncated = true;
		}
	} else if (serviceId !== null) {
		truncated = true;
	}

	// Rank and allocate the excerpt budget. Lower priority number wins.
	const sorted = [...candidates].sort(
		(left, right) => left.priority - right.priority,
	);
	const items: ContextItem[] = [];
	let usedBytes = 0;
	for (const candidate of sorted) {
		if (items.length >= PAGERDUTY_CONTEXT_MAX_ITEMS) {
			truncated = true;
			break;
		}
		const remaining = PAGERDUTY_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
		if (remaining < 64) {
			truncated = true;
			break;
		}
		const allowedBytes = Math.min(remaining, candidate.maxChars * 4);
		const capped = capPagerDutyExcerpt(
			redact(candidate.excerpt),
			candidate.maxChars,
			allowedBytes,
		);
		if (capped.truncated) truncated = true;
		if (capped.text.trim().length === 0) continue;
		items.push({
			source: "pagerduty",
			kind: candidate.kind,
			title: bound(redact(candidate.title), 200),
			...(candidate.url === undefined ? {} : { url: candidate.url }),
			excerpt: capped.text,
			fetchedAt,
			trustLevel: "untrusted",
			sha256: sha256Hex(capped.text),
		});
		usedBytes += encoder.encode(capped.text).byteLength;
	}

	if (caller.isIncomplete()) truncated = true;

	const fingerprint =
		incidentFingerprint ??
		pagerDutyIncidentFingerprint({
			serviceId: incident?.service.id ?? "unknown",
			incidentId,
		});
	const bundle = {
		incidentFingerprint: fingerprint,
		items,
		truncated,
	};
	const validated = contextBundleSchema.safeParse(bundle);
	if (!validated.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty context bundle violated the shared contract",
		);
	}
	return validated.data;
}
