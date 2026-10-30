import { createHash } from "node:crypto";
import {
	GIT_SHA_PATTERN,
	type IncidentLink,
	type IncidentSeverity,
	type IncidentSignal,
	incidentSignalSchema,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINKS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactSecrets } from "./redact";

/**
 * GitHub incident normalization (wave 13, docs §2.1/§3.1).
 *
 * A failed `workflow_run` or `check_suite` delivery becomes one bounded
 * `IncidentSignal`. Everything is composed from allowlisted fields — never from
 * logs, annotations or free-form payload text — and provider strings pass
 * through `redactSecrets` before they reach a signal.
 *
 * The fingerprint is source-stable (`github:<owner/repo>:<name>:<branch>`), so
 * a GitHub redelivery or a repeated failure of the same workflow on the same
 * branch dedupes; the delivery id is only kept for traceability.
 */

export const GITHUB_WORKFLOW_INCIDENT_KIND = "workflow_failed";
export const GITHUB_CHECK_INCIDENT_KIND = "check_failed";
export const GITHUB_PRODUCTION_BRANCHES = [
	"main",
	"master",
	"production",
	"prod",
] as const;

const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HTTPS_URL_PATTERN = /^https:\/\//;
const TRIGGERING_WORKFLOW_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"cancelled",
]);
const TRIGGERING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set(["failure"]);

const repositorySchema = z.object({
	name: z.string().min(1).max(100),
	full_name: z.string().max(200).regex(REPOSITORY_FULL_NAME_PATTERN).optional(),
	default_branch: z.string().max(200).nullable().optional(),
	html_url: z.string().max(512).regex(HTTPS_URL_PATTERN).optional(),
	owner: z.object({ login: z.string().max(100).optional() }).optional(),
});

const workflowRunPayloadSchema = z.object({
	action: z.string().max(64),
	repository: repositorySchema,
	environment: z.object({ name: z.string().max(100) }).optional(),
	deployment_environment: z.string().max(100).nullable().optional(),
	workflow_run: z.object({
		id: z.number().int().positive(),
		name: z.string().max(200).nullable().optional(),
		head_branch: z.string().max(255).nullable().optional(),
		head_sha: z.string().regex(GIT_SHA_PATTERN),
		run_number: z.number().int().positive().optional(),
		run_attempt: z.number().int().positive().optional(),
		event: z.string().max(64).optional(),
		status: z.string().max(64).optional(),
		conclusion: z.string().max(64).nullable().optional(),
		html_url: z.string().max(512).regex(HTTPS_URL_PATTERN),
		environment: z.object({ name: z.string().max(100) }).optional(),
		deployment_environment: z.string().max(100).nullable().optional(),
	}),
});

const checkSuitePayloadSchema = z.object({
	action: z.string().max(64),
	repository: repositorySchema,
	check_suite: z
		.object({
			id: z.number().int().positive(),
			head_branch: z.string().max(255).nullable().optional(),
			head_sha: z.string().regex(GIT_SHA_PATTERN),
			status: z.string().max(64).optional(),
			conclusion: z.string().max(64).nullable().optional(),
			html_url: z
				.string()
				.max(512)
				.regex(HTTPS_URL_PATTERN)
				.nullable()
				.optional(),
			app: z
				.object({
					slug: z.string().max(100).nullable().optional(),
					name: z.string().max(100).nullable().optional(),
				})
				.nullable()
				.optional(),
		})
		.optional(),
});

/** One verified delivery: `x-github-event` plus the parsed JSON body. */
export type GitHubIncidentEvent = {
	readonly name: string;
	readonly payload: unknown;
};

/** Delivery identity from `x-github-delivery`; not part of the fingerprint. */
export type GitHubIncidentDelivery = {
	readonly id: string;
	/** Receipt time from trusted code (ISO-8601); defaults to wall clock. */
	readonly receivedAt?: string;
};

/** Bounded to the signal caps, ellipsis included in the cap. */
function boundText(value: string, maxChars: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, maxChars - 1)}…`;
}

/** Multi-line variant: preserves the field-per-line summary layout. */
function boundMultiline(value: string, maxChars: number): string {
	const normalized = value.trim();
	return normalized.length <= maxChars
		? normalized
		: `${normalized.slice(0, maxChars - 1)}…`;
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** Accepts `main`, `refs/heads/main`; returns the branch component. */
export function normalizeGitHubRef(
	ref: string | null | undefined,
): string | null {
	const value = nonEmpty(ref);
	if (value === null) return null;
	return value.startsWith("refs/heads/") ? value.slice(11) : value;
}

export function isGitHubProductionBranchName(
	branch: string | null | undefined,
): boolean {
	const name = normalizeGitHubRef(branch);
	return (
		name !== null &&
		(GITHUB_PRODUCTION_BRANCHES as readonly string[]).includes(name)
	);
}

/**
 * The exact severity rule (wave 13 decisions).
 *
 * `critical` iff the payload names a `production` environment, **or** the
 * triggering ref is the repository default branch and that default branch is a
 * production branch name (`main`, `master`, `production`, `prod`). Everything
 * else — feature branches, forks, release branches, unknown default branch —
 * is `high`. Never `medium`/`low`: these events are the trigger surface.
 */
export function githubIncidentSeverity(input: {
	defaultBranch?: string | null;
	ref?: string | null;
	environment?: string | null;
}): Extract<IncidentSeverity, "critical" | "high"> {
	const environment = nonEmpty(input.environment)?.toLowerCase();
	if (environment === "production") return "critical";

	const defaultBranch = normalizeGitHubRef(input.defaultBranch);
	if (defaultBranch === null) return "high";
	if (!isGitHubProductionBranchName(defaultBranch)) return "high";

	const ref = normalizeGitHubRef(input.ref);
	return ref !== null && ref === defaultBranch ? "critical" : "high";
}

function boundedComponent(value: string, maxChars: number): string {
	let sanitized = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		sanitized +=
			code <= 31 || code === 127 || character === ":" ? "_" : character;
	}
	sanitized = sanitized.trim();
	return sanitized.length <= maxChars
		? sanitized
		: sanitized.slice(0, maxChars);
}

/**
 * Source-stable dedupe key: `github:<owner/repo>:<workflow|check name>:<branch>`.
 *
 * Re-deliveries of one event carry a new delivery id but the same fingerprint.
 * Long components are truncated and suffixed with a digest of the full value,
 * so two prefixes cannot silently merge two different incidents.
 */
export function githubIncidentFingerprint(input: {
	repositoryFullName: string;
	name: string;
	headBranch: string;
}): string {
	const repository = boundedComponent(
		redactSecrets(input.repositoryFullName),
		100,
	);
	const name = boundedComponent(redactSecrets(input.name), 100);
	const branch = boundedComponent(redactSecrets(input.headBranch), 100);
	const full = `github:${repository}:${name}:${branch}`;
	if (full.length <= MAX_INCIDENT_FINGERPRINT_CHARS) return full;

	const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
	return `github:${repository.slice(0, 52)}:${name.slice(0, 28)}:${branch.slice(
		0,
		20,
	)}~${digest}`;
}

function repositoryFullNameOf(
	repository: z.output<typeof repositorySchema>,
): string | null {
	if (repository.full_name !== undefined) return repository.full_name;
	const owner = nonEmpty(repository.owner?.login);
	return owner === null ? null : `${owner}/${repository.name}`;
}

function boundedLink(label: string, url: string | null | undefined) {
	if (url === null || url === undefined || !isBoundedHttpsUrl(url)) return null;
	return { label: boundText(label, 120), url };
}

function boundedLinks(
	candidates: ReadonlyArray<{ label: string; url: string | null | undefined }>,
): IncidentLink[] {
	const seen = new Set<string>();
	const links: IncidentLink[] = [];
	for (const candidate of candidates) {
		const link = boundedLink(candidate.label, candidate.url);
		if (link === null || seen.has(link.url)) continue;
		seen.add(link.url);
		links.push(link);
		if (links.length >= MAX_INCIDENT_LINKS) break;
	}
	return links;
}

function receivedAtOf(delivery: GitHubIncidentDelivery, fallbackMs: number) {
	const candidate = delivery.receivedAt;
	if (typeof candidate === "string") {
		const parsed = z.iso.datetime({ offset: true }).safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return new Date(fallbackMs).toISOString();
}

function safeProviderText(value: string | null | undefined): string {
	return value === null || value === undefined
		? ""
		: redactSecrets(value.replace(/[\r\n]+/g, " ").trim());
}

/**
 * Normalizes one verified delivery, or returns `null` when the event is not a
 * triggering incident (unsupported event, wrong action, green conclusion).
 *
 * Pure: no clock, no network, no credential. `receivedAt` is taken from the
 * delivery (trusted caller) and only defaults to `Date.now()` when absent.
 */
export function normalizeGitHubIncident(
	event: GitHubIncidentEvent,
	delivery: GitHubIncidentDelivery,
): IncidentSignal | null {
	if (
		event === null ||
		typeof event !== "object" ||
		typeof event.name !== "string" ||
		typeof delivery !== "object" ||
		typeof delivery.id !== "string"
	) {
		return null;
	}
	const receivedAt = receivedAtOf(delivery, Date.now());

	if (event.name === "workflow_run") {
		const parsed = workflowRunPayloadSchema.safeParse(event.payload);
		if (!parsed.success) return null;
		const { action, repository, workflow_run: run } = parsed.data;
		if (action !== "completed") return null;
		const conclusion = nonEmpty(run.conclusion)?.toLowerCase();
		if (
			conclusion === null ||
			conclusion === undefined ||
			!TRIGGERING_WORKFLOW_CONCLUSIONS.has(conclusion)
		) {
			return null;
		}
		const repositoryFullName = repositoryFullNameOf(repository);
		if (repositoryFullName === null) return null;

		const workflowName = nonEmpty(run.name) ?? "workflow";
		const headBranch = nonEmpty(run.head_branch) ?? run.head_sha;
		const environment =
			nonEmpty(run.environment?.name) ??
			nonEmpty(run.deployment_environment) ??
			nonEmpty(parsed.data.environment?.name) ??
			nonEmpty(parsed.data.deployment_environment);
		const severity = githubIncidentSeverity({
			defaultBranch: repository.default_branch,
			ref: run.head_branch ?? headBranch,
			environment,
		});
		const outcome =
			conclusion === "timed_out"
				? "timed out"
				: conclusion === "cancelled"
					? "was cancelled"
					: "failed";
		const title = boundText(
			`Workflow "${safeProviderText(workflowName)}" ${outcome} on ${safeProviderText(headBranch)} (${safeProviderText(repositoryFullName)})`,
			MAX_INCIDENT_TITLE_CHARS,
		);
		const summary = boundMultiline(
			[
				"Event: workflow_run (completed)",
				`Repository: ${safeProviderText(repositoryFullName)}`,
				`Workflow: ${safeProviderText(workflowName)}`,
				`Conclusion: ${conclusion}`,
				`Branch: ${safeProviderText(headBranch)}`,
				`Commit: ${run.head_sha}`,
				`Run: ${run.id}${run.run_attempt === undefined ? "" : ` (attempt ${run.run_attempt})`}`,
				`Delivery: ${safeProviderText(delivery.id)}`,
			].join("\n"),
			MAX_INCIDENT_SUMMARY_CHARS,
		);
		const signal = {
			source: "github" as const,
			kind: GITHUB_WORKFLOW_INCIDENT_KIND,
			severity,
			service: safeProviderText(repository.name).slice(0, 128),
			fingerprint: githubIncidentFingerprint({
				repositoryFullName,
				name: workflowName,
				headBranch,
			}),
			title,
			summary,
			links: boundedLinks([
				{ label: "Workflow run", url: run.html_url },
				{ label: "Repository", url: repository.html_url },
			]),
			receivedAt,
		};
		const validated = incidentSignalSchema.safeParse(signal);
		return validated.success ? validated.data : null;
	}

	if (event.name === "check_suite") {
		const parsed = checkSuitePayloadSchema.safeParse(event.payload);
		if (!parsed.success) return null;
		const { action, repository, check_suite: suite } = parsed.data;
		if (action !== "completed" || suite === undefined) return null;
		const conclusion = nonEmpty(suite.conclusion)?.toLowerCase();
		if (conclusion === null || conclusion === undefined) return null;
		if (!TRIGGERING_CHECK_CONCLUSIONS.has(conclusion)) return null;
		const repositoryFullName = repositoryFullNameOf(repository);
		if (repositoryFullName === null) return null;

		const appName =
			nonEmpty(suite.app?.slug) ?? nonEmpty(suite.app?.name) ?? "check";
		const headBranch = nonEmpty(suite.head_branch) ?? suite.head_sha;
		const severity = githubIncidentSeverity({
			defaultBranch: repository.default_branch,
			ref: suite.head_branch ?? headBranch,
		});
		const title = boundText(
			`Check suite "${safeProviderText(appName)}" failed on ${safeProviderText(headBranch)} (${safeProviderText(repositoryFullName)})`,
			MAX_INCIDENT_TITLE_CHARS,
		);
		const summary = boundMultiline(
			[
				"Event: check_suite (completed)",
				`Repository: ${safeProviderText(repositoryFullName)}`,
				`Check suite: ${safeProviderText(appName)}`,
				`Conclusion: ${conclusion}`,
				`Status: ${safeProviderText(suite.status) || "completed"}`,
				`Branch: ${safeProviderText(headBranch)}`,
				`Commit: ${suite.head_sha}`,
				`Suite: ${suite.id}`,
				`Delivery: ${safeProviderText(delivery.id)}`,
			].join("\n"),
			MAX_INCIDENT_SUMMARY_CHARS,
		);
		const signal = {
			source: "github" as const,
			kind: GITHUB_CHECK_INCIDENT_KIND,
			severity,
			service: safeProviderText(repository.name).slice(0, 128),
			fingerprint: githubIncidentFingerprint({
				repositoryFullName,
				name: appName,
				headBranch,
			}),
			title,
			summary,
			links: boundedLinks([
				{ label: "Check suite", url: suite.html_url ?? undefined },
				{ label: "Repository", url: repository.html_url },
			]),
			receivedAt,
		};
		const validated = incidentSignalSchema.safeParse(signal);
		return validated.success ? validated.data : null;
	}

	return null;
}
