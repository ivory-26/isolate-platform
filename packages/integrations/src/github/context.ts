import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	GIT_SHA_PATTERN,
	isBoundedHttpsUrl,
	isPlatformError,
	isRepoRelativePath,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import type { GitHubTokenProvider } from "./auth";
import { githubIncidentFingerprint, normalizeGitHubRef } from "./incidents";
import { redactSecretsUnbounded } from "./redact";
import {
	DEFAULT_TIMEOUT_MS,
	extractOwnerRepo,
	GITHUB_API_BASE,
	GITHUB_API_VERSION,
	REQUEST_USER_AGENT,
	sha256Hex,
} from "./rest-client";

/**
 * GitHub incident-context reader (wave 13, docs §3.1.4/§4).
 *
 * One repository-scoped, read-only installation token; a fixed query plan per
 * incident (no model-authored queries); every response is parsed with an
 * allowlist and turned into a bounded `ContextItem` whose excerpt is composed
 * from structured fields — never a log body, never a token.
 *
 * Caps are enforced here, not estimated: ≤20 items, ≤2,000 chars per excerpt,
 * ≤16 KiB of excerpt text in total, ≤16 GitHub calls, one page per resource
 * (`per_page` chosen so a `Link: next` is never needed). A partial bundle is
 * valid; `truncated` reports that a cap, a denial or a missing resource dropped
 * evidence.
 *
 * Error mapping: `401`/transport failures → `INTEGRATION_UNAVAILABLE`, `429` →
 * `RATE_LIMITED`, `403` on repository metadata → `POLICY_DENIED` (the token
 * cannot read the repository at all). A `403` on an optional resource (for
 * example branch protection without `administration:read`) only drops that
 * resource and sets `truncated`.
 */

export const GITHUB_CONTEXT_MAX_ITEMS = MAX_CONTEXT_ITEMS;
export const GITHUB_CONTEXT_MAX_EXCERPT_CHARS = MAX_CONTEXT_EXCERPT_CHARS;
export const GITHUB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES =
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES;
/** Bounds rate-limit exposure; a bundle never fans out past this. */
export const GITHUB_CONTEXT_MAX_FETCH_CALLS = 16;
/** A provider response above this is dropped before parsing. */
export const GITHUB_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
/** Files larger than this are not downloaded (contents API `size`). */
const MAX_CONTEXT_FILE_BYTES = 128 * 1024;
const MAX_RUN_ITEMS = 5;
const MAX_JOB_ITEMS = 5;
const MAX_CHECK_SUITE_ITEMS = 3;

const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];
const CONTRIBUTING_PATHS = ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"];
const PR_TEMPLATE_PATHS = [
	".github/PULL_REQUEST_TEMPLATE.md",
	"PULL_REQUEST_TEMPLATE.md",
];
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"cancelled",
]);

export type GitHubContextDependencies = {
	tokenProvider: Pick<GitHubTokenProvider, "getInstallationToken">;
	fetchImpl?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	/** Clamped to the shared contract caps. */
	maxItems?: number;
	maxExcerptChars?: number;
};

export type GitHubContextInput = {
	repositoryFullName: string;
	/** Branch, `refs/heads/<branch>` or commit SHA; defaults to the default branch. */
	ref?: string;
	/** Signal fingerprint this bundle answers; derived when omitted. */
	incidentFingerprint?: string;
};

const repositoryResponseSchema = z.object({
	name: z.string().max(100).optional(),
	full_name: z.string().max(200).optional(),
	default_branch: z.string().max(200).nullable().optional(),
	html_url: z.string().max(512).optional(),
});

const workflowRunSchema = z.object({
	id: z.number().int().positive(),
	name: z.string().max(200).nullable().optional(),
	run_number: z.number().int().positive().optional(),
	run_attempt: z.number().int().positive().optional(),
	event: z.string().max(64).nullable().optional(),
	status: z.string().max(64).nullable().optional(),
	conclusion: z.string().max(64).nullable().optional(),
	head_branch: z.string().max(255).nullable().optional(),
	head_sha: z.string().regex(GIT_SHA_PATTERN).optional(),
	html_url: z.string().max(512),
});

const workflowRunsResponseSchema = z.object({
	workflow_runs: z.array(workflowRunSchema).max(10),
});

const jobStepSchema = z.object({
	name: z.string().max(200),
	status: z.string().max(64).nullable().optional(),
	conclusion: z.string().max(64).nullable().optional(),
});

const jobSchema = z.object({
	id: z.number().int().positive(),
	name: z.string().max(200),
	status: z.string().max(64).nullable().optional(),
	conclusion: z.string().max(64).nullable().optional(),
	html_url: z.string().max(512).nullable().optional(),
	steps: z.array(jobStepSchema).max(100).optional(),
});

const jobsResponseSchema = z.object({
	jobs: z.array(jobSchema).max(100),
});

const checkSuiteSchema = z.object({
	id: z.number().int().positive(),
	status: z.string().max(64).nullable().optional(),
	conclusion: z.string().max(64).nullable().optional(),
	head_branch: z.string().max(255).nullable().optional(),
	head_sha: z.string().max(64).nullable().optional(),
	html_url: z.string().max(512).nullable().optional(),
	app: z
		.object({
			slug: z.string().max(100).nullable().optional(),
			name: z.string().max(100).nullable().optional(),
		})
		.nullable()
		.optional(),
});

const checkSuitesResponseSchema = z.object({
	check_suites: z.array(checkSuiteSchema).max(30),
});

const branchProtectionSchema = z.object({
	required_status_checks: z
		.object({
			strict: z.boolean().optional(),
			contexts: z.array(z.string().max(200)).max(100).optional(),
			checks: z
				.array(z.object({ context: z.string().max(200) }))
				.max(100)
				.optional(),
		})
		.nullable()
		.optional(),
	required_pull_request_reviews: z
		.object({
			required_approving_review_count: z.number().int().optional(),
			dismiss_stale_reviews: z.boolean().optional(),
		})
		.nullable()
		.optional(),
	enforce_admins: z.object({ enabled: z.boolean() }).optional(),
	allow_force_pushes: z.object({ enabled: z.boolean() }).optional(),
	required_conversation_resolution: z
		.object({ enabled: z.boolean() })
		.optional(),
});

const rulesetsResponseSchema = z.array(
	z.object({
		id: z.number().int().positive(),
		name: z.string().max(200),
		target: z.string().max(64).nullable().optional(),
		enforcement: z.string().max(64).nullable().optional(),
	}),
);

const contentFileSchema = z.object({
	type: z.string().max(32),
	path: z.string().max(300),
	size: z.number().int().nonnegative().optional(),
	encoding: z.string().max(16).optional(),
	content: z.string().optional(),
	html_url: z.string().max(512).optional(),
});

const commitSchema = z.object({
	sha: z.string().max(64),
	html_url: z.string().max(512).optional(),
	commit: z.object({
		message: z.string().max(4000),
		author: z
			.object({ name: z.string().max(200).nullable().optional() })
			.nullable()
			.optional(),
	}),
	author: z
		.object({ login: z.string().max(100) })
		.nullable()
		.optional(),
});

const commitsResponseSchema = z.array(commitSchema).max(10);

type CallResult =
	| { kind: "ok"; body: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "skipped" }
	| { kind: "budget" };

type Candidate = {
	kind: string;
	title: string;
	url?: string;
	path?: string;
	excerpt: string;
	priority: number;
};

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function bound(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** Display-only, bounded https URL; anything else is dropped, never fetched. */
function safeUrl(value: string | null | undefined): string | undefined {
	return typeof value === "string" && isBoundedHttpsUrl(value)
		? value
		: undefined;
}

function safePath(value: string): string | undefined {
	return value.length <= 300 && isRepoRelativePath(value) ? value : undefined;
}

function validateInput(input: GitHubContextInput): {
	repositoryFullName: string;
	owner: string;
	repo: string;
	ref: string | null;
} {
	if (
		input === null ||
		typeof input !== "object" ||
		typeof input.repositoryFullName !== "string" ||
		!REPOSITORY_FULL_NAME_PATTERN.test(input.repositoryFullName)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"repositoryFullName must be owner/name",
		);
	}
	const ownerRepo = extractOwnerRepo(input.repositoryFullName);
	if (ownerRepo === null) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"repositoryFullName must be owner/name",
		);
	}
	let ref: string | null = null;
	if (input.ref !== undefined) {
		if (
			typeof input.ref !== "string" ||
			input.ref.length === 0 ||
			input.ref.length > 200 ||
			[...input.ref].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 32 || code === 127;
			})
		) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"ref is not a valid git ref",
			);
		}
		ref = input.ref;
	}
	return {
		repositoryFullName: input.repositoryFullName,
		owner: ownerRepo.owner,
		repo: ownerRepo.repo,
		ref,
	};
}

/**
 * Builds the bounded, cited bundle. Throws only `PlatformError` with a fixed
 * message: no response body, URL, header or token is ever part of an error.
 */
export async function fetchGitHubIncidentContext(
	dependencies: GitHubContextDependencies,
	input: GitHubContextInput,
): Promise<ContextBundle> {
	const { owner, repo, ref } = validateInput(input);
	const fetchImpl =
		dependencies.fetchImpl ?? ((request, init) => fetch(request, init));
	const nowMs = (dependencies.now ?? (() => Date.now()))();
	const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxItems = Math.max(
		1,
		Math.min(dependencies.maxItems ?? MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEMS),
	);
	const maxExcerptChars = Math.max(
		1,
		Math.min(
			dependencies.maxExcerptChars ?? MAX_CONTEXT_EXCERPT_CHARS,
			MAX_CONTEXT_EXCERPT_CHARS,
		),
	);

	// One least-privilege read token; failures are reported without detail.
	let token: string;
	try {
		const installation = await dependencies.tokenProvider.getInstallationToken({
			repositoryFullName: input.repositoryFullName,
			contents: "read",
			actions: "read",
			checks: "read",
			pullRequests: "read",
			administration: "read",
		});
		token =
			typeof installation?.token === "string" ? installation.token.trim() : "";
	} catch (throwable) {
		throw new PlatformError(
			isPlatformError(throwable) ? throwable.code : "INTEGRATION_UNAVAILABLE",
			"github context token could not be minted",
		);
	}
	if (token.length === 0) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable installation token",
		);
	}

	const origin = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const htmlBase = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": REQUEST_USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		Authorization: `Bearer ${token}`,
	};
	const encoder = new TextEncoder();
	let calls = 0;
	let incomplete = false;

	const call = async (url: string, step: string): Promise<CallResult> => {
		if (calls >= GITHUB_CONTEXT_MAX_FETCH_CALLS) {
			incomplete = true;
			return { kind: "budget" };
		}
		calls += 1;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "GET",
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new PlatformError(
				"INTEGRATION_UNAVAILABLE",
				`${step} failed to reach github`,
			);
		}
		if (response.status === 429) {
			throw new PlatformError(
				"RATE_LIMITED",
				`${step} was rate limited by github`,
			);
		}
		if (response.status === 401) {
			throw new PlatformError(
				"INTEGRATION_UNAVAILABLE",
				`${step} was rejected by github (status 401)`,
			);
		}
		if (response.status === 404) return { kind: "missing" };
		if (response.status === 403) {
			incomplete = true;
			return { kind: "denied" };
		}
		if (!response.ok) {
			incomplete = true;
			return { kind: "skipped" };
		}
		const declared = Number(response.headers.get("content-length"));
		if (
			Number.isFinite(declared) &&
			declared > GITHUB_CONTEXT_MAX_RESPONSE_BYTES
		) {
			incomplete = true;
			return { kind: "skipped" };
		}
		let text: string;
		try {
			text = await response.text();
		} catch {
			incomplete = true;
			return { kind: "skipped" };
		}
		if (encoder.encode(text).byteLength > GITHUB_CONTEXT_MAX_RESPONSE_BYTES) {
			incomplete = true;
			return { kind: "skipped" };
		}
		return { kind: "ok", body: parseJson(text) };
	};

	// 1. Repository metadata: default branch, canonical html URL. A 403 here
	//    means the token cannot read the repository at all.
	const repoResult = await call(origin, "github repository metadata");
	if (repoResult.kind === "denied") {
		throw new PlatformError(
			"POLICY_DENIED",
			"github context access was denied (status 403)",
		);
	}
	const parsedRepo =
		repoResult.kind === "ok"
			? repositoryResponseSchema.safeParse(repoResult.body)
			: null;
	const defaultBranch =
		parsedRepo?.success === true
			? nonEmpty(parsedRepo.data.default_branch)
			: null;
	const requestedRef = ref === null ? null : normalizeGitHubRef(ref);
	const branch = requestedRef ?? defaultBranch ?? "main";
	if (repoResult.kind !== "ok") incomplete = true;

	const candidates: Candidate[] = [];

	// 2. Latest five runs for the ref.
	const runFilter = !GIT_SHA_PATTERN.test(branch)
		? `&branch=${encodeURIComponent(branch)}`
		: "";
	const runsResult = await call(
		`${origin}/actions/runs?per_page=${MAX_RUN_ITEMS}${runFilter}`,
		"github workflow runs",
	);
	let failingRun: z.output<typeof workflowRunSchema> | null = null;
	if (runsResult.kind === "ok") {
		const parsed = workflowRunsResponseSchema.safeParse(runsResult.body);
		if (parsed.success) {
			const runs = parsed.data.workflow_runs.slice(0, MAX_RUN_ITEMS);
			failingRun =
				runs.find((run) =>
					FAILING_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()),
				) ?? null;
			runs.forEach((run, index) => {
				const conclusion = nonEmpty(run.conclusion) ?? "unknown";
				const status = nonEmpty(run.status) ?? "unknown";
				const runBranch = nonEmpty(run.head_branch) ?? branch;
				candidates.push({
					kind: "workflow_run",
					title: bound(
						`Workflow run ${run.name ?? "workflow"} #${run.run_number ?? run.id} (${conclusion})`,
						200,
					),
					url: run.html_url,
					excerpt: [
						`Workflow: ${run.name ?? "workflow"}`,
						`Run: ${run.id}${run.run_attempt === undefined ? "" : ` (attempt ${run.run_attempt})`}`,
						`Event: ${run.event ?? "unknown"}`,
						`Status: ${status}`,
						`Conclusion: ${conclusion}`,
						`Branch: ${runBranch}`,
						`Commit: ${run.head_sha ?? "unknown"}`,
					].join("\n"),
					priority:
						FAILING_CONCLUSIONS.has(conclusion.toLowerCase()) &&
						failingRun?.id === run.id
							? 10
							: 60 + index,
				});
			});
		} else {
			incomplete = true;
		}
	}

	// 3. Job names and failed step names of the latest failing run (no logs).
	if (failingRun !== null) {
		const jobsResult = await call(
			`${origin}/actions/runs/${failingRun.id}/jobs?filter=latest&per_page=50`,
			"github workflow jobs",
		);
		if (jobsResult.kind === "ok") {
			const parsed = jobsResponseSchema.safeParse(jobsResult.body);
			if (parsed.success) {
				const jobs = parsed.data.jobs;
				const failedJobs = jobs.filter((job) =>
					FAILING_CONCLUSIONS.has((job.conclusion ?? "").toLowerCase()),
				);
				const selected = (failedJobs.length > 0 ? failedJobs : jobs).slice(
					0,
					MAX_JOB_ITEMS,
				);
				selected.forEach((job, index) => {
					const failedSteps = (job.steps ?? [])
						.filter((step) =>
							FAILING_CONCLUSIONS.has((step.conclusion ?? "").toLowerCase()),
						)
						.map((step) => step.name);
					candidates.push({
						kind: "check_run",
						title: bound(
							`Job ${job.name} (${nonEmpty(job.conclusion) ?? nonEmpty(job.status) ?? "unknown"})`,
							200,
						),
						url: nonEmpty(job.html_url) ?? failingRun.html_url,
						excerpt: [
							`Job: ${job.name}`,
							`Status: ${job.status ?? "unknown"}`,
							`Conclusion: ${job.conclusion ?? "unknown"}`,
							`Run: ${failingRun.id}`,
							failedSteps.length === 0
								? "Failed steps: none reported"
								: `Failed steps: ${failedSteps.join(", ")}`,
						].join("\n"),
						priority: 20 + index,
					});
				});
			} else {
				incomplete = true;
			}
		}
	}

	// 4. Check suites for the ref (or the failing commit).
	const suiteRef = failingRun?.head_sha ?? branch;
	const suitesResult = await call(
		`${origin}/commits/${encodeURIComponent(suiteRef)}/check-suites?per_page=10`,
		"github check suites",
	);
	if (suitesResult.kind === "ok") {
		const parsed = checkSuitesResponseSchema.safeParse(suitesResult.body);
		if (parsed.success) {
			const suites = [...parsed.data.check_suites]
				.filter(
					(suite) =>
						FAILING_CONCLUSIONS.has((suite.conclusion ?? "").toLowerCase()) ||
						(suite.conclusion ?? null) === null,
				)
				.sort((left, right) => {
					const leftFailing = FAILING_CONCLUSIONS.has(
						(left.conclusion ?? "").toLowerCase(),
					)
						? 0
						: 1;
					const rightFailing = FAILING_CONCLUSIONS.has(
						(right.conclusion ?? "").toLowerCase(),
					)
						? 0
						: 1;
					return leftFailing - rightFailing;
				})
				.slice(0, MAX_CHECK_SUITE_ITEMS);
			suites.forEach((suite, index) => {
				const app = nonEmpty(suite.app?.slug) ?? nonEmpty(suite.app?.name);
				candidates.push({
					kind: "check_suite",
					title: bound(
						`Check suite ${app ?? suite.id} (${nonEmpty(suite.conclusion) ?? nonEmpty(suite.status) ?? "unknown"})`,
						200,
					),
					url: nonEmpty(suite.html_url) ?? failingRun?.html_url,
					excerpt: [
						`Check suite: ${suite.id}`,
						`App: ${app ?? "unknown"}`,
						`Status: ${suite.status ?? "unknown"}`,
						`Conclusion: ${suite.conclusion ?? "unknown"}`,
						`Branch: ${suite.head_branch ?? branch}`,
						`Commit: ${suite.head_sha ?? "unknown"}`,
					].join("\n"),
					priority: 30 + index,
				});
			});
		} else {
			incomplete = true;
		}
	}

	// 5. Branch protection and rulesets (administration:read). 404 is normal:
	//    the branch is unprotected / no rulesets exist.
	const protectionResult = await call(
		`${origin}/branches/${encodePath(branch)}/protection`,
		"github branch protection",
	);
	if (protectionResult.kind === "ok") {
		const parsed = branchProtectionSchema.safeParse(protectionResult.body);
		if (parsed.success) {
			const protection = parsed.data;
			const contexts = [
				...(protection.required_status_checks?.contexts ?? []),
				...(protection.required_status_checks?.checks ?? []).map(
					(check) => check.context,
				),
			];
			candidates.push({
				kind: "branch_protection",
				title: bound(`Branch protection: ${branch}`, 200),
				url: `${htmlBase}/settings/branches`,
				excerpt: [
					`Branch: ${branch}`,
					`Strict status checks: ${protection.required_status_checks?.strict === true ? "yes" : "no"}`,
					`Required checks: ${contexts.length === 0 ? "none" : contexts.join(", ")}`,
					`Required approvals: ${protection.required_pull_request_reviews?.required_approving_review_count ?? 0}`,
					`Dismiss stale reviews: ${protection.required_pull_request_reviews?.dismiss_stale_reviews === true ? "yes" : "no"}`,
					`Enforce admins: ${protection.enforce_admins?.enabled === true ? "yes" : "no"}`,
					`Allow force pushes: ${protection.allow_force_pushes?.enabled === true ? "yes" : "no"}`,
					`Require conversation resolution: ${protection.required_conversation_resolution?.enabled === true ? "yes" : "no"}`,
				].join("\n"),
				priority: 40,
			});
		} else {
			incomplete = true;
		}
	}

	const rulesetsResult = await call(
		`${origin}/rulesets?per_page=10`,
		"github rulesets",
	);
	if (rulesetsResult.kind === "ok") {
		const parsed = rulesetsResponseSchema.safeParse(rulesetsResult.body);
		if (parsed.success && parsed.data.length > 0) {
			candidates.push({
				kind: "ruleset",
				title: bound(`Repository rulesets (${parsed.data.length})`, 200),
				url: `${htmlBase}/settings/rules`,
				excerpt: parsed.data
					.slice(0, 10)
					.map(
						(ruleset) =>
							`${ruleset.name} — target ${ruleset.target ?? "unknown"} — ${ruleset.enforcement ?? "unknown"}`,
					)
					.join("\n"),
				priority: 45,
			});
		}
	}

	// 6. Repository conventions: first existing path wins.
	const fetchFirstFile = async (
		paths: readonly string[],
		kind: string,
		priority: number,
	): Promise<void> => {
		for (const path of paths) {
			const result = await call(
				`${origin}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
				`github ${kind}`,
			);
			if (result.kind === "budget") return;
			if (result.kind !== "ok") continue;
			const parsed = contentFileSchema.safeParse(result.body);
			if (
				!parsed.success ||
				parsed.data.type !== "file" ||
				parsed.data.encoding !== "base64" ||
				typeof parsed.data.content !== "string"
			) {
				incomplete = true;
				return;
			}
			if (
				parsed.data.size !== undefined &&
				parsed.data.size > MAX_CONTEXT_FILE_BYTES
			) {
				incomplete = true;
				return;
			}
			let decoded: string;
			try {
				decoded = Buffer.from(
					parsed.data.content.replace(/\s+/g, ""),
					"base64",
				).toString("utf8");
			} catch {
				incomplete = true;
				return;
			}
			candidates.push({
				kind,
				title: bound(`${kind.replace(/_/g, " ")}: ${parsed.data.path}`, 200),
				url:
					nonEmpty(parsed.data.html_url) ??
					`${htmlBase}/blob/${branch}/${path}`,
				path: parsed.data.path,
				excerpt: decoded,
				priority,
			});
			return;
		}
	};

	await fetchFirstFile(CODEOWNERS_PATHS, "codeowners", 50);
	await fetchFirstFile(CONTRIBUTING_PATHS, "contributing", 70);
	await fetchFirstFile(PR_TEMPLATE_PATHS, "pr_template", 75);

	// 7. Recent commits on the ref.
	const commitsResult = await call(
		`${origin}/commits?per_page=5&sha=${encodeURIComponent(branch)}`,
		"github commits",
	);
	if (commitsResult.kind === "ok") {
		const parsed = commitsResponseSchema.safeParse(commitsResult.body);
		if (parsed.success && parsed.data.length > 0) {
			candidates.push({
				kind: "commit",
				title: bound(`Recent commits on ${branch}`, 200),
				url: `${htmlBase}/commits`,
				excerpt: parsed.data
					.slice(0, 5)
					.map((commit) => {
						const subject =
							commit.commit.message.split(/\r?\n/, 1)[0]?.trim() ?? "";
						const author = nonEmpty(commit.author?.login) ?? "unknown";
						return `${commit.sha.slice(0, 7)} ${subject} — ${author}`;
					})
					.join("\n"),
				priority: 65,
			});
		} else if (parsed.success) {
			incomplete = true;
		}
	}

	// 8. Rank, then allocate the excerpt budget. Lower priority number wins.
	const sorted = [...candidates].sort(
		(left, right) => left.priority - right.priority,
	);
	const fetchedAt = new Date(nowMs).toISOString();
	const items: ContextItem[] = [];
	let usedBytes = 0;
	let truncated = incomplete;

	for (const candidate of sorted) {
		if (items.length >= maxItems) {
			truncated = true;
			break;
		}
		const remaining = MAX_CONTEXT_TOTAL_EXCERPT_BYTES - usedBytes;
		if (remaining < 64) {
			truncated = true;
			break;
		}
		const allowedBytes = Math.min(remaining, maxExcerptChars * 4);
		const redacted = redactSecretsUnbounded(candidate.excerpt, [token]);
		const capped = capExcerpt(redacted, maxExcerptChars, allowedBytes);
		if (capped.text.trim().length === 0) continue;
		if (capped.truncated) truncated = true;
		const excerptBytes = encoder.encode(capped.text).byteLength;
		const url = safeUrl(candidate.url);
		const path =
			candidate.path === undefined ? undefined : safePath(candidate.path);
		const item: ContextItem = {
			source: "github",
			kind: candidate.kind,
			title: bound(redactSecretsUnbounded(candidate.title, [token]), 200),
			...(url === undefined ? {} : { url }),
			...(path === undefined ? {} : { path }),
			excerpt: capped.text,
			fetchedAt,
			trustLevel: "untrusted",
			sha256: await sha256Hex(capped.text),
		};
		items.push(item);
		usedBytes += excerptBytes;
	}

	const fingerprint =
		input.incidentFingerprint ??
		githubIncidentFingerprint({
			repositoryFullName: input.repositoryFullName,
			name: "context",
			headBranch: branch,
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
			"github context bundle violated the shared contract",
		);
	}
	return validated.data;
}

/**
 * Redact-then-truncate. The excerpt never exceeds the character cap or the
 * byte budget; the returned `truncated` flag drives `ContextBundle.truncated`.
 */
export function capExcerpt(
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
