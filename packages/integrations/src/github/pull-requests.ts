import {
	isPlatformError,
	type PullRequestRecord,
	pullRequestRecordSchema,
} from "@isolate/shared";
import { redactSecrets } from "./redact";
import {
	auditSinkQuietly,
	DEFAULT_TIMEOUT_MS,
	describeFetchThrowable,
	extractOwnerRepo,
	extractUpstreamMessage,
	GITHUB_API_BASE,
	GITHUB_API_VERSION,
	mapStatusToFailureCode,
	REQUEST_USER_AGENT,
	sha256Hex,
} from "./rest-client";
import {
	type CreatePullRequestInput,
	createPullRequestInputSchema,
	gitRefResponseSchema,
	pullRequestRecordListSchema,
	pullRequestRecordResponseSchema,
	summarizeZodIssues,
	type ValidatedCreatePullRequestInput,
} from "./schemas";
import type {
	PullRequestCreationDependencies,
	PullRequestCreationResult,
	PullRequestFailure,
	PullRequestFailureCode,
} from "./types";

/**
 * Wave-8 approval-bound, idempotent pull-request creation.
 *
 * Flow (each refusal happens before the step it protects):
 *  1. recompute the canonical approval payload SHA over
 *     `{repositoryFullName, headBranch, baseBranch, headSha}` and refuse any
 *     mismatch — before any network call;
 *  2. mint one repository-scoped installation token (`contents` +
 *     `pull_requests`, write);
 *  3. verify the remote branch head equals the approved `headSha`;
 *  4. return the already-open PR for that head branch when one exists;
 *  5. otherwise create the PR and return the shared `PullRequestRecord`.
 *
 * No token, Authorization header, or credential-bearing URL is ever placed in
 * a returned failure, an audit detail, or the returned record.
 */

/**
 * Static credential shapes refused in title/body. Deliberately narrower than
 * `redactSecrets` so ordinary prose is not rejected.
 */
const CREDENTIAL_LIKE_PATTERN =
	/(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})/;

/**
 * The exact payload a wave-8 approval is bound to. Key order is part of the
 * contract: the worker computes the same string before persisting the
 * approval.
 */
export function canonicalPullRequestApprovalPayload(
	payload: Pick<
		CreatePullRequestInput,
		"repositoryFullName" | "headBranch" | "baseBranch" | "headSha"
	>,
): string {
	return JSON.stringify({
		repositoryFullName: payload.repositoryFullName,
		headBranch: payload.headBranch,
		baseBranch: payload.baseBranch,
		headSha: payload.headSha,
	});
}

/** SHA-256 of `canonicalPullRequestApprovalPayload`; the approval binds this. */
export async function pullRequestApprovalPayloadSha256(
	payload: Parameters<typeof canonicalPullRequestApprovalPayload>[0],
): Promise<string> {
	return sha256Hex(canonicalPullRequestApprovalPayload(payload));
}

function auditTargetFor(input: unknown): string {
	if (input !== null && typeof input === "object") {
		const repositoryFullName = (input as { repositoryFullName?: unknown })
			.repositoryFullName;
		if (
			typeof repositoryFullName === "string" &&
			repositoryFullName.length > 0
		) {
			return `repo:${repositoryFullName.slice(0, 200)}`;
		}
	}
	return "repo:unknown";
}

function mapTokenFailureCode(throwable: unknown): PullRequestFailureCode {
	if (isPlatformError(throwable)) {
		switch (throwable.code) {
			case "VALIDATION_FAILED":
				return "VALIDATION_FAILED";
			case "POLICY_DENIED":
				return "POLICY_DENIED";
			case "NOT_FOUND":
				return "NOT_FOUND";
			case "RATE_LIMITED":
				return "RATE_LIMITED";
			default:
				return "INTEGRATION_UNAVAILABLE";
		}
	}
	return "INTEGRATION_UNAVAILABLE";
}

function parseJson(bodyText: string): unknown {
	try {
		return JSON.parse(bodyText);
	} catch {
		return undefined;
	}
}

export async function createPullRequestForTask(
	dependencies: PullRequestCreationDependencies,
	input: CreatePullRequestInput,
): Promise<PullRequestCreationResult> {
	const { audit, actor, tokenProvider } = dependencies;
	const fetchImpl =
		dependencies.fetchImpl ?? ((request, init) => fetch(request, init));
	const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = dependencies.now ?? (() => Date.now());
	const target = auditTargetFor(input);

	const refuse = (
		code: PullRequestFailureCode,
		message: string,
		details: Record<string, unknown> = {},
	): PullRequestFailure => {
		auditSinkQuietly(audit, actor, target, { kind: "BLOCKED", code }, details);
		return { ok: false, code, message };
	};
	const fail = (
		code: PullRequestFailureCode,
		message: string,
		details: Record<string, unknown> = {},
	): PullRequestFailure => {
		auditSinkQuietly(audit, actor, target, { kind: "FAILED", code }, details);
		return { ok: false, code, message };
	};

	// 1. Input bounds (title ≤256, body ≤20000, owner/repo, branch, git SHA).
	const parsedInput = createPullRequestInputSchema.safeParse(input);
	if (!parsedInput.success) {
		return refuse("VALIDATION_FAILED", summarizeZodIssues(parsedInput.error));
	}
	const validated: ValidatedCreatePullRequestInput = parsedInput.data;
	const ownerRepo = extractOwnerRepo(validated.repositoryFullName);
	if (ownerRepo === null) {
		return refuse("VALIDATION_FAILED", "repositoryFullName must be owner/repo");
	}
	const auditDetails = {
		headBranch: validated.headBranch,
		baseBranch: validated.baseBranch,
		headSha: validated.headSha,
	};

	// 2. Approval binding, before any network call.
	const actualPayloadSha256 = await sha256Hex(
		canonicalPullRequestApprovalPayload(validated),
	);
	if (actualPayloadSha256 !== validated.expectedPayloadSha256.toLowerCase()) {
		return refuse(
			"APPROVAL_REQUIRED",
			"approval payload bound to a different request; re-approval required",
			auditDetails,
		);
	}

	// 3. Static credential guard before anything is sent.
	if (
		CREDENTIAL_LIKE_PATTERN.test(validated.title) ||
		CREDENTIAL_LIKE_PATTERN.test(validated.body)
	) {
		return refuse(
			"VALIDATION_FAILED",
			"title and body must not contain credentials",
			auditDetails,
		);
	}

	// 4. One repository-scoped token, least privilege, never logged.
	let installation: Awaited<
		ReturnType<
			PullRequestCreationDependencies["tokenProvider"]["getInstallationToken"]
		>
	>;
	try {
		installation = await tokenProvider.getInstallationToken({
			repositoryFullName: validated.repositoryFullName,
			contents: "write",
			pullRequests: "write",
		});
	} catch (throwable) {
		return fail(
			mapTokenFailureCode(throwable),
			"github installation token could not be minted",
			auditDetails,
		);
	}
	const token =
		typeof installation?.token === "string" ? installation.token : "";
	const expiresAtMs = Date.parse(
		typeof installation?.expiresAt === "string" ? installation.expiresAt : "",
	);
	if (
		token.length === 0 ||
		!Number.isFinite(expiresAtMs) ||
		expiresAtMs <= now()
	) {
		return fail(
			"INTEGRATION_UNAVAILABLE",
			"github returned an unusable installation token",
			auditDetails,
		);
	}
	const redact = (text: string): string => redactSecrets(text, [token]);
	if (validated.title.includes(token) || validated.body.includes(token)) {
		return refuse(
			"VALIDATION_FAILED",
			"title and body must not contain credentials",
			auditDetails,
		);
	}

	const origin = `${GITHUB_API_BASE}/repos/${encodeURIComponent(ownerRepo.owner)}/${encodeURIComponent(ownerRepo.repo)}`;
	const authHeaders = {
		Accept: "application/vnd.github+json",
		"User-Agent": REQUEST_USER_AGENT,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		Authorization: `Bearer ${token}`,
	};

	type ApiOutcome =
		| {
				kind: "response";
				status: number;
				bodyText: string;
				retryAfter: string | null;
		  }
		| { kind: "failure"; failure: PullRequestFailure };

	const call = async (
		url: string,
		init: RequestInit,
		step: string,
	): Promise<ApiOutcome> => {
		try {
			const response = await fetchImpl(url, {
				...init,
				signal: AbortSignal.timeout(timeoutMs),
			});
			return {
				kind: "response",
				status: response.status,
				bodyText: await response.text(),
				retryAfter: response.headers.get("retry-after"),
			};
		} catch (throwable) {
			return {
				kind: "failure",
				failure: fail(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed: ${redact(describeFetchThrowable(throwable))}`,
					auditDetails,
				),
			};
		}
	};

	const httpFailure = (
		step: string,
		status: number,
		bodyText: string,
		retryAfter: string | null,
	): PullRequestFailure => {
		const code = mapStatusToFailureCode(status);
		const detail = redact(
			extractUpstreamMessage(bodyText) ??
				`github api returned status ${status}`,
		);
		if (status === 429) {
			const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
			const hint = Number.isFinite(seconds) ? `; retry after ${seconds}s` : "";
			return fail(
				code,
				`${step}: rate limited${hint}; ${detail}`,
				auditDetails,
			);
		}
		return fail(code, `${step}: ${detail}`, auditDetails);
	};

	// 5. The approved commit must be the current remote head.
	const branchPath = validated.headBranch
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	const refOutcome = await call(
		`${origin}/git/ref/heads/${branchPath}`,
		{ method: "GET", headers: authHeaders },
		"github branch lookup",
	);
	if (refOutcome.kind === "failure") {
		return refOutcome.failure;
	}
	if (refOutcome.status !== 200) {
		return httpFailure(
			"github branch lookup",
			refOutcome.status,
			refOutcome.bodyText,
			refOutcome.retryAfter,
		);
	}
	const refParsed = gitRefResponseSchema.safeParse(
		parseJson(refOutcome.bodyText),
	);
	if (!refParsed.success) {
		return fail(
			"INTEGRATION_UNAVAILABLE",
			"github api returned an unexpected response shape",
			auditDetails,
		);
	}
	if (
		refParsed.data.object.sha.toLowerCase() !== validated.headSha.toLowerCase()
	) {
		return refuse(
			"POLICY_DENIED",
			"remote branch head does not match the approved commit; refusing to open a pull request",
			auditDetails,
		);
	}

	// 6. Idempotency: an open PR for this head branch is the answer.
	const headQuery = new URLSearchParams({
		state: "open",
		head: `${ownerRepo.owner}:${validated.headBranch}`,
	});
	const listOutcome = await call(
		`${origin}/pulls?${headQuery.toString()}`,
		{ method: "GET", headers: authHeaders },
		"github pull request lookup",
	);
	if (listOutcome.kind === "failure") {
		return listOutcome.failure;
	}
	if (listOutcome.status !== 200) {
		return httpFailure(
			"github pull request lookup",
			listOutcome.status,
			listOutcome.bodyText,
			listOutcome.retryAfter,
		);
	}
	const listParsed = pullRequestRecordListSchema.safeParse(
		parseJson(listOutcome.bodyText),
	);
	if (!listParsed.success) {
		return fail(
			"INTEGRATION_UNAVAILABLE",
			"github api returned an unexpected response shape",
			auditDetails,
		);
	}

	const toRecord = (candidate: PullRequestRecord): PullRequestRecord | null => {
		const parsed = pullRequestRecordSchema.safeParse(candidate);
		return parsed.success ? parsed.data : null;
	};

	const existing = listParsed.data.find(
		(entry) => entry.head.ref === validated.headBranch,
	);
	if (existing !== undefined) {
		const record = toRecord({
			number: existing.number,
			url: existing.html_url,
			headBranch: existing.head.ref,
			baseBranch: existing.base.ref,
			headSha: existing.head.sha,
		});
		if (record === null) {
			return fail(
				"INTEGRATION_UNAVAILABLE",
				"github api returned an unexpected response shape",
				auditDetails,
			);
		}
		auditSinkQuietly(
			audit,
			actor,
			target,
			{ kind: "SUCCEEDED" },
			{
				...auditDetails,
				pullRequestNumber: record.number,
				idempotent: true,
			},
		);
		return { ok: true, pullRequest: record, created: false };
	}

	// 7. Create, then map the response through the shared record contract.
	const createOutcome = await call(
		`${origin}/pulls`,
		{
			method: "POST",
			headers: { ...authHeaders, "Content-Type": "application/json" },
			body: JSON.stringify({
				title: validated.title,
				body: validated.body,
				head: validated.headBranch,
				base: validated.baseBranch,
			}),
		},
		"github pull request creation",
	);
	if (createOutcome.kind === "failure") {
		return createOutcome.failure;
	}
	if (createOutcome.status !== 200 && createOutcome.status !== 201) {
		return httpFailure(
			"github pull request creation",
			createOutcome.status,
			createOutcome.bodyText,
			createOutcome.retryAfter,
		);
	}
	const createdParsed = pullRequestRecordResponseSchema.safeParse(
		parseJson(createOutcome.bodyText),
	);
	if (!createdParsed.success) {
		return fail(
			"INTEGRATION_UNAVAILABLE",
			"github api returned an unexpected response shape",
			auditDetails,
		);
	}
	const record = toRecord({
		number: createdParsed.data.number,
		url: createdParsed.data.html_url,
		headBranch: createdParsed.data.head.ref,
		baseBranch: createdParsed.data.base.ref,
		headSha: createdParsed.data.head.sha,
	});
	if (record === null) {
		return fail(
			"INTEGRATION_UNAVAILABLE",
			"github api returned an unexpected response shape",
			auditDetails,
		);
	}
	auditSinkQuietly(
		audit,
		actor,
		target,
		{ kind: "SUCCEEDED" },
		{
			...auditDetails,
			pullRequestNumber: record.number,
			idempotent: false,
		},
	);
	return { ok: true, pullRequest: record, created: true };
}
