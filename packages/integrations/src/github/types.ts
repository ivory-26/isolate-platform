import type { OrganizationId, PullRequestRecord } from "@isolate/shared";
import type { GitHubTokenProvider } from "./auth";

/**
 * GitHub connector contracts (architecture §3/§7). Credentials are resolved
 * server-side through a scoped broker and are never logged, never thrown, and
 * never sent to the model.
 */
export type PullRequestSpec = {
	repositoryFullName: string; // "org/repo"
	headBranch: string;
	baseBranch: string;
	title: string;
	body: string;
	// Set only when an approval decision exists for this exact payload.
	approvalId?: string;
	approvalPayloadSha256?: string;
};

export type PullRequestInfo = {
	number: number;
	url: string;
	headBranch: string;
};

/** Failure codes a PR-creation call can return through its Result. */
export type PullRequestFailureCode =
	| "VALIDATION_FAILED"
	| "APPROVAL_REQUIRED"
	| "INTEGRATION_UNAVAILABLE"
	| "POLICY_DENIED"
	| "NOT_FOUND"
	| "RATE_LIMITED";

export type PullRequestFailure = {
	ok: false;
	code: PullRequestFailureCode;
	/**
	 * Sanitized, credential-free human summary. Built through
	 * `redactSecrets`; never contains raw provider bodies, stacks, or tokens.
	 */
	message?: string;
};

export interface PullRequestCreator {
	createPullRequest(
		spec: PullRequestSpec,
	): Promise<{ ok: true; pr: PullRequestInfo } | PullRequestFailure>;
}

export type GitHubCredentials = {
	// Scoped, short-lived app installation token; never a PAT in platform code.
	installationToken: string;
	passwordless: true;
};

/**
 * AuditRepository-shaped dependency (§8: every privileged call site is
 * audited). Structurally compatible with the trusted-code
 * `AuditRepository.append` contract in `@isolate/db`: an implementation of the
 * repository interface satisfies this interface. Callers of this module
 * construct the entry; the sink only persists it.
 */
export interface PrCreationAuditSink {
	append(input: {
		organizationId: OrganizationId;
		actorId: string | null;
		actorKind: "user" | "agent" | "worker" | "system";
		action: "pr.create";
		target: string;
		details: Record<string, unknown>;
		// biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps sync and async sinks (plus the nullable AuditRepository shape) assignable without forcing a return
	}): void | Promise<unknown>;
}

/** Caller identity recorded on each audit entry; supplied by trusted code. */
export type PrCreationActorContext = {
	organizationId: OrganizationId;
	actorId: string | null;
	actorKind: "user" | "agent" | "worker" | "system";
};

/**
 * Trusted-code sensitivity classifier (§8: policy enforced in trusted code,
 * never in model instructions). The default/disabled form denies everything:
 * PR creation is approval-gated unless a policy explicitly marks it low-risk.
 */
export type PrSensitivityPolicy = (spec: PullRequestSpec) => boolean;

export type PrCreationOutcome =
	| { kind: "SUCCEEDED" }
	| { kind: "FAILED"; code: PullRequestFailureCode }
	| { kind: "BLOCKED"; code: PullRequestFailureCode };

/** Minimal token seam; the real broker is `createGitHubAppTokenProvider`. */
export type PullRequestTokenProvider = Pick<
	GitHubTokenProvider,
	"getInstallationToken"
>;

/**
 * Dependencies of `createPullRequestForTask` (wave 8). Exactly one token is
 * minted per call, scoped to the target repository with `contents` and
 * `pull_requests` write; it never leaves this layer except in the
 * Authorization header.
 */
export type PullRequestCreationDependencies = {
	tokenProvider: PullRequestTokenProvider;
	audit: PrCreationAuditSink;
	/** Caller identity recorded verbatim on every audit entry. */
	actor: PrCreationActorContext;
	/** Injectable for tests; defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Clock used to reject an already-expired minted token. */
	now?: () => number;
	/** Per-request deadline; bounded by default, never unbounded. */
	timeoutMs?: number;
};

/**
 * Approval-bound result: `pullRequest` is exactly the shared
 * `PullRequestRecord` shape, `created` is false when an already-open PR for the
 * head branch was returned instead of a new one.
 */
export type PullRequestCreationResult =
	| { ok: true; pullRequest: PullRequestRecord; created: boolean }
	| PullRequestFailure;
