import { redactSecrets } from "./redact";
import {
	pullRequestResponseSchema,
	pullRequestSpecSchema,
	summarizeZodIssues,
} from "./schemas";
import type {
	GitHubCredentials,
	PrCreationActorContext,
	PrCreationAuditSink,
	PrCreationOutcome,
	PrSensitivityPolicy,
	PullRequestCreator,
	PullRequestFailure,
	PullRequestFailureCode,
	PullRequestInfo,
	PullRequestSpec,
	ValidatedPullRequestSpec,
} from "./types";

/**
 * GitHub PR-creation connector (§7/§8). Least-privilege REST surface:
 *
 *  - one endpoint: POST /repos/{owner}/{repo}/pulls
 *  - one permission needed: contents:write through a scoped, short-lived
 *    installation token taken only into the Authorization header
 *  - deny-default approval gating: sensitive operations require an approval
 *    bound to the exact payload hash (§8); the default sensitivity policy
 *    denies everything, so callers must classify explicitly
 *  - every call site records an audit entry through the injected
 *    PrCreationAuditSink (AuditRepository-shaped)
 *  - no token, stack, or unredacted provider body ever reaches the caller:
 *    everything funnels through `redactSecrets` before it becomes a Result
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_USER_AGENT = "isolate-platform";
const DEFAULT_TIMEOUT_MS = 10_000;

export type PrCreatorDependencies = {
	credentials: GitHubCredentials;
	audit: PrCreationAuditSink;
	/** Caller identity recorded verbatim on every audit entry. */
	actor: PrCreationActorContext;
	/**
	 * Deny-default: when omitted, every pull request is treated as sensitive
	 * and requires a payload-bound approval.
	 */
	isSensitive?: PrSensitivityPolicy;
	/** Injectable for tests; defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Per-request deadline; bounded by default, never unbounded. */
	timeoutMs?: number;
};

export function extractOwnerRepo(
	repositoryFullName: string,
): { owner: string; repo: string } | null {
	const separator = repositoryFullName.indexOf("/");
	if (separator <= 0 || separator === repositoryFullName.length - 1) {
		return null;
	}
	const owner = repositoryFullName.slice(0, separator);
	const repo = repositoryFullName.slice(separator + 1);
	if (owner.includes("/") || repo.includes("/")) {
		return null;
	}
	return { owner, repo };
}

/**
 * The exact payload an approval must be bound to (§8). Only the fields whose
 * change would alter the created pull request participate.
 */
export function canonicalPullRequestPayload(
	spec: Pick<
		PullRequestSpec,
		"repositoryFullName" | "headBranch" | "baseBranch" | "title" | "body"
	>,
): string {
	return JSON.stringify({
		repositoryFullName: spec.repositoryFullName,
		headBranch: spec.headBranch,
		baseBranch: spec.baseBranch,
		title: spec.title,
		body: spec.body,
	});
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function extractUpstreamMessage(bodyText: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { message?: unknown }).message === "string"
		) {
			return (parsed as { message: string }).message;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function describeFetchThrowable(throwable: unknown): string {
	if (throwable instanceof Error) {
		if (throwable.name === "TimeoutError" || throwable.name === "AbortError") {
			return "request timed out";
		}
		// Fabricated or provider-supplied text may embed credentials; the
		// message is redacted before it can reach a caller or audit sink.
		return throwable.message;
	}
	return "request failed";
}

function mapStatusToFailureCode(status: number): PullRequestFailureCode {
	switch (status) {
		case 401:
			// Credentials rejected: scoped installation token may have expired.
			return "INTEGRATION_UNAVAILABLE";
		case 403:
			return "POLICY_DENIED";
		case 404:
			return "NOT_FOUND";
		case 422:
			return "VALIDATION_FAILED";
		case 429:
			return "RATE_LIMITED";
		default:
			return status >= 500
				? "INTEGRATION_UNAVAILABLE"
				: // Unmapped 4xx (deny-default).
					"POLICY_DENIED";
	}
}

function auditSinkQuietly(
	audit: PrCreationAuditSink,
	actor: PrCreationActorContext,
	target: string,
	outcome: PrCreationOutcome,
	details: Record<string, unknown>,
): void {
	// Audit failures must not mask the connector result; the sink layer is
	// fail-quiet by contract (packages/db AuditRepository).
	void Promise.resolve()
		.then(() =>
			audit.append({
				organizationId: actor.organizationId,
				actorId: actor.actorId,
				actorKind: actor.actorKind,
				action: "pr.create" as const,
				target,
				details: {
					outcome: outcome.kind,
					...(outcome.kind === "SUCCEEDED" ? {} : { code: outcome.code }),
					...details,
				},
			}),
		)
		.catch(() => undefined);
}

export function createPrCreator(
	dependencies: PrCreatorDependencies,
): PullRequestCreator {
	const { credentials, audit, actor } = dependencies;
	const credentialsAsSecrets: readonly string[] = [
		credentials.installationToken,
	];
	const fetchImpl =
		dependencies.fetchImpl ?? ((input, init) => fetch(input, init));
	const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		createPullRequest: async (spec: PullRequestSpec) => {
			const redact = (text: string): string =>
				redactSecrets(text, credentialsAsSecrets);

			// 1. Spec validation (rejects empty branches, malformed repo ref,
			//    oversized fields, unknown keys).
			const parsedSpec = pullRequestSpecSchema.safeParse(spec);
			if (!parsedSpec.success) {
				const failure: PullRequestFailure = {
					ok: false,
					code: "VALIDATION_FAILED",
					message: redact(summarizeZodIssues(parsedSpec.error)),
				};
				auditSinkQuietly(
					audit,
					actor,
					`repo:${spec.repositoryFullName}`,
					{
						kind: "BLOCKED",
						code: "VALIDATION_FAILED",
					},
					{
						headBranch: spec.headBranch,
						baseBranch: spec.baseBranch,
					},
				);
				return failure;
			}
			const validated: ValidatedPullRequestSpec = parsedSpec.data;
			const ownerRepo = extractOwnerRepo(validated.repositoryFullName);
			if (ownerRepo === null) {
				const failure: PullRequestFailure = {
					ok: false,
					code: "VALIDATION_FAILED",
					message: "repositoryFullName must be owner/repo",
				};
				auditSinkQuietly(
					audit,
					actor,
					`repo:${validated.repositoryFullName}`,
					{
						kind: "BLOCKED",
						code: "VALIDATION_FAILED",
					},
					{
						headBranch: validated.headBranch,
						baseBranch: validated.baseBranch,
					},
				);
				return failure;
			}
			const target = `repo:${validated.repositoryFullName}`;
			const auditDetails = {
				headBranch: validated.headBranch,
				baseBranch: validated.baseBranch,
			};

			// 2. Approval gating (§8). Policy lives in trusted code; the
			//    approval must be bound to the exact payload hash.
			const sensitive = dependencies.isSensitive
				? dependencies.isSensitive(validated) === true
				: true;
			if (sensitive) {
				const { approvalId, approvalPayloadSha256 } = validated;
				if (!approvalId || !approvalPayloadSha256) {
					const failure: PullRequestFailure = {
						ok: false,
						code: "APPROVAL_REQUIRED",
						message:
							"sensitive pull request requires a payload-bound approval (approvalId + approvalPayloadSha256)",
					};
					auditSinkQuietly(
						audit,
						actor,
						target,
						{
							kind: "BLOCKED",
							code: "APPROVAL_REQUIRED",
						},
						auditDetails,
					);
					return failure;
				}
				const actualPayloadSha256 = await sha256Hex(
					canonicalPullRequestPayload(validated),
				);
				if (actualPayloadSha256 !== approvalPayloadSha256.toLowerCase()) {
					const failure: PullRequestFailure = {
						ok: false,
						code: "APPROVAL_REQUIRED",
						message:
							"approval payload bound to a different request; re-approval required",
					};
					auditSinkQuietly(
						audit,
						actor,
						target,
						{
							kind: "BLOCKED",
							code: "APPROVAL_REQUIRED",
						},
						auditDetails,
					);
					return failure;
				}
			}

			// 3. REST call, bounded by timeout, token confined to this header.
			const endpoint = `${GITHUB_API_BASE}/repos/${encodeURIComponent(ownerRepo.owner)}/${encodeURIComponent(ownerRepo.repo)}/pulls`;
			try {
				const response = await fetchImpl(endpoint, {
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"User-Agent": REQUEST_USER_AGENT,
						"X-GitHub-Api-Version": GITHUB_API_VERSION,
						Authorization: `Bearer ${credentials.installationToken}`,
					},
					body: JSON.stringify({
						title: validated.title,
						body: validated.body,
						head: validated.headBranch,
						base: validated.baseBranch,
					}),
					signal: AbortSignal.timeout(timeoutMs),
				});
				const bodyText = await response.text();

				if (response.status === 200 || response.status === 201) {
					let parsedBody: unknown;
					try {
						parsedBody = JSON.parse(bodyText);
					} catch {
						parsedBody = undefined;
					}
					const parsedResponse =
						pullRequestResponseSchema.safeParse(parsedBody);
					if (!parsedResponse.success) {
						const failure: PullRequestFailure = {
							ok: false,
							code: "INTEGRATION_UNAVAILABLE",
							message: "github api returned an unexpected response shape",
						};
						auditSinkQuietly(
							audit,
							actor,
							target,
							{ kind: "FAILED", code: "INTEGRATION_UNAVAILABLE" },
							auditDetails,
						);
						return failure;
					}
					const pullRequest: PullRequestInfo = {
						number: parsedResponse.data.number,
						url: parsedResponse.data.html_url,
						headBranch: parsedResponse.data.head.ref,
					};
					auditSinkQuietly(
						audit,
						actor,
						target,
						{ kind: "SUCCEEDED" },
						{
							...auditDetails,
							pullRequestNumber: pullRequest.number,
						},
					);
					return { ok: true, pr: pullRequest };
				}

				// 4. Bounded error mapping: status → typed code; provider text is
				//    only ever included after redaction.
				const code = mapStatusToFailureCode(response.status);
				const upstream = extractUpstreamMessage(bodyText);
				let message = redact(
					upstream ?? `github api returned status ${response.status}`,
				);
				if (response.status === 429) {
					const retryAfter = Number(response.headers.get("retry-after"));
					const retryHint = Number.isFinite(retryAfter)
						? `; retry after ${retryAfter}s`
						: "";
					message = `rate limited${retryHint}; ${message}`;
				}
				const failure: PullRequestFailure = { ok: false, code, message };
				auditSinkQuietly(
					audit,
					actor,
					target,
					{
						kind: "FAILED",
						code,
					},
					auditDetails,
				);
				return failure;
			} catch (throwable) {
				const failure: PullRequestFailure = {
					ok: false,
					code: "INTEGRATION_UNAVAILABLE",
					message: `github api request failed: ${redact(describeFetchThrowable(throwable))}`,
				};
				auditSinkQuietly(
					audit,
					actor,
					target,
					{
						kind: "FAILED",
						code: "INTEGRATION_UNAVAILABLE",
					},
					auditDetails,
				);
				return failure;
			}
		},
	};
}
