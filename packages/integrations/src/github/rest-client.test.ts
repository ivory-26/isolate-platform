import { describe, expect, mock, test } from "bun:test";
import type { OrganizationId } from "@isolate/shared";
import {
	canonicalPullRequestPayload,
	createPrCreator,
	extractOwnerRepo,
	sha256Hex,
} from "./rest-client";
import type {
	PrCreationAuditSink,
	PullRequestFailureCode,
	PullRequestSpec,
} from "./types";

const INSTALLATION_TOKEN = "ghs_fix_0123456789";
const FABRICATED_TOKEN = "ghp_fabricated1234567890abc";

const CREDENTIALS = {
	installationToken: INSTALLATION_TOKEN,
	passwordless: true as const,
};

const ACTOR = {
	organizationId: "org_test_1" as OrganizationId,
	actorId: "task_attempt_1",
	actorKind: "worker" as const,
};

const BASE_SPEC: PullRequestSpec = {
	repositoryFullName: "acme/widgets",
	headBranch: "agent/task-1",
	baseBranch: "main",
	title: "feat: add widget",
	body: "does the thing",
};

const OK_RESPONSE_BODY = {
	number: 7,
	html_url: "https://github.com/acme/widgets/pull/7",
	head: { ref: "agent/task-1" },
};

type StubResponse = {
	status: number;
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
};

type RecordedRequest = { url: string; init: RequestInit };

type AuditCall = {
	organizationId: OrganizationId;
	actorId: string | null;
	actorKind: string;
	action: string;
	target: string;
	details: Record<string, unknown>;
};

function stubFetch(responses: StubResponse[]) {
	const requestLog: RecordedRequest[] = [];
	const queue = [...responses];
	const impl = mock(
		async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			requestLog.push({
				url: input instanceof Request ? input.url : input.toString(),
				init: init ?? {},
			});
			const next = queue.shift();
			if (next === undefined) {
				throw new Error("unexpected extra fetch call");
			}
			const text = next.rawBody ?? JSON.stringify(next.body ?? {});
			return new Response(text, {
				status: next.status,
				headers: {
					"Content-Type": "application/json",
					...(next.headers ?? {}),
				},
			});
		},
	);
	return { impl, requestLog };
}

function recordingAudit(): { audit: PrCreationAuditSink; calls: AuditCall[] } {
	const calls: AuditCall[] = [];
	const audit: PrCreationAuditSink = {
		append: mock(async (input: AuditCall) => {
			calls.push(input);
			return { id: "audit_1" };
		}) as unknown as PrCreationAuditSink["append"],
	};
	return { audit, calls };
}

/** Builds a creator whose fetch and audit sinks are stubbed and recorded. */
function depsWithResponses(
	responses: StubResponse[],
	overrides: Partial<Parameters<typeof createPrCreator>[0]> = {},
): {
	creator: ReturnType<typeof createPrCreator>;
	requestLog: RecordedRequest[];
	calls: AuditCall[];
} {
	const { impl, requestLog } = stubFetch(responses);
	const { audit, calls } = recordingAudit();
	const creator = createPrCreator({
		credentials: CREDENTIALS,
		audit,
		actor: ACTOR,
		fetchImpl: impl as unknown as typeof fetch,
		...overrides,
	});
	return { creator, requestLog, calls };
}

class AssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssertionError";
	}
}

function expectFailure(
	result: Awaited<
		ReturnType<ReturnType<typeof createPrCreator>["createPullRequest"]>
	>,
): Extract<typeof result, { ok: false }> {
	if (result.ok) {
		throw new AssertionError("expected a failure result but got success");
	}
	return result;
}

function makeDeps(): {
	creator: ReturnType<typeof createPrCreator>;
	requestLog: RecordedRequest[];
	calls: AuditCall[];
} {
	return depsWithResponses([{ status: 201, body: OK_RESPONSE_BODY }]);
}

/**
 * Deny-default spec (§8): the same base request carrying a payload-bound
 * approval computed over `canonicalPullRequestPayload(spec)`, so the connector
 * proceeds past gating to its REST surface.
 */
async function approvedSpec(
	spec: PullRequestSpec = BASE_SPEC,
): Promise<PullRequestSpec> {
	return {
		...spec,
		approvalId: "approval_1",
		approvalPayloadSha256: await sha256Hex(canonicalPullRequestPayload(spec)),
	};
}

describe("extractOwnerRepo", () => {
	test("splits owner/repo and rejects malformed refs", () => {
		expect(extractOwnerRepo("acme/widgets")).toEqual({
			owner: "acme",
			repo: "widgets",
		});
		expect(extractOwnerRepo("noseparator")).toBeNull();
		expect(extractOwnerRepo("/leading")).toBeNull();
		expect(extractOwnerRepo("trailing/")).toBeNull();
	});
});

describe("createPullRequest", () => {
	test("success path builds endpoint, headers, body, and audits SUCCEEDED", async () => {
		const { creator, requestLog, calls } = makeDeps();
		const result = await creator.createPullRequest(await approvedSpec());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.pr).toEqual({
				number: 7,
				url: "https://github.com/acme/widgets/pull/7",
				headBranch: "agent/task-1",
			});
		}

		expect(requestLog).toHaveLength(1);
		const request = requestLog[0] ?? { url: "", init: {} };
		expect(request.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
		expect(request.init.method).toBe("POST");
		const headers = request.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
		expect(headers["User-Agent"]).toBe("isolate-platform");
		expect(JSON.parse(String(request.init.body))).toEqual({
			title: BASE_SPEC.title,
			body: BASE_SPEC.body,
			head: "agent/task-1",
			base: "main",
		});

		expect(calls).toHaveLength(1);
		const auditEntry = calls[0] as AuditCall;
		expect(auditEntry.action).toBe("pr.create");
		expect(auditEntry.target).toBe("repo:acme/widgets");
		expect(`${auditEntry.organizationId}`).toBe("org_test_1");
		expect(auditEntry.actorKind).toBe("worker");
		expect(auditEntry.details.outcome).toBe("SUCCEEDED");
	});

	test("sensitive by default: missing approval returns APPROVAL_REQUIRED with no network call", async () => {
		const { creator, requestLog, calls } = makeDeps();
		const result = await creator.createPullRequest(BASE_SPEC);
		const failure = expectFailure(result);
		expect(failure.code).toBe("APPROVAL_REQUIRED");
		expect(requestLog).toHaveLength(0);

		const auditEntry = calls[0] as AuditCall;
		expect(auditEntry.details.outcome).toBe("BLOCKED");
		expect(auditEntry.details.code).toBe("APPROVAL_REQUIRED");
	});

	test("payload-bound approval satisfied: approvalId + sha proceed to REST", async () => {
		const approvalPayloadSha256 = await sha256Hex(
			canonicalPullRequestPayload(BASE_SPEC),
		);
		const { creator, requestLog } = makeDeps();
		const result = await creator.createPullRequest({
			...BASE_SPEC,
			approvalId: "approval_1",
			approvalPayloadSha256,
		});

		expect(result.ok).toBe(true);
		expect(requestLog).toHaveLength(1);
	});

	test("approval bound to a different payload is rejected before any call", async () => {
		const { creator, requestLog } = makeDeps();
		const result = await creator.createPullRequest({
			...BASE_SPEC,
			approvalId: "approval_1",
			approvalPayloadSha256: "0".repeat(64),
		});

		const failure = expectFailure(result);
		expect(failure.code).toBe("APPROVAL_REQUIRED");
		expect(requestLog).toHaveLength(0);
	});

	test("non-sensitive classification by trusted policy skips approval", async () => {
		const { creator, requestLog } = depsWithResponses(
			[{ status: 201, body: OK_RESPONSE_BODY }],
			{ isSensitive: () => false },
		);
		const result = await creator.createPullRequest(BASE_SPEC);

		expect(result.ok).toBe(true);
		expect(requestLog).toHaveLength(1);
	});

	test("spec validation rejects empty branches and unknown keys with no network call", async () => {
		const { creator, requestLog, calls } = depsWithResponses([
			{ status: 201, body: OK_RESPONSE_BODY },
		]);
		const emptyBranch = await creator.createPullRequest({
			...BASE_SPEC,
			headBranch: "",
		});
		const emptyFailure = expectFailure(emptyBranch);
		expect(emptyFailure.code).toBe("VALIDATION_FAILED");
		expect(emptyFailure.message).toContain("headBranch");

		const unknownKey = await creator.createPullRequest({
			...BASE_SPEC,
			approvalId: "approval_1",
			approvalPayloadSha256: await sha256Hex(
				canonicalPullRequestPayload(BASE_SPEC),
			),
			...({ rogue: "field" } as unknown as PullRequestSpec),
		});
		const unknownFailure = expectFailure(unknownKey);
		expect(unknownFailure.code).toBe("VALIDATION_FAILED");

		expect(requestLog).toHaveLength(0);
		expect(calls).toHaveLength(2);
		for (const auditEntry of calls) {
			expect(auditEntry.details.outcome).toBe("BLOCKED");
			expect(auditEntry.details.code).toBe("VALIDATION_FAILED");
		}
	});

	test.each([
		[
			403,
			{ message: `forbidden, token ${FABRICATED_TOKEN} bad` },
			"POLICY_DENIED",
		],
		[404, { message: "Not Found" }, "NOT_FOUND"],
		[422, { message: "Validation Failed" }, "VALIDATION_FAILED"],
	])("status %i maps to %s with redacted provider message", async (status, body, expectedCode) => {
		// Explicit non-sensitive classification: this suite covers status
		// mapping, not approval gating (deny-default is covered above).
		const { creator, requestLog } = depsWithResponses([{ status, body }], {
			isSensitive: () => false,
		});
		const result = await creator.createPullRequest(BASE_SPEC);
		const failure = expectFailure(result);
		expect(failure.code).toBe(expectedCode as PullRequestFailureCode);
		expect(failure.message).toBeDefined();
		expect(failure.message).not.toContain(FABRICATED_TOKEN);
		expect(failure.message).not.toContain(INSTALLATION_TOKEN);
		expect(requestLog).toHaveLength(1);
	});

	test("429 maps to RATE_LIMITED and surfaces the retry-after hint", async () => {
		const { creator } = depsWithResponses(
			[
				{
					status: 429,
					body: { message: "API rate limit exceeded" },
					headers: { "retry-after": "30" },
				},
			],
			{ isSensitive: () => false },
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("RATE_LIMITED");
		expect(failure.message).toContain("rate limited");
		expect(failure.message).toContain("retry after 30s");
	});

	test.each([
		[401, { message: "Bad credentials" }],
		[500, { message: "internal boom" }],
	])("status %i maps to INTEGRATION_UNAVAILABLE", async (status, body) => {
		const { creator } = depsWithResponses([{ status, body }], {
			isSensitive: () => false,
		});
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});

	test("unmapped 4xx denies by default (POLICY_DENIED)", async () => {
		const { creator } = depsWithResponses(
			[{ status: 418, body: { message: "teapot" } }],
			{ isSensitive: () => false },
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("POLICY_DENIED");
	});

	test("malformed JSON on success status maps to INTEGRATION_UNAVAILABLE", async () => {
		const { creator } = depsWithResponses(
			[{ status: 201, rawBody: "not json {" }],
			{ isSensitive: () => false },
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});

	test("response failing the zod contract maps to INTEGRATION_UNAVAILABLE", async () => {
		const { creator } = depsWithResponses(
			[
				{
					status: 201,
					body: {
						number: "seven",
						html_url: "https://github.com/x/y/pull/1",
						head: { ref: "x" },
					},
				},
			],
			{ isSensitive: () => false },
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});
});

describe("credential redaction through every Result path", () => {
	test("fabricated token-like throwables never propagate through the Result", async () => {
		const { creator, calls } = depsWithResponses(
			[{ status: 201, body: OK_RESPONSE_BODY }],
			{
				isSensitive: () => false,
				fetchImpl: (async () => {
					throw new Error(
						`request to https://api.github.com failed: Bearer ${FABRICATED_TOKEN}`,
					);
				}) as unknown as typeof fetch,
			},
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(failure.message).not.toContain(FABRICATED_TOKEN);
		expect(failure.message).not.toContain("ghp_fabricated");
		expect(JSON.stringify(calls)).not.toContain(FABRICATED_TOKEN);
	});

	test("timeout throwables are recognized and audited without content spill", async () => {
		const { creator, calls } = depsWithResponses(
			[{ status: 201, body: OK_RESPONSE_BODY }],
			{
				isSensitive: () => false,
				fetchImpl: (() => {
					throw Object.assign(new Error("The operation was aborted"), {
						name: "TimeoutError",
					});
				}) as unknown as typeof fetch,
			},
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(failure.message).toContain("timed out");

		const auditEntry = calls[0] as AuditCall;
		expect(auditEntry.details.outcome).toBe("FAILED");
	});

	test("provider errors echoing the injected credential are scrubbed", async () => {
		const { creator } = depsWithResponses(
			[
				{
					status: 403,
					body: { message: `your token ${INSTALLATION_TOKEN} expired` },
				},
			],
			{ isSensitive: () => false },
		);
		const failure = expectFailure(await creator.createPullRequest(BASE_SPEC));
		expect(failure.code).toBe("POLICY_DENIED");
		expect(failure.message).not.toContain(INSTALLATION_TOKEN);
		expect(failure.message).toContain("[token-redacted]");
	});

	test("audit sink failures never change the connector result", async () => {
		const failingAudit: PrCreationAuditSink = {
			append: () => Promise.reject(new Error("audit store down")),
		};
		const { impl, requestLog } = stubFetch([
			{ status: 201, body: OK_RESPONSE_BODY },
		]);
		const creator = createPrCreator({
			credentials: CREDENTIALS,
			audit: failingAudit,
			actor: ACTOR,
			isSensitive: () => false,
			fetchImpl: impl as unknown as typeof fetch,
		});
		const result = await creator.createPullRequest(BASE_SPEC);
		expect(result.ok).toBe(true);
		expect(requestLog).toHaveLength(1);
	});
});
