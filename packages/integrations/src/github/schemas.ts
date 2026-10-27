import { z } from "zod";

/**
 * Validation boundary for everything the connector sends to or receives from
 * GitHub. Provider responses are untrusted input (§7): parsed, scoped, never
 * passed through verbatim.
 */

const REPO_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_NAME_PATTERN = /^[^\s]+$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export const pullRequestSpecSchema = z
	.object({
		repositoryFullName: z
			.string()
			.min(3)
			.max(200)
			.regex(REPO_FULL_NAME_PATTERN, "repositoryFullName must be owner/repo"),
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

export function summarizeZodIssues(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		.join("; ");
}
