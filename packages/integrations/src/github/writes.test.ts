import { describe, expect, test } from "bun:test";
import { type OrganizationId, PlatformError } from "@isolate/shared";
import type {
	GitHubInstallationToken,
	GitHubInstallationTokenRequest,
} from "./auth";
import type { PrCreationActorContext } from "./types";
import {
	commentOnPullRequest,
	type GitHubScopedWriteAuditSink,
	type GitHubWriteDependencies,
	rerunWorkflowRun,
} from "./writes";

const REPOSITORY = "acme/widgets";
const TOKEN = "ghs_w13tok_0123456789abcdef";
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const ACTOR: PrCreationActorContext = {
	organizationId: "20000000-0000-4000-8000-000000000001" as OrganizationId,
	actorId: "task_attempt_w13",
	actorKind: "worker",
};

type FetchCall = { url: string; init: RequestInit };
type AuditEntry = Parameters<GitHubScopedWriteAuditSink["append"]>[0];

function recordingFetch(
	handler: (call: FetchCall) => Response | Promise<Response>,
): { impl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const call: FetchCall = {
			url: input instanceof Request ? input.url : input.toString(),
			init: init ?? {},
		};
		calls.push(call);
		return handler(call);
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown, headers = {}): Response {
	return new Response(body === undefined ? "" : JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function tokenProvider(overrides: Partial<GitHubInstallationToken> = {}): {
	requests: GitHubInstallationTokenRequest[];
	provider: GitHubWriteDependencies["tokenProvider"];
} {
	const requests: GitHubInstallationTokenRequest[] = [];
	return {
		requests,
		provider: {
			async getInstallationToken(request) {
				requests.push(request);
				return { token: TOKEN, expiresAt: EXPIRES_AT, ...overrides };
			},
		},
	};
}

function auditSink(entries: AuditEntry[] = []): {
	entries: AuditEntry[];
	sink: GitHubScopedWriteAuditSink;
} {
	return {
		entries,
		sink: {
			append(input) {
				entries.push(input);
			},
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function dependencies(
	fetchImpl: typeof fetch,
	provider: GitHubWriteDependencies["tokenProvider"],
	sink: GitHubScopedWriteAuditSink,
	overrides: Partial<GitHubWriteDependencies> = {},
): GitHubWriteDependencies {
	return {
		tokenProvider: provider,
		audit: sink,
		actor: ACTOR,
		fetchImpl,
		now: () => Date.now(),
		...overrides,
	};
}

describe("commentOnPullRequest", () => {
	test("posts a bounded comment with issues:write and pull_requests:write, and audits it", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, {
				id: 555,
				html_url: "https://github.com/acme/widgets/issues/12#issuecomment-555",
			}),
		);
		const tokens = tokenProvider();
		const audit = auditSink();

		const result = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink, {
				deliveryId: "delivery-w13-1",
			}),
			{
				repositoryFullName: REPOSITORY,
				number: 12,
				body: "CI is green again.",
			},
		);

		expect(result).toEqual({
			ok: true,
			comment: {
				id: 555,
				url: "https://github.com/acme/widgets/issues/12#issuecomment-555",
			},
		});
		expect(tokens.requests).toHaveLength(1);
		expect(tokens.requests[0]).toEqual({
			repositoryFullName: REPOSITORY,
			contents: "read",
			issues: "write",
			pullRequests: "write",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/acme/widgets/issues/12/comments",
		);
		expect(calls[0]?.init.method).toBe("POST");
		expect(
			(calls[0]?.init.headers as Record<string, string> | undefined)
				?.Authorization,
		).toBe(`Bearer ${TOKEN}`);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			body: "CI is green again.",
		});

		await flush();
		expect(audit.entries).toHaveLength(1);
		const entry = audit.entries[0];
		expect(entry?.action).toBe("tool.execute");
		expect(entry?.target).toBe("repo:acme/widgets#12");
		expect(entry?.details.tool).toBe("github.comment");
		expect(entry?.details.risk).toBe("scoped_write");
		expect(entry?.details.outcome).toBe("SUCCEEDED");
		expect(entry?.details.commentId).toBe(555);
		expect(entry?.details.idempotencyKey).toBe("delivery-w13-1");
	});

	test("refuses an oversized or credential-shaped body before any token", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, { id: 1, html_url: "https://github.com/a/b/issues/1" }),
		);
		const tokens = tokenProvider();
		const audit = auditSink();

		const oversized = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink),
			{
				repositoryFullName: REPOSITORY,
				number: 12,
				body: "x".repeat(4001),
			},
		);
		expect(oversized).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });

		const credential = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink),
			{
				repositoryFullName: REPOSITORY,
				number: 12,
				body: "see ghp_abcdefgh12345678",
			},
		);
		expect(credential).toMatchObject({
			ok: false,
			code: "VALIDATION_FAILED",
		});
		expect(tokens.requests).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("maps 403 to POLICY_DENIED and 429 to RATE_LIMITED without echoing the token", async () => {
		const forbidden = recordingFetch(() =>
			jsonResponse(403, {
				message: `Resource not accessible by integration ${TOKEN}`,
			}),
		);
		const tokens = tokenProvider();
		const audit = auditSink();
		const denied = await commentOnPullRequest(
			dependencies(forbidden.impl, tokens.provider, audit.sink),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(denied).toMatchObject({ ok: false, code: "POLICY_DENIED" });
		expect(JSON.stringify(denied)).not.toContain(TOKEN);

		const limited = recordingFetch(() =>
			jsonResponse(429, { message: "slow down" }, { "retry-after": "30" }),
		);
		const rateLimited = await commentOnPullRequest(
			dependencies(limited.impl, tokens.provider, audit.sink),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(rateLimited).toMatchObject({ ok: false, code: "RATE_LIMITED" });
		if (!rateLimited.ok) {
			expect(rateLimited.message).toContain("retry after 30s");
		}
	});

	test("rejects malformed responses and input", async () => {
		const { impl } = recordingFetch(() =>
			jsonResponse(201, { id: "not-a-number" }),
		);
		const tokens = tokenProvider();
		const audit = auditSink();
		const malformed = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(malformed).toMatchObject({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});

		const invalid = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink),
			{ repositoryFullName: "not-an-owner-repo", number: 12, body: "hello" },
		);
		expect(invalid).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
	});

	test("surfaces token failures as bounded codes", async () => {
		const { impl } = recordingFetch(() =>
			jsonResponse(201, { id: 1, html_url: "https://github.com/a/b/issues/1" }),
		);
		const audit = auditSink();
		const limitedProvider: GitHubWriteDependencies["tokenProvider"] = {
			async getInstallationToken() {
				throw new PlatformError("RATE_LIMITED", "broker throttled");
			},
		};
		const result = await commentOnPullRequest(
			dependencies(impl, limitedProvider, audit.sink),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED" });
		expect(JSON.stringify(result)).not.toContain("broker throttled");
	});

	test("a broken audit sink never changes the result", async () => {
		const { impl } = recordingFetch(() =>
			jsonResponse(201, {
				id: 7,
				html_url: "https://github.com/acme/widgets/issues/12#issuecomment-7",
			}),
		);
		const tokens = tokenProvider();
		const throwingSink: GitHubScopedWriteAuditSink = {
			append() {
				throw new Error("sink down");
			},
		};
		const result = await commentOnPullRequest(
			dependencies(impl, tokens.provider, throwingSink),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(result.ok).toBe(true);
	});

	test("rejects a malformed delivery id before any network call", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, { id: 1, html_url: "https://github.com/a/b/issues/1" }),
		);
		const tokens = tokenProvider();
		const audit = auditSink();
		const result = await commentOnPullRequest(
			dependencies(impl, tokens.provider, audit.sink, {
				deliveryId: "../not-a-delivery",
			}),
			{ repositoryFullName: REPOSITORY, number: 12, body: "hello" },
		);
		expect(result).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(tokens.requests).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});

describe("rerunWorkflowRun", () => {
	test("reruns one run with actions:write and audits the delivery id", async () => {
		const { impl, calls } = recordingFetch(() => jsonResponse(201, undefined));
		const tokens = tokenProvider();
		const audit = auditSink();

		const result = await rerunWorkflowRun(
			dependencies(impl, tokens.provider, audit.sink, {
				deliveryId: "delivery-w13-2",
			}),
			{ repositoryFullName: REPOSITORY, runId: 4242 },
		);

		expect(result).toEqual({ ok: true, runId: 4242, rerun: true });
		expect(tokens.requests[0]).toEqual({
			repositoryFullName: REPOSITORY,
			contents: "read",
			actions: "write",
		});
		expect(calls[0]?.url).toBe(
			"https://api.github.com/repos/acme/widgets/actions/runs/4242/rerun",
		);
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.body).toBeUndefined();

		await flush();
		const entry = audit.entries[0];
		expect(entry?.target).toBe("repo:acme/widgets:run:4242");
		expect(entry?.details.tool).toBe("github.rerun_workflow");
		expect(entry?.details.idempotencyKey).toBe("delivery-w13-2");
		expect(entry?.details.outcome).toBe("SUCCEEDED");
	});

	test("maps 404, 422 and 5xx to bounded codes", async () => {
		const tokens = tokenProvider();
		const audit = auditSink();
		for (const [status, code] of [
			[404, "NOT_FOUND"],
			[422, "VALIDATION_FAILED"],
			[500, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = recordingFetch(() =>
				jsonResponse(status, { message: "upstream said no" }),
			);
			const result = await rerunWorkflowRun(
				dependencies(impl, tokens.provider, audit.sink),
				{ repositoryFullName: REPOSITORY, runId: 4242 },
			);
			expect(result).toMatchObject({ ok: false, code });
		}
	});

	test("rejects an unusable token without calling the API", async () => {
		const { impl, calls } = recordingFetch(() => jsonResponse(201, undefined));
		const tokens = tokenProvider({ token: "" });
		const audit = auditSink();
		const result = await rerunWorkflowRun(
			dependencies(impl, tokens.provider, audit.sink),
			{ repositoryFullName: REPOSITORY, runId: 4242 },
		);
		expect(result).toMatchObject({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});
		expect(calls).toHaveLength(0);
	});

	test("rejects a non-positive run id before minting a token", async () => {
		const { impl, calls } = recordingFetch(() => jsonResponse(201, undefined));
		const tokens = tokenProvider();
		const audit = auditSink();
		const result = await rerunWorkflowRun(
			dependencies(impl, tokens.provider, audit.sink),
			{ repositoryFullName: REPOSITORY, runId: 0 },
		);
		expect(result).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(tokens.requests).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});
