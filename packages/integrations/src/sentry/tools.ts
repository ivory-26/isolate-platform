import { isBoundedHttpsUrl, isPlatformError } from "@isolate/shared";
import { selectSentryStackFrames, sentryEventReleaseVersion } from "./context";
import { boundText, createSentryHttpClient } from "./http";
import { redactSentryText } from "./redact";
import {
	type SentryEventResponse,
	type SentryIssueResource,
	sentryEventResponseSchema,
	sentryGetIssueInputSchema,
	sentryIssueListSchema,
	sentryIssueResponseSchema,
	sentryLatestEventInputSchema,
	sentryListIssuesInputSchema,
} from "./schemas";
import type {
	SentryEventSummary,
	SentryIssueSummary,
	SentryToolDependencies,
	SentryToolErrorCode,
	SentryToolResult,
} from "./types";

/**
 * Sentry agent tools (docs/connectors/sentry.md §6).
 *
 * All three are read-only (risk band `read_only`): the worker executes them
 * server-side, the policy table admits and audits them, and the sandbox never
 * sees the token. Each function accepts untrusted tool arguments, validates
 * them with a strict Zod schema, uses one fixed URL template and returns a
 * bounded, redacted summary — never a provider body, never an error echo.
 *
 * Writes are deliberately absent: `sentry.resolve_issue` would be `sensitive`
 * and is out of scope.
 */

const SENTRY_TOOL_TAG_ALLOWLIST: ReadonlySet<string> = new Set([
	"environment",
	"release",
	"level",
	"dist",
	"runtime",
	"os",
	"browser",
	"mechanism",
	"handled",
]);

function mapFailure(error: unknown): SentryToolErrorCode {
	if (isPlatformError(error)) {
		switch (error.code) {
			case "VALIDATION_FAILED":
			case "NOT_FOUND":
			case "POLICY_DENIED":
			case "RATE_LIMITED":
			case "INTEGRATION_UNAVAILABLE":
				return error.code;
			default:
				return "INTEGRATION_UNAVAILABLE";
		}
	}
	return "INTEGRATION_UNAVAILABLE";
}

function safeText(
	value: string | null | undefined,
	maxChars: number,
	extraSecrets: readonly string[],
): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return boundText(redactSentryText(trimmed, extraSecrets), maxChars);
}

function toIssueSummary(
	issue: SentryIssueResource,
	extraSecrets: readonly string[],
): SentryIssueSummary {
	const permalink = safeText(issue.permalink, 512, extraSecrets);
	return {
		id: boundText(issue.id, 64),
		shortId: safeText(issue.shortId, 64, extraSecrets),
		title: safeText(issue.title, 200, extraSecrets) ?? "untitled",
		level: issue.level ?? null,
		status: safeText(issue.status, 64, extraSecrets),
		count: issue.count ?? null,
		lastSeen: safeText(issue.lastSeen, 64, extraSecrets),
		projectSlug: safeText(issue.project?.slug, 64, extraSecrets),
		permalink:
			permalink !== null && isBoundedHttpsUrl(permalink) ? permalink : null,
	};
}

function toEventSummary(
	event: SentryEventResponse,
	extraSecrets: readonly string[],
): SentryEventSummary {
	const tags: Record<string, string> = {};
	for (const tag of event.tags ?? []) {
		if (!SENTRY_TOOL_TAG_ALLOWLIST.has(tag.key)) continue;
		if (Object.keys(tags).length >= 20) break;
		const value = safeText(tag.value, 200, extraSecrets);
		if (value !== null) tags[tag.key] = value;
	}
	const stack = selectSentryStackFrames(event);
	return {
		eventId: boundText(event.eventID, 64),
		message:
			safeText(event.message ?? event.title, 1000, extraSecrets) ??
			"no message",
		culprit: safeText(event.culprit, 300, extraSecrets),
		level: event.level ?? null,
		releaseVersion: safeText(
			sentryEventReleaseVersion(event),
			200,
			extraSecrets,
		),
		tags,
		frames: stack.lines
			.slice(0, 8)
			.map((line) => boundText(redactSentryText(line, extraSecrets), 400)),
	};
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

/**
 * `sentry.list_issues` — read-only (`read_only`).
 *
 * A fixed issue search for one organization (optionally one project), at most
 * 25 summaries. The query is a bounded allowlisted character set; the model
 * cannot select a host, endpoint or page.
 */
export async function listSentryIssues(
	dependencies: SentryToolDependencies,
	input: unknown,
): Promise<SentryToolResult<SentryIssueSummary[]>> {
	const parsed = sentryListIssuesInputSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, code: "VALIDATION_FAILED" };
	}
	const { orgSlug, projectSlug, query, limit = 10 } = parsed.data;
	const extraSecrets =
		dependencies.token.length >= 8 ? [dependencies.token] : [];
	try {
		const http = createSentryHttpClient(dependencies);
		const search = query === undefined ? "" : `&query=${encodeSegment(query)}`;
		const path =
			projectSlug === undefined
				? `/api/0/organizations/${encodeSegment(orgSlug)}/issues/?limit=${limit}${search}`
				: `/api/0/projects/${encodeSegment(orgSlug)}/${encodeSegment(projectSlug)}/issues/?limit=${limit}${search}`;
		const result = await http.call(path, "sentry issue list");
		if (result.kind === "missing") return { ok: false, code: "NOT_FOUND" };
		if (result.kind === "denied") return { ok: false, code: "POLICY_DENIED" };
		if (result.kind !== "ok") {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		const issues = sentryIssueListSchema.safeParse(result.body);
		if (!issues.success) {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		return {
			ok: true,
			data: issues.data
				.slice(0, limit)
				.map((issue) => toIssueSummary(issue, extraSecrets)),
		};
	} catch (error) {
		return { ok: false, code: mapFailure(error) };
	}
}

/**
 * `sentry.get_issue` — read-only (`read_only`).
 *
 * One issue's metadata for a validated org slug and issue id. A foreign or
 * invisible issue is `NOT_FOUND`; the error never says which.
 */
export async function getSentryIssue(
	dependencies: SentryToolDependencies,
	input: unknown,
): Promise<SentryToolResult<SentryIssueSummary>> {
	const parsed = sentryGetIssueInputSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, code: "VALIDATION_FAILED" };
	}
	const { orgSlug, issueId } = parsed.data;
	const extraSecrets =
		dependencies.token.length >= 8 ? [dependencies.token] : [];
	try {
		const http = createSentryHttpClient(dependencies);
		const result = await http.call(
			`/api/0/organizations/${encodeSegment(orgSlug)}/issues/${encodeSegment(issueId)}/`,
			"sentry issue",
		);
		if (result.kind === "missing") return { ok: false, code: "NOT_FOUND" };
		if (result.kind === "denied") return { ok: false, code: "POLICY_DENIED" };
		if (result.kind !== "ok") {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		const issue = sentryIssueResponseSchema.safeParse(result.body);
		if (!issue.success) {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		return { ok: true, data: toIssueSummary(issue.data, extraSecrets) };
	} catch (error) {
		return { ok: false, code: mapFailure(error) };
	}
}

/**
 * `sentry.latest_event` — read-only (`read_only`).
 *
 * The latest event's message, allowlisted tags, release and top stack frames.
 * Frames are redacted and bounded; request data, breadcrumbs and locals are
 * never part of the response.
 */
export async function getSentryLatestEvent(
	dependencies: SentryToolDependencies,
	input: unknown,
): Promise<SentryToolResult<SentryEventSummary>> {
	const parsed = sentryLatestEventInputSchema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, code: "VALIDATION_FAILED" };
	}
	const { orgSlug, issueId } = parsed.data;
	const extraSecrets =
		dependencies.token.length >= 8 ? [dependencies.token] : [];
	try {
		const http = createSentryHttpClient(dependencies);
		const result = await http.call(
			`/api/0/organizations/${encodeSegment(orgSlug)}/issues/${encodeSegment(issueId)}/events/latest/`,
			"sentry latest event",
		);
		if (result.kind === "missing") return { ok: false, code: "NOT_FOUND" };
		if (result.kind === "denied") return { ok: false, code: "POLICY_DENIED" };
		if (result.kind !== "ok") {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		const event = sentryEventResponseSchema.safeParse(result.body);
		if (!event.success) {
			return { ok: false, code: "INTEGRATION_UNAVAILABLE" };
		}
		return { ok: true, data: toEventSummary(event.data, extraSecrets) };
	} catch (error) {
		return { ok: false, code: mapFailure(error) };
	}
}
