import { isPlatformError, type OrganizationId } from "@isolate/shared";
import { z } from "zod";
import type { GitHubTokenProvider } from "./auth";
import { redactSecrets } from "./redact";
import {
	DEFAULT_TIMEOUT_MS,
	describeFetchThrowable,
	extractOwnerRepo,
	extractUpstreamMessage,
	GITHUB_API_BASE,
	GITHUB_API_VERSION,
	mapStatusToFailureCode,
	REQUEST_USER_AGENT,
} from "./rest-client";
import type {
	PrCreationActorContext,
	PullRequestFailure,
	PullRequestFailureCode,
} from "./types";

/**
 * Audited GitHub scoped writes (wave 13, docs §3.1.5).
 *
 *  - `commentOnPullRequest` — `POST .../issues/{number}/comments`, `issues:write`
 *  - `rerunWorkflowRun` — `POST .../actions/runs/{run_id}/rerun`, `actions:write`
 *
 * Both are classified `scoped_write` by the wave-13 policy: allowed without a
 * second approval, always audited, and never on a deploy/rollback/secret path.
 * Each call mints its own repository-scoped installation token and discards it.
 *
 * Audit vocabulary note: `audit_events.action` is a closed DB check constraint,
 * so both calls record `tool.execute` (the existing scoped-execution action)
 * with `details.tool = github.comment | github.rerun_workflow` and
 * `details.risk = scoped_write`. The delivery id is kept as the idempotency
 * note: GitHub exposes no `Idempotency-Key` on either endpoint, so callers must
 * dedupe by delivery id before invoking this module.
 */

export const MAX_GITHUB_COMMENT_BODY_CHARS = 4000;
export const GITHUB_COMMENT_TOOL = "github.comment";
export const GITHUB_RERUN_TOOL = "github.rerun_workflow";

const REPOSITORY_FULL_NAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const CREDENTIAL_LIKE_PATTERN =
	/(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})/;
const URL_USERINFO_PATTERN = /\/\/[^\s/@]+@/g;
const HTTPS_URL_PATTERN = /^https:\/\//;

const repositoryField = z
	.string()
	.min(3)
	.max(200)
	.regex(REPOSITORY_FULL_NAME_PATTERN, "repositoryFullName must be owner/repo");

export const commentOnPullRequestInputSchema = z
	.object({
		repositoryFullName: repositoryField,
		number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		body: z
			.string()
			.min(1)
			.max(
				MAX_GITHUB_COMMENT_BODY_CHARS,
				"comment body is limited to 4000 chars",
			),
	})
	.strict();

export const rerunWorkflowRunInputSchema = z
	.object({
		repositoryFullName: repositoryField,
		runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();

export type CommentOnPullRequestInput = z.input<
	typeof commentOnPullRequestInputSchema
>;
export type RerunWorkflowRunInput = z.input<typeof rerunWorkflowRunInputSchema>;

/**
 * AuditRepository-shaped dependency. `action` is the existing closed
 * vocabulary value, so `PostgresAuditRepository` satisfies this interface.
 */
export interface GitHubScopedWriteAuditSink {
	append(input: {
		organizationId: OrganizationId;
		actorId: string | null;
		actorKind: "user" | "agent" | "worker" | "system";
		action: "tool.execute";
		target: string;
		details: Record<string, unknown>;
		// biome-ignore lint/suspicious/noConfusingVoidType: mirrors PrCreationAuditSink so sync and async sinks both assign
	}): void | Promise<unknown>;
}

export type GitHubWriteDependencies = {
	tokenProvider: Pick<GitHubTokenProvider, "getInstallationToken">;
	audit: GitHubScopedWriteAuditSink;
	actor: PrCreationActorContext;
	fetchImpl?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	/**
	 * Delivery id / idempotency note recorded on the audit entry. GitHub has no
	 * idempotency header on either endpoint; dedupe happens before the call.
	 */
	deliveryId?: string;
};

export type GitHubCommentInfo = { id: number; url: string };
export type GitHubCommentResult =
	| { ok: true; comment: GitHubCommentInfo }
	| PullRequestFailure;
export type GitHubRerunResult =
	| { ok: true; runId: number; rerun: true }
	| PullRequestFailure;

const commentResponseSchema = z.object({
	id: z.number().int().positive(),
	html_url: z.string().max(512).regex(HTTPS_URL_PATTERN),
});

/** Strip URL userinfo, known secret shapes and the live token. */
function sanitize(text: string, secrets: readonly string[]): string {
	return redactSecrets(
		text.replace(URL_USERINFO_PATTERN, "//[credentials-redacted]@"),
		secrets,
	);
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

function quietAudit(
	audit: GitHubScopedWriteAuditSink,
	actor: PrCreationActorContext,
	tool: string,
	target: string,
	outcome: "SUCCEEDED" | "FAILED" | "BLOCKED",
	details: Record<string, unknown>,
): void {
	void Promise.resolve()
		.then(() =>
			audit.append({
				organizationId: actor.organizationId,
				actorId: actor.actorId,
				actorKind: actor.actorKind,
				action: "tool.execute",
				target,
				details: { tool, risk: "scoped_write", outcome, ...details },
			}),
		)
		.catch(() => undefined);
}

function targetFor(repositoryFullName: unknown): string {
	return typeof repositoryFullName === "string" && repositoryFullName.length > 0
		? `repo:${repositoryFullName.slice(0, 200)}`
		: "repo:unknown";
}

type WriteContext = {
	origin: string;
	headers: Record<string, string>;
	token: string;
	timeoutMs: number;
	fetchImpl: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	redact: (text: string) => string;
	deliveryId?: string;
};

type PreparedWrite =
	| { kind: "ready"; context: WriteContext }
	| { kind: "failure"; failure: PullRequestFailure };

/**
 * Validates the delivery-id note, mints one least-privilege token and builds
 * the request context. Every failure is fixed-text: no token, no provider body.
 */
async function prepareWrite(
	dependencies: GitHubWriteDependencies,
	input: {
		repositoryFullName: string;
		contents: "read";
		issues?: "write";
		actions?: "write";
		pullRequests?: "write";
	},
	audit: {
		onFailure: (code: PullRequestFailureCode, message: string) => void;
	},
): Promise<PreparedWrite> {
	const deliveryId = dependencies.deliveryId;
	if (
		deliveryId !== undefined &&
		(typeof deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(deliveryId))
	) {
		const failure: PullRequestFailure = {
			ok: false,
			code: "VALIDATION_FAILED",
			message: "deliveryId must be a bounded alphanumeric id",
		};
		audit.onFailure(failure.code, failure.message ?? failure.code);
		return { kind: "failure", failure };
	}

	const now = dependencies.now ?? (() => Date.now());
	let token = "";
	try {
		const installation =
			await dependencies.tokenProvider.getInstallationToken(input);
		token = typeof installation?.token === "string" ? installation.token : "";
		const expiresAtMs = Date.parse(
			typeof installation?.expiresAt === "string" ? installation.expiresAt : "",
		);
		if (
			token.length === 0 ||
			!Number.isFinite(expiresAtMs) ||
			expiresAtMs <= now()
		) {
			const failure: PullRequestFailure = {
				ok: false,
				code: "INTEGRATION_UNAVAILABLE",
				message: "github returned an unusable installation token",
			};
			audit.onFailure(failure.code, failure.message ?? failure.code);
			return { kind: "failure", failure };
		}
	} catch (throwable) {
		const failure: PullRequestFailure = {
			ok: false,
			code: mapTokenFailureCode(throwable),
			message: "github installation token could not be minted",
		};
		audit.onFailure(failure.code, failure.message ?? failure.code);
		return { kind: "failure", failure };
	}

	const ownerRepo = extractOwnerRepo(input.repositoryFullName);
	if (ownerRepo === null) {
		const failure: PullRequestFailure = {
			ok: false,
			code: "VALIDATION_FAILED",
			message: "repositoryFullName must be owner/repo",
		};
		audit.onFailure(failure.code, failure.message ?? failure.code);
		return { kind: "failure", failure };
	}

	return {
		kind: "ready",
		context: {
			origin: `${GITHUB_API_BASE}/repos/${encodeURIComponent(ownerRepo.owner)}/${encodeURIComponent(ownerRepo.repo)}`,
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": REQUEST_USER_AGENT,
				"X-GitHub-Api-Version": GITHUB_API_VERSION,
				Authorization: `Bearer ${token}`,
			},
			token,
			timeoutMs: dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			fetchImpl:
				dependencies.fetchImpl ?? ((request, init) => fetch(request, init)),
			redact: (text: string) => sanitize(text, [token]),
			...(deliveryId === undefined ? {} : { deliveryId }),
		},
	};
}

function mapHttpFailure(
	context: WriteContext,
	step: string,
	status: number,
	retryAfter: string | null,
	bodyText: string,
): PullRequestFailure {
	const code = mapStatusToFailureCode(status);
	const detail = context.redact(
		extractUpstreamMessage(bodyText) ?? `github api returned status ${status}`,
	);
	if (status === 429) {
		const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
		const hint = Number.isFinite(seconds) ? `; retry after ${seconds}s` : "";
		return {
			ok: false,
			code,
			message: `${step}: rate limited${hint}; ${detail}`,
		};
	}
	return { ok: false, code, message: `${step}: ${detail}` };
}

async function execute(
	context: WriteContext,
	step: string,
	url: string,
	init: RequestInit,
): Promise<{ response: Response; bodyText: string } | PullRequestFailure> {
	try {
		const response = await context.fetchImpl(url, {
			...init,
			headers: { ...context.headers, ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(context.timeoutMs),
		});
		let bodyText = "";
		try {
			bodyText = await response.text();
		} catch {
			bodyText = "";
		}
		return { response, bodyText };
	} catch (throwable) {
		return {
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
			message: `${step} failed: ${context.redact(describeFetchThrowable(throwable))}`,
		};
	}
}

/**
 * Posts one bounded comment on a pull request/issue. The body cap is enforced
 * before a token is minted; a credential-shaped body is refused.
 */
export async function commentOnPullRequest(
	dependencies: GitHubWriteDependencies,
	input: CommentOnPullRequestInput,
): Promise<GitHubCommentResult> {
	const parsed = commentOnPullRequestInputSchema.safeParse(input);
	if (!parsed.success) {
		const target = targetFor(
			(input as { repositoryFullName?: unknown } | null)?.repositoryFullName,
		);
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"BLOCKED",
			{ code: "VALIDATION_FAILED" },
		);
		return {
			ok: false,
			code: "VALIDATION_FAILED",
			message:
				"comment requires repositoryFullName, a positive number and a body of at most 4000 chars",
		};
	}
	const validated = parsed.data;
	const target = `repo:${validated.repositoryFullName}#${validated.number}`;
	const baseDetails = { pullRequestNumber: validated.number };

	if (CREDENTIAL_LIKE_PATTERN.test(validated.body)) {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"BLOCKED",
			{ ...baseDetails, code: "VALIDATION_FAILED" },
		);
		return {
			ok: false,
			code: "VALIDATION_FAILED",
			message: "comment body must not contain credentials",
		};
	}

	let blockedCode: PullRequestFailureCode | null = null;
	const prepared = await prepareWrite(
		dependencies,
		{
			repositoryFullName: validated.repositoryFullName,
			contents: "read",
			issues: "write",
			// Pull-request comments are issue comments on GitHub, but the
			// installation rejected issues:write alone with 403; request both.
			pullRequests: "write",
		},
		{
			onFailure: (code) => {
				blockedCode = code;
			},
		},
	);
	if (prepared.kind === "failure") {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			blockedCode === "VALIDATION_FAILED" ? "BLOCKED" : "FAILED",
			{ ...baseDetails, code: blockedCode ?? "INTEGRATION_UNAVAILABLE" },
		);
		return prepared.failure;
	}
	const context = prepared.context;

	if (validated.body.includes(context.token)) {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"BLOCKED",
			{ ...baseDetails, code: "VALIDATION_FAILED" },
		);
		return {
			ok: false,
			code: "VALIDATION_FAILED",
			message: "comment body must not contain credentials",
		};
	}

	const outcome = await execute(
		context,
		"github comment creation",
		`${context.origin}/issues/${validated.number}/comments`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: validated.body }),
		},
	);
	if ("ok" in outcome) {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"FAILED",
			{ ...baseDetails, code: outcome.code },
		);
		return outcome;
	}

	const { response, bodyText } = outcome;
	let retryAfter: string | null = null;
	try {
		retryAfter = response.headers.get("retry-after");
	} catch {
		retryAfter = null;
	}
	if (response.status !== 200 && response.status !== 201) {
		const failure = mapHttpFailure(
			context,
			"github comment creation",
			response.status,
			retryAfter,
			bodyText,
		);
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"FAILED",
			{ ...baseDetails, code: failure.code },
		);
		return failure;
	}

	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(bodyText);
	} catch {
		parsedBody = undefined;
	}
	const comment = commentResponseSchema.safeParse(parsedBody);
	if (!comment.success) {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_COMMENT_TOOL,
			target,
			"FAILED",
			{ ...baseDetails, code: "INTEGRATION_UNAVAILABLE" },
		);
		return {
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
			message: "github api returned an unexpected response shape",
		};
	}

	quietAudit(
		dependencies.audit,
		dependencies.actor,
		GITHUB_COMMENT_TOOL,
		target,
		"SUCCEEDED",
		{
			...baseDetails,
			commentId: comment.data.id,
			...(context.deliveryId === undefined
				? {}
				: { idempotencyKey: context.deliveryId }),
		},
	);
	return {
		ok: true,
		comment: { id: comment.data.id, url: comment.data.html_url },
	};
}

/**
 * Re-runs one workflow run. No body is sent (GitHub accepts none); success is a
 * 2xx acknowledgement, since the response carries no run representation.
 */
export async function rerunWorkflowRun(
	dependencies: GitHubWriteDependencies,
	input: RerunWorkflowRunInput,
): Promise<GitHubRerunResult> {
	const parsed = rerunWorkflowRunInputSchema.safeParse(input);
	if (!parsed.success) {
		const target = targetFor(
			(input as { repositoryFullName?: unknown } | null)?.repositoryFullName,
		);
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_RERUN_TOOL,
			target,
			"BLOCKED",
			{ code: "VALIDATION_FAILED" },
		);
		return {
			ok: false,
			code: "VALIDATION_FAILED",
			message: "rerun requires repositoryFullName and a positive runId",
		};
	}
	const validated = parsed.data;
	const target = `repo:${validated.repositoryFullName}:run:${validated.runId}`;
	const baseDetails = { runId: validated.runId };

	let blockedCode: PullRequestFailureCode | null = null;
	const prepared = await prepareWrite(
		dependencies,
		{
			repositoryFullName: validated.repositoryFullName,
			contents: "read",
			actions: "write",
		},
		{
			onFailure: (code) => {
				blockedCode = code;
			},
		},
	);
	if (prepared.kind === "failure") {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_RERUN_TOOL,
			target,
			blockedCode === "VALIDATION_FAILED" ? "BLOCKED" : "FAILED",
			{ ...baseDetails, code: blockedCode ?? "INTEGRATION_UNAVAILABLE" },
		);
		return prepared.failure;
	}
	const context = prepared.context;

	const outcome = await execute(
		context,
		"github workflow rerun",
		`${context.origin}/actions/runs/${validated.runId}/rerun`,
		{ method: "POST" },
	);
	if ("ok" in outcome) {
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_RERUN_TOOL,
			target,
			"FAILED",
			{ ...baseDetails, code: outcome.code },
		);
		return outcome;
	}

	const { response, bodyText } = outcome;
	if (![200, 201, 202, 204].includes(response.status)) {
		let retryAfter: string | null = null;
		try {
			retryAfter = response.headers.get("retry-after");
		} catch {
			retryAfter = null;
		}
		const failure = mapHttpFailure(
			context,
			"github workflow rerun",
			response.status,
			retryAfter,
			bodyText,
		);
		quietAudit(
			dependencies.audit,
			dependencies.actor,
			GITHUB_RERUN_TOOL,
			target,
			"FAILED",
			{ ...baseDetails, code: failure.code },
		);
		return failure;
	}

	quietAudit(
		dependencies.audit,
		dependencies.actor,
		GITHUB_RERUN_TOOL,
		target,
		"SUCCEEDED",
		{
			...baseDetails,
			...(context.deliveryId === undefined
				? {}
				: { idempotencyKey: context.deliveryId }),
		},
	);
	return { ok: true, runId: validated.runId, rerun: true };
}
