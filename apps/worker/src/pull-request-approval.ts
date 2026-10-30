import { GIT_SHA_PATTERN, PlatformError } from "@isolate/shared";
import { z } from "zod";

/**
 * Wave-8 pull-request approval contracts.
 *
 * The worker is the only writer of the `github.create_pull_request` approval
 * and the only reader of the `approval.requested` event that carries its
 * payload. The payload is exactly the canonical approval binding
 * `{repositoryFullName, headBranch, baseBranch, headSha}`; title/body are not
 * part of the approval and can be rebuilt deterministically by the PR job.
 *
 * Everything here is bounded: provider full names and branch names are short
 * identifiers, a git SHA is 40–64 hex characters, and the event schema is
 * strict so a malformed or widened event is treated as absent (no PR).
 */

export const PULL_REQUEST_APPROVAL_ACTION = "github.create_pull_request";

/** GitHub `owner/name`; identical to the integrations input contract. */
const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_NAME_PATTERN = /^\S{1,255}$/;
const SHA256_HEX_PATTERN = /^[a-fA-F0-9]{64}$/;

export const pullRequestTargetSchema = z
	.object({
		repositoryFullName: z
			.string()
			.min(3)
			.max(200)
			.regex(
				REPOSITORY_FULL_NAME_PATTERN,
				"repositoryFullName must be owner/repo",
			),
		headBranch: z.string().min(1).max(255).regex(BRANCH_NAME_PATTERN),
		baseBranch: z.string().min(1).max(255).regex(BRANCH_NAME_PATTERN),
		headSha: z.string().regex(GIT_SHA_PATTERN),
	})
	.strict();

export type PullRequestTarget = z.infer<typeof pullRequestTargetSchema>;

/**
 * Stored `approval.requested` event data for the PR gate. Extra fields are
 * accepted only from this closed set; anything else makes the event
 * unreadable, which fails closed (the job creates no pull request).
 */
export const pullRequestApprovalEventDataSchema = z
	.object({
		action: z.literal(PULL_REQUEST_APPROVAL_ACTION),
		payload: pullRequestTargetSchema,
		payloadSha256: z.string().regex(SHA256_HEX_PATTERN).optional(),
		approvalId: z.string().min(1).max(128).optional(),
		expiresAt: z.string().min(1).max(64).optional(),
	})
	.strict();

export type PullRequestApprovalEventData = z.infer<
	typeof pullRequestApprovalEventDataSchema
>;

/** Returns the validated target, or `null` when the event is not a PR approval. */
export function parsePullRequestApprovalEventData(
	data: unknown,
): PullRequestTarget | null {
	const parsed = pullRequestApprovalEventDataSchema.safeParse(data);
	if (!parsed.success) return null;
	if (parsed.data.action !== PULL_REQUEST_APPROVAL_ACTION) return null;
	return parsed.data.payload;
}

/**
 * `owner/name` from the task's clean https GitHub URL. Mirrors the wave-7
 * parser: only `https://github.com/owner/name(.git)` with no userinfo, query
 * or fragment is accepted, so a credential-bearing URL can never become part
 * of an approval payload.
 */
export function parseGitHubFullName(repoUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(repoUrl);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "invalid repository URL");
	}
	const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
		parsed.pathname,
	);
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "github.com" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		match === null
	) {
		throw new PlatformError("VALIDATION_FAILED", "invalid repository URL");
	}
	return `${match[1]}/${match[2]}`;
}

/**
 * Builds the approval-bound PR target from task context. Returns `null` when
 * no target is available (non-GitHub URL, malformed branch, no head SHA), so
 * the caller stops at `review_ready` instead of pausing on an unusable gate.
 */
export function buildPullRequestTarget(input: {
	repoUrl: string;
	baseBranch: string;
	headBranch: string;
	headSha: string;
}): PullRequestTarget | null {
	let repositoryFullName: string;
	try {
		repositoryFullName = parseGitHubFullName(input.repoUrl);
	} catch {
		return null;
	}
	const parsed = pullRequestTargetSchema.safeParse({
		repositoryFullName,
		headBranch: input.headBranch,
		baseBranch: input.baseBranch,
		headSha: input.headSha,
	});
	return parsed.success ? parsed.data : null;
}
