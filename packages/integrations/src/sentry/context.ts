import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	isBoundedHttpsUrl,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { boundText, createSentryHttpClient, sentrySha256Hex } from "./http";
import { sentryIncidentFingerprint } from "./normalize";
import { redactSentryText } from "./redact";
import {
	type SentryEventResponse,
	type SentryIssueResource,
	sentryDeploysResponseSchema,
	sentryEventResponseSchema,
	sentryIssueIdSchema,
	sentryIssueResponseSchema,
	sentryReleaseResponseSchema,
	sentrySlugSchema,
} from "./schemas";
import type { SentryContextDependencies, SentryContextInput } from "./types";

/**
 * Sentry incident-context reader (docs/connectors/sentry.md §5).
 *
 * Fixed query plan: issue metadata → latest event → release → newest deploy.
 * At most four calls, one page each, 10 s timeout, 256 KiB per response. The
 * model cannot ask for another endpoint, all events, attachments, breadcrumbs
 * or request data.
 *
 * Caps are enforced, not estimated: ≤10 items, ≤4,000 chars per excerpt,
 * ≤256 KiB of excerpts, 3,000 chars of stack trace. Redaction runs before
 * truncation, and the hash covers exactly the excerpt the model sees.
 *
 * Failures: 401/5xx/transport → `INTEGRATION_UNAVAILABLE`, 429 →
 * `RATE_LIMITED`, 404 on the issue → `NOT_FOUND` (foreign or invisible
 * tenant), 403 on the issue → `POLICY_DENIED`. A 404/403/oversize/parse
 * failure on an optional resource (event, release, deploys) only drops that
 * evidence and sets `truncated`.
 */

export const SENTRY_CONTEXT_MAX_ITEMS = 10;
export const SENTRY_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const SENTRY_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
export const SENTRY_CONTEXT_MAX_FETCH_CALLS = 4;
export const SENTRY_STACK_TRACE_MAX_CHARS = 3000;
export const SENTRY_MAX_STACK_FRAMES = 8;

/** Tags safe for prompt context; everything else (user, url, request) is not. */
const SENTRY_TAG_ALLOWLIST: ReadonlySet<string> = new Set([
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

const ENVIRONMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

type Candidate = {
	kind: string;
	title: string;
	url: string;
	excerpt: string;
	priority: number;
};

function validateInput(input: SentryContextInput): {
	orgSlug: string;
	issueId: string;
	environment: string | null;
} {
	if (input === null || typeof input !== "object") {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"sentry context input is required",
		);
	}
	const orgSlug = sentrySlugSchema.safeParse(input.orgSlug);
	const issueId = sentryIssueIdSchema.safeParse(input.issueId);
	if (!orgSlug.success || !issueId.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"sentry orgSlug and issueId are required",
		);
	}
	let environment: string | null = null;
	if (input.environment !== undefined) {
		if (
			typeof input.environment !== "string" ||
			!ENVIRONMENT_PATTERN.test(input.environment)
		) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"sentry environment is invalid",
			);
		}
		environment = input.environment;
	}
	return {
		orgSlug: orgSlug.data,
		issueId: issueId.data,
		environment,
	};
}

function clamp(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	return Math.min(max, Math.max(1, Math.trunc(value)));
}

function pushLine(
	lines: string[],
	label: string,
	value: string | number | null | undefined,
): void {
	if (value === null || value === undefined) return;
	const text = String(value).trim();
	if (text.length > 0) lines.push(`${label}: ${text}`);
}

function safeSentryUrl(value: string | null | undefined): string | undefined {
	return typeof value === "string" && isBoundedHttpsUrl(value)
		? value
		: undefined;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

/** Home-directory prefixes are PII; the frame keeps its module path tail. */
function sanitizeFramePath(value: string | null | undefined): string {
	if (typeof value !== "string") return "unknown";
	let out = value.replace(
		/(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/]+[\\/]/,
		"",
	);
	out = out.replace(/\\/g, "/").trim();
	if (out.length === 0) return "unknown";
	return boundText(out, 300);
}

type SelectedFrames = {
	lines: string[];
	omitted: boolean;
};

/**
 * Keeps the application frames nearest the throw: Sentry orders frames
 * oldest → newest, so the tail is the throw site. The excerpt prints them
 * innermost first.
 */
export function selectSentryStackFrames(
	event: SentryEventResponse,
): SelectedFrames {
	const exception = (event.entries ?? []).find(
		(entry) => entry.type === "exception",
	);
	const values = exception?.data?.values ?? [];
	const last = values[values.length - 1];
	const all = last?.stacktrace?.frames ?? [];
	if (all.length === 0) return { lines: [], omitted: false };

	const inApp = all.filter((frame) => frame.inApp === true);
	const pool = inApp.length >= 3 ? inApp : all;
	const selected = pool.slice(-SENTRY_MAX_STACK_FRAMES).reverse();
	const lines = selected.map((frame) => {
		const name = frame.function?.trim() || "<anonymous>";
		const filename = sanitizeFramePath(frame.filename ?? frame.module);
		const line = frame.lineNo === undefined ? "?" : String(frame.lineNo);
		const column = frame.colNo === undefined ? "?" : String(frame.colNo);
		return `at ${name} (${filename}:${line}:${column})`;
	});
	return { lines, omitted: selected.length < pool.length };
}

function exceptionLine(event: SentryEventResponse): string | null {
	const exception = (event.entries ?? []).find(
		(entry) => entry.type === "exception",
	);
	const values = exception?.data?.values ?? [];
	const last = values[values.length - 1];
	if (last === undefined) return null;
	const type = last.type?.trim() ?? "";
	const value = last.value?.trim() ?? "";
	const joined = [type, value].filter((part) => part.length > 0).join(": ");
	return joined.length === 0 ? null : joined;
}

export function sentryEventReleaseVersion(
	event: SentryEventResponse,
): string | null {
	const direct = event.release?.version?.trim();
	if (direct !== undefined && direct.length > 0 && direct.length <= 200) {
		return direct;
	}
	const tag = (event.tags ?? []).find((entry) => entry.key === "release");
	const value = tag?.value.trim();
	return value !== undefined && value.length > 0 && value.length <= 200
		? value
		: null;
}

function buildIssueCandidate(
	issue: SentryIssueResource,
	url: string,
): Candidate {
	const lines: string[] = [];
	pushLine(lines, "Issue", issue.shortId?.trim() || issue.id);
	pushLine(lines, "Title", issue.title);
	pushLine(lines, "Level", issue.level ?? "error");
	pushLine(lines, "Status", issue.status);
	pushLine(lines, "Culprit", issue.culprit);
	pushLine(lines, "Count", issue.count);
	pushLine(lines, "First seen", issue.firstSeen);
	pushLine(lines, "Last seen", issue.lastSeen);
	pushLine(lines, "Project", issue.project?.slug);
	pushLine(lines, "Error", issue.metadata?.value);
	pushLine(lines, "Location", issue.metadata?.filename);
	if (lines.length === 0) lines.push(`Issue: ${issue.id}`);
	return {
		kind: "issue",
		title: boundText(
			`Issue ${issue.shortId?.trim() || issue.id}: ${issue.title?.trim() || "untitled"}`,
			200,
		),
		url,
		excerpt: lines.join("\n"),
		priority: 10,
	};
}

function buildEventCandidate(
	event: SentryEventResponse,
	url: string,
	stack: SelectedFrames,
): Candidate {
	const lines: string[] = [];
	pushLine(lines, "Event", event.eventID);
	pushLine(lines, "Message", event.message ?? event.title);
	pushLine(lines, "Culprit", event.culprit);
	pushLine(lines, "Level", event.level);
	pushLine(lines, "Release", sentryEventReleaseVersion(event));
	const tags = (event.tags ?? [])
		.filter((entry) => SENTRY_TAG_ALLOWLIST.has(entry.key))
		.slice(0, 20)
		.map((entry) => `${entry.key}=${boundText(entry.value, 200)}`);
	if (tags.length > 0) lines.push(`Tags: ${tags.join(", ")}`);
	const exception = exceptionLine(event);
	if (exception !== null)
		lines.push(`Exception: ${boundText(exception, 2000)}`);
	if (stack.lines.length > 0) {
		lines.push("Stack (nearest throw first):", ...stack.lines);
	}
	return {
		kind: "event",
		title: boundText(
			`Latest event ${event.eventID}: ${event.message?.trim() || event.title?.trim() || "no message"}`,
			200,
		),
		url,
		excerpt: lines.join("\n"),
		priority: 20,
	};
}

/**
 * Redact, then cap the stack to 3,000 chars, keeping the exception header and
 * the frames nearest the throw. The caller marks the bundle truncated when
 * the cap actually shortened evidence.
 */
function capStack(
	text: string,
	extraSecrets: readonly string[],
): {
	text: string;
	truncated: boolean;
} {
	const redacted = redactSentryText(text, extraSecrets);
	if (redacted.length <= SENTRY_STACK_TRACE_MAX_CHARS) {
		return { text: redacted, truncated: false };
	}
	return {
		text: `${redacted.slice(0, SENTRY_STACK_TRACE_MAX_CHARS - 1)}…`,
		truncated: true,
	};
}

/** Redact-then-truncate under both the character and byte budgets. */
export function capSentryExcerpt(
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

export async function fetchSentryContext(
	dependencies: SentryContextDependencies,
	input: SentryContextInput,
): Promise<ContextBundle> {
	const { orgSlug, issueId, environment } = validateInput(input);
	const http = createSentryHttpClient({
		token: dependencies.token,
		fetchImpl: dependencies.fetchImpl,
		baseUrl: dependencies.baseUrl,
		timeoutMs: dependencies.timeoutMs,
	});
	const nowMs = (dependencies.now ?? (() => Date.now()))();
	const fetchedAt = new Date(nowMs).toISOString();
	const maxItems = clamp(
		dependencies.maxItems,
		SENTRY_CONTEXT_MAX_ITEMS,
		SENTRY_CONTEXT_MAX_ITEMS,
	);
	const maxExcerptChars = clamp(
		dependencies.maxExcerptChars,
		SENTRY_CONTEXT_MAX_EXCERPT_CHARS,
		SENTRY_CONTEXT_MAX_EXCERPT_CHARS,
	);
	const extraSecrets =
		dependencies.token.length >= 8 ? [dependencies.token] : [];
	const encoder = new TextEncoder();
	let calls = 0;
	let truncated = false;

	const call = async (path: string, step: string) => {
		if (calls >= SENTRY_CONTEXT_MAX_FETCH_CALLS) {
			truncated = true;
			return { kind: "skipped" } as const;
		}
		calls += 1;
		return http.call(path, step);
	};

	const issuePath = `${`/api/0/organizations/${encodeSegment(orgSlug)}/issues/${encodeSegment(issueId)}/`}${environment === null ? "" : `?environment=${encodeSegment(environment)}`}`;
	const issueResult = await call(issuePath, "sentry issue metadata");
	if (issueResult.kind === "missing") {
		throw new PlatformError("NOT_FOUND", "sentry issue was not found");
	}
	if (issueResult.kind === "denied") {
		throw new PlatformError(
			"POLICY_DENIED",
			"sentry issue access was denied (status 403)",
		);
	}
	if (issueResult.kind !== "ok") {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"sentry issue metadata was not readable",
		);
	}
	const parsedIssue = sentryIssueResponseSchema.safeParse(issueResult.body);
	if (!parsedIssue.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"sentry issue metadata was not usable",
		);
	}
	const issue = parsedIssue.data;

	const issueWebUrl = `${http.baseUrl}/organizations/${encodeSegment(orgSlug)}/issues/${encodeSegment(issueId)}/`;
	const candidates: Candidate[] = [buildIssueCandidate(issue, issueWebUrl)];

	const eventPath = `/api/0/organizations/${encodeSegment(orgSlug)}/issues/${encodeSegment(issueId)}/events/latest/`;
	const eventResult = await call(eventPath, "sentry latest event");
	let releaseVersion: string | null = null;
	let releaseUrl: string | null = null;
	if (eventResult.kind === "ok") {
		const parsedEvent = sentryEventResponseSchema.safeParse(eventResult.body);
		if (parsedEvent.success) {
			const event = parsedEvent.data;
			releaseVersion = sentryEventReleaseVersion(event);
			const stack = selectSentryStackFrames(event);
			let stackLines = stack.lines;
			if (stackLines.length > 0) {
				const capped = capStack(stackLines.join("\n"), extraSecrets);
				if (capped.truncated) truncated = true;
				stackLines = capped.text.split("\n");
			}
			if (stack.omitted) truncated = true;
			candidates.push(
				buildEventCandidate(
					event,
					`${issueWebUrl}events/${encodeSegment(event.eventID)}/`,
					{ lines: stackLines, omitted: stack.omitted },
				),
			);
		} else {
			truncated = true;
		}
	} else {
		truncated = true;
	}

	if (releaseVersion !== null) {
		const releasePath = `/api/0/organizations/${encodeSegment(orgSlug)}/releases/${encodeSegment(releaseVersion)}/`;
		releaseUrl = `${http.baseUrl}/releases/${encodeSegment(releaseVersion)}/`;
		const releaseResult = await call(releasePath, "sentry release");
		if (releaseResult.kind === "ok") {
			const parsedRelease = sentryReleaseResponseSchema.safeParse(
				releaseResult.body,
			);
			if (parsedRelease.success) {
				const release = parsedRelease.data;
				const lines: string[] = [];
				pushLine(lines, "Release", release.version);
				pushLine(lines, "Created", release.dateCreated);
				pushLine(lines, "Released", release.dateReleased);
				pushLine(lines, "Last event", release.lastEvent);
				const projects = (release.projects ?? [])
					.map((project) => project.slug?.trim() ?? "")
					.filter((slug) => slug.length > 0)
					.slice(0, 20);
				if (projects.length > 0) {
					lines.push(`Projects: ${projects.join(", ")}`);
				}
				if (lines.length === 0) lines.push(`Release: ${release.version}`);
				candidates.push({
					kind: "release",
					title: boundText(`Release ${release.version}`, 200),
					url: releaseUrl,
					excerpt: lines.join("\n"),
					priority: 30,
				});

				const deployPath = `${releasePath}deploys/`;
				const deployResult = await call(deployPath, "sentry deploys");
				if (deployResult.kind === "ok") {
					const parsedDeploys = sentryDeploysResponseSchema.safeParse(
						deployResult.body,
					);
					if (parsedDeploys.success && parsedDeploys.data.length > 0) {
						const newest = [...parsedDeploys.data].sort((left, right) =>
							(right.dateStarted ?? right.dateFinished ?? "").localeCompare(
								left.dateStarted ?? left.dateFinished ?? "",
							),
						)[0];
						const lines: string[] = [];
						pushLine(lines, "Environment", newest.environment);
						pushLine(lines, "Deploy", newest.name);
						pushLine(lines, "Started", newest.dateStarted);
						pushLine(lines, "Finished", newest.dateFinished);
						const deployUrl = safeSentryUrl(newest.url);
						if (deployUrl !== undefined) pushLine(lines, "URL", deployUrl);
						candidates.push({
							kind: "deploy",
							title: boundText(
								`Deploy ${newest.name?.trim() || newest.environment?.trim() || "unknown"} on ${release.version}`,
								200,
							),
							url: releaseUrl,
							excerpt:
								lines.length === 0
									? `Release: ${release.version}`
									: lines.join("\n"),
							priority: 40,
						});
					} else if (parsedDeploys.success) {
						truncated = true;
					} else {
						truncated = true;
					}
				} else {
					truncated = true;
				}
			} else {
				truncated = true;
			}
		} else {
			truncated = true;
		}
	}

	const sorted = [...candidates].sort(
		(left, right) => left.priority - right.priority,
	);
	const items: ContextItem[] = [];
	let usedBytes = 0;

	for (const candidate of sorted) {
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = SENTRY_CONTEXT_MAX_TOTAL_EXCERPT_BYTES - usedBytes;
		if (remaining < 64) {
			truncated = true;
			break;
		}
		const allowedBytes = Math.min(remaining, maxExcerptChars * 4);
		const redacted = redactSentryText(candidate.excerpt, extraSecrets);
		const capped = capSentryExcerpt(redacted, maxExcerptChars, allowedBytes);
		if (capped.text.trim().length === 0) {
			truncated = true;
			continue;
		}
		if (capped.truncated) truncated = true;
		usedBytes += encoder.encode(capped.text).byteLength;
		const url = safeSentryUrl(candidate.url);
		if (url === undefined) {
			truncated = true;
			continue;
		}
		items.push({
			source: "sentry",
			kind: candidate.kind,
			title: boundText(redactSentryText(candidate.title, extraSecrets), 200),
			url,
			excerpt: capped.text,
			fetchedAt,
			trustLevel: "untrusted",
			sha256: await sentrySha256Hex(capped.text),
		});
	}

	const projectComponent =
		issue.project?.id ?? issue.project?.slug ?? "unknown";
	const bundle = {
		incidentFingerprint:
			input.incidentFingerprint ??
			sentryIncidentFingerprint({
				orgSlug,
				projectId: projectComponent,
				issueId,
			}),
		items,
		truncated,
	};
	const validated = contextBundleSchema.safeParse(bundle);
	if (!validated.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"sentry context bundle violated the shared contract",
		);
	}
	return validated.data;
}
