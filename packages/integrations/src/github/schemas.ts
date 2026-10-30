import { GIT_SHA_PATTERN } from "@isolate/shared";
import { z } from "zod";

/**
 * Validation boundary for everything the connector sends to or receives from
 * GitHub. Provider responses are untrusted input (§7): parsed, scoped, never
 * passed through verbatim.
 */

export const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BRANCH_NAME_PATTERN = /^[^\s]+$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Wave-8 bounds: tighter than the raw API limit, enforced before any call. */
export const MAX_PULL_REQUEST_TITLE_LENGTH = 256;
export const MAX_PULL_REQUEST_BODY_LENGTH = 20_000;
/** A PullRequestRecord URL is bounded at 512 by the shared contract. */
export const MAX_PULL_REQUEST_URL_LENGTH = 512;

export const pullRequestSpecSchema = z
	.object({
		repositoryFullName: z
			.string()
			.min(3)
			.max(200)
			.regex(
				REPOSITORY_FULL_NAME_PATTERN,
				"repositoryFullName must be owner/repo",
			),
		headBranch: z
			.string()
			.min(1, "headBranch must not be empty")
			.max(200)
			.regex(BRANCH_NAME_PATTERN, "headBranch must be a branch name"),
		baseBranch: z
			.string()
			.min(1, "baseBranch must not be empty")
			.max(200)
			.regex(BRANCH_NAME_PATTERN, "baseBranch must be a branch name"),
		title: z.string().min(1, "title must not be empty").max(512),
		body: z.string().max(65_536),
		approvalId: z.string().min(1).optional(),
		approvalPayloadSha256: z
			.string()
			.regex(
				SHA256_PATTERN,
				"approvalPayloadSha256 must be a hex SHA-256 digest",
			)
			.optional(),
	})
	.strict();

export const pullRequestResponseSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.url(),
	head: z.object({
		ref: z.string().min(1),
	}),
});

export type ValidatedPullRequestSpec = z.output<typeof pullRequestSpecSchema>;
export type PullRequestApiResponse = z.output<typeof pullRequestResponseSchema>;

/**
 * Wave-8 approval-bound PR creation. The caller supplies the SHA that the
 * approved payload must hash to; this layer recomputes it before any network
 * call. Title/body are tighter than `pullRequestSpecSchema` because they are
 * built by the worker, not by a human editor.
 */
export const createPullRequestInputSchema = z
	.object({
		repositoryFullName: z
			.string()
			.min(3)
			.max(200)
			.regex(
				REPOSITORY_FULL_NAME_PATTERN,
				"repositoryFullName must be owner/repo",
			),
		headBranch: z
			.string()
			.min(1, "headBranch must not be empty")
			.max(200)
			.regex(BRANCH_NAME_PATTERN, "headBranch must be a branch name"),
		baseBranch: z
			.string()
			.min(1, "baseBranch must not be empty")
			.max(200)
			.regex(BRANCH_NAME_PATTERN, "baseBranch must be a branch name"),
		headSha: z
			.string()
			.regex(GIT_SHA_PATTERN, "headSha must be a git object id"),
		title: z
			.string()
			.min(1, "title must not be empty")
			.max(MAX_PULL_REQUEST_TITLE_LENGTH),
		body: z.string().max(MAX_PULL_REQUEST_BODY_LENGTH),
		expectedPayloadSha256: z
			.string()
			.regex(SHA256_PATTERN, "expectedPayloadSha256 must be a hex digest"),
	})
	.strict();

/** `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` (only the SHA is used). */
export const gitRefResponseSchema = z.object({
	object: z.object({
		sha: z.string().regex(GIT_SHA_PATTERN),
	}),
});

/**
 * One entry of `GET /repos/{owner}/{repo}/pulls` or the body of a successful
 * create. GitHub returns many more fields; they are ignored, never forwarded.
 */
export const pullRequestRecordResponseSchema = z.object({
	number: z.number().int().positive(),
	html_url: z
		.string()
		.min(1)
		.max(MAX_PULL_REQUEST_URL_LENGTH)
		.regex(/^https:\/\//),
	head: z.object({
		ref: z.string().min(1).max(255),
		sha: z.string().regex(GIT_SHA_PATTERN),
	}),
	base: z.object({
		ref: z.string().min(1).max(255),
	}),
});

export const pullRequestRecordListSchema = z.array(
	pullRequestRecordResponseSchema,
);

export type CreatePullRequestInput = z.input<
	typeof createPullRequestInputSchema
>;
export type ValidatedCreatePullRequestInput = z.output<
	typeof createPullRequestInputSchema
>;

export function summarizeZodIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		.join("; ");
}
