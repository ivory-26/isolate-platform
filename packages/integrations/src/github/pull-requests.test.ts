import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
	type OrganizationId,
	PlatformError,
	type PullRequestRecord,
	pullRequestRecordSchema,
} from "@isolate/shared";
import {
	createGitHubAppTokenProvider,
	type GitHubInstallationToken,
	type GitHubInstallationTokenRequest,
} from "./auth";
import {
	canonicalPullRequestApprovalPayload,
	createPullRequestForTask,
	pullRequestApprovalPayloadSha256,
} from "./pull-requests";
import type { CreatePullRequestInput } from "./schemas";
import type {
	PrCreationAuditSink,
	PullRequestCreationDependencies,
	PullRequestCreationResult,
} from "./types";

const APP_ID = "123456";
const INSTALLATION_ID = "987654";
const REPOSITORY = "acme/widgets";
const NOW_MS = 1_760_000_000_000;
const EXPIRES_AT = new Date(NOW_MS + 3_600_000).toISOString();
const TOKEN = "ghs_w8gh_installation_0123456789abcdef";
const FABRICATED_TOKEN = "ghp_fabricated1234567890abc";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const ACTOR = {
	organizationId: "org_test_1" as OrganizationId,
	actorId: "task_attempt_1",
	actorKind: "worker" as const,
};

const BASE_INPUT: Omit<CreatePullRequestInput, "expectedPayloadSha256"> = {
	repositoryFullName: REPOSITORY,
	headBranch: "agent/task-1",
	baseBranch: "main",
	headSha: HEAD_SHA,
	title: "feat: add widget",
	body: "does the thing",
};

let privateKeyPem: string;

beforeAll(async () => {
	const keyPair = (await globalThis.crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = await globalThis.crypto.subtle.exportKey(
		"pkcs8",
		keyPair.privateKey,
	);
	privateKeyPem = derToPem("PRIVATE KEY", new Uint8Array(pkcs8));
});

function derToPem(label: string, der: Uint8Array): string {
	const base64 = Buffer.from(der).toString("base64");
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

type StubResponse = {
	status: number;
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
};

type Scenario = {
	token?: StubResponse;
	ref?: StubResponse;
	list?: StubResponse;
	create?: StubResponse;
	/** When set, a POST to /pulls throws this message instead of responding. */
	throwOnCreate?: string;
};

type RecordedRequest = { url: string; method: string; init: RequestInit };

type AuditCall = {
	organizationId: OrganizationId;
	actorId: string | null;
	actorKind: string;
	action: string;
	target: string;
	details: Record<string, unknown>;
};

const TOKEN_RESPONSE: StubResponse = {
	status: 201,
	body: { token: TOKEN, expires_at: EXPIRES_AT },
};

function refResponse(sha = HEAD_SHA): StubResponse {
	return {
		status: 200,
		body: { ref: "refs/heads/agent/task-1", object: { sha } },
	};
}

function prBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		number: 7,
		html_url: "https://github.com/acme/widgets/pull/7",
		head: { ref: "agent/task-1", sha: HEAD_SHA },
		base: { ref: "main" },
		...overrides,
	};
}

function toResponse(stub: StubResponse): Response {
	const text = stub.rawBody ?? JSON.stringify(stub.body ?? {});
	return new Response(text, {
		status: stub.status,
		headers: {
			"Content-Type": "application/json",
			...(stub.headers ?? {}),
		},
	});
}

/** Fake GitHub: token exchange, ref lookup, PR list, PR create. No network. */
function fakeGitHub(scenario: Scenario = {}): {
	impl: typeof fetch;
	calls: RecordedRequest[];
} {
	const calls: RecordedRequest[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const method = (init?.method ?? "GET").toUpperCase();
		calls.push({ url, method, init: init ?? {} });
		const path = new URL(url).pathname;
		if (path.endsWith("/access_tokens")) {
			return toResponse(scenario.token ?? TOKEN_RESPONSE);
		}
		if (path.includes("/git/ref/heads/")) {
			return toResponse(scenario.ref ?? refResponse());
		}
		if (method === "POST" && path.endsWith("/pulls")) {
			if (scenario.throwOnCreate !== undefined) {
				throw new Error(scenario.throwOnCreate);
			}
			return toResponse(scenario.create ?? { status: 201, body: prBody() });
		}
		if (method === "GET" && path.endsWith("/pulls")) {
			return toResponse(scenario.list ?? { status: 200, body: [] });
		}
		throw new Error(`unexpected request ${method} ${url}`);
	};
	return { impl: impl as unknown as typeof fetch, calls };
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

function buildService(
	scenario: Scenario = {},
	overrides: Partial<PullRequestCreationDependencies> = {},
): {
	deps: PullRequestCreationDependencies;
	calls: RecordedRequest[];
	auditCalls: AuditCall[];
} {
	const { impl, calls } = fakeGitHub(scenario);
	const { audit, calls: auditCalls } = recordingAudit();
	const deps: PullRequestCreationDependencies = {
		tokenProvider: createGitHubAppTokenProvider({
			appId: APP_ID,
			privateKeyPem,
			installationId: INSTALLATION_ID,
			fetchImpl: impl,
			now: () => NOW_MS,
		}),
		audit,
		actor: ACTOR,
		fetchImpl: impl,
		now: () => NOW_MS,
		...overrides,
	};
	return { deps, calls, auditCalls };
}

/** Input carrying the hash the worker would have persisted with the approval. */
async function approvedInput(
	overrides: Partial<CreatePullRequestInput> = {},
): Promise<CreatePullRequestInput> {
	const base = { ...BASE_INPUT, ...overrides };
	const expectedPayloadSha256 =
		overrides.expectedPayloadSha256 ??
		(await pullRequestApprovalPayloadSha256(base));
	return { ...base, expectedPayloadSha256 };
}

class AssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssertionError";
	}
}

function expectFailure(
	result: PullRequestCreationResult,
): Extract<PullRequestCreationResult, { ok: false }> {
	if (result.ok) {
		throw new AssertionError("expected a failure result but got success");
	}
	return result;
}

function expectSuccess(
	result: PullRequestCreationResult,
): Extract<PullRequestCreationResult, { ok: true }> {
	if (!result.ok) {
		throw new AssertionError(
			`expected success but got ${result.code}: ${result.message ?? ""}`,
		);
	}
	return result;
}

describe("canonicalPullRequestApprovalPayload", () => {
	test("locks the exact four-field payload and key order the worker binds", () => {
		const canonical = canonicalPullRequestApprovalPayload(BASE_INPUT);
		expect(canonical).toBe(
			`{"repositoryFullName":"acme/widgets","headBranch":"agent/task-1","baseBranch":"main","headSha":"${HEAD_SHA}"}`,
		);
	});

	test("hashes to a stable lowercase SHA-256", async () => {
		const digest = await pullRequestApprovalPayloadSha256(BASE_INPUT);
		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		await expect(pullRequestApprovalPayloadSha256(BASE_INPUT)).resolves.toBe(
			digest,
		);
	});
});

describe("createPullRequestForTask", () => {
	test("creates one PR with a repo-scoped token and returns the shared record", async () => {
		const { deps, calls, auditCalls } = buildService();
		const result = expectSuccess(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(result.created).toBe(true);
		expect(result.pullRequest).toEqual({
			number: 7,
			url: "https://github.com/acme/widgets/pull/7",
			headBranch: "agent/task-1",
			baseBranch: "main",
			headSha: HEAD_SHA,
		} satisfies PullRequestRecord);

		expect(calls).toHaveLength(4);
		// 1. token exchange, repo-scoped with contents + pull_requests write.
		const tokenCall = calls[0] as RecordedRequest;
		expect(tokenCall.url).toBe(
			`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
		);
		expect(JSON.parse(String(tokenCall.init.body))).toEqual({
			repository: "widgets",
			permissions: { contents: "write", pull_requests: "write" },
		});
		// 2. head ref lookup.
		expect(calls[1]?.url).toBe(
			"https://api.github.com/repos/acme/widgets/git/ref/heads/agent/task-1",
		);
		expect(calls[1]?.method).toBe("GET");
		// 3. idempotency lookup scoped to this head branch.
		expect(calls[2]?.url).toBe(
			"https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Aagent%2Ftask-1",
		);
		// 4. create.
		const createCall = calls[3] as RecordedRequest;
		expect(createCall.url).toBe(
			"https://api.github.com/repos/acme/widgets/pulls",
		);
		expect(createCall.method).toBe("POST");
		expect(JSON.parse(String(createCall.init.body))).toEqual({
			title: BASE_INPUT.title,
			body: BASE_INPUT.body,
			head: "agent/task-1",
			base: "main",
		});

		for (const call of calls) {
			expect(call.url).not.toContain(TOKEN);
			expect(String(call.init.body ?? "")).not.toContain(TOKEN);
		}
		const headers = createCall.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
		expect(headers["User-Agent"]).toBe("isolate-platform");
		expect(headers["Content-Type"]).toBe("application/json");

		expect(auditCalls).toHaveLength(1);
		const auditEntry = auditCalls[0] as AuditCall;
		expect(auditEntry.action).toBe("pr.create");
		expect(auditEntry.target).toBe("repo:acme/widgets");
		expect(`${auditEntry.organizationId}`).toBe("org_test_1");
		expect(auditEntry.actorKind).toBe("worker");
		expect(auditEntry.details.outcome).toBe("SUCCEEDED");
		expect(auditEntry.details.idempotent).toBe(false);
		expect(auditEntry.details.pullRequestNumber).toBe(7);
		expect(JSON.stringify(auditEntry)).not.toContain(TOKEN);
	});

	test("redelivery returns the already-open PR for the head branch and never posts", async () => {
		const { deps, calls, auditCalls } = buildService({
			list: { status: 200, body: [prBody()] },
		});
		const result = expectSuccess(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(result.created).toBe(false);
		expect(result.pullRequest.number).toBe(7);
		expect(result.pullRequest.headSha).toBe(HEAD_SHA);
		expect(calls).toHaveLength(3);
		expect(
			calls.some(
				(call) => call.method === "POST" && call.url.endsWith("/pulls"),
			),
		).toBe(false);

		const auditEntry = auditCalls[0] as AuditCall;
		expect(auditEntry.details.outcome).toBe("SUCCEEDED");
		expect(auditEntry.details.idempotent).toBe(true);
	});

	test("ignores list entries for a different head ref", async () => {
		const { deps, calls } = buildService({
			list: {
				status: 200,
				body: [prBody({ head: { ref: "someone-else:fork", sha: HEAD_SHA } })],
			},
			create: { status: 201, body: prBody({ number: 8 }) },
		});
		const result = expectSuccess(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(result.created).toBe(true);
		expect(result.pullRequest.number).toBe(8);
		expect(calls).toHaveLength(4);
		expect(calls[3]?.method).toBe("POST");
	});

	test("refuses a remote head that is not the approved commit, before listing or posting", async () => {
		const { deps, calls, auditCalls } = buildService({
			ref: refResponse(OTHER_SHA),
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("POLICY_DENIED");
		expect(failure.message).toContain("does not match the approved commit");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toContain("/git/ref/heads/");
		expect(calls.some((call) => call.url.includes("/pulls"))).toBe(false);

		expect(auditCalls[0]?.details.outcome).toBe("BLOCKED");
		expect(auditCalls[0]?.details.code).toBe("POLICY_DENIED");
	});

	test("refuses a payload-SHA mismatch before any fetch", async () => {
		const { deps, calls, auditCalls } = buildService();
		const failure = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ expectedPayloadSha256: "0".repeat(64) }),
			),
		);

		expect(failure.code).toBe("APPROVAL_REQUIRED");
		expect(failure.message).toContain("re-approval required");
		expect(calls).toHaveLength(0);
		expect(auditCalls[0]?.details.outcome).toBe("BLOCKED");
	});

	test("approval bound to a different head commit is also refused before any fetch", async () => {
		const approvedForOther = await approvedInput({ headSha: OTHER_SHA });
		const { deps, calls } = buildService();
		const failure = expectFailure(
			await createPullRequestForTask(deps, {
				...approvedForOther,
				headSha: HEAD_SHA,
			}),
		);

		expect(failure.code).toBe("APPROVAL_REQUIRED");
		expect(calls).toHaveLength(0);
	});

	test.each([
		[401, "INTEGRATION_UNAVAILABLE"],
		[403, "POLICY_DENIED"],
		[404, "NOT_FOUND"],
		[409, "POLICY_DENIED"],
		[422, "VALIDATION_FAILED"],
		[429, "RATE_LIMITED"],
	] as const)("create status %i maps to %s", async (status, expectedCode) => {
		const { deps, calls } = buildService({
			create: {
				status,
				body: { message: `provider said no to ${TOKEN}` },
				headers: status === 429 ? { "retry-after": "30" } : {},
			},
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe(expectedCode);
		expect(failure.message).toBeDefined();
		expect(failure.message).not.toContain(TOKEN);
		expect(failure.message).toContain("[token-redacted]");
		expect(calls).toHaveLength(4);
		if (status === 429) {
			expect(failure.message).toContain("rate limited");
			expect(failure.message).toContain("retry after 30s");
		}
	});

	test("ref lookup 404 maps to NOT_FOUND and stops before the PR list", async () => {
		const { deps, calls } = buildService({
			ref: { status: 404, body: { message: "Not Found" } },
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("NOT_FOUND");
		expect(calls).toHaveLength(2);
	});

	test("PR list 403 maps to POLICY_DENIED and stops before create", async () => {
		const { deps, calls } = buildService({
			list: { status: 403, body: { message: "forbidden" } },
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("POLICY_DENIED");
		expect(calls).toHaveLength(3);
	});

	test("a thrown fetch error is mapped and redacted, including URL userinfo", async () => {
		const { deps } = buildService({
			throwOnCreate: `request failed with Bearer ${TOKEN}, ${FABRICATED_TOKEN} at https://user:pass@api.github.com/repos`,
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(failure.message).not.toContain(TOKEN);
		expect(failure.message).not.toContain(FABRICATED_TOKEN);
		expect(failure.message).not.toContain("user:pass");
		expect(failure.message).toContain("//[credentials-redacted]@");
	});

	test("malformed create response maps to INTEGRATION_UNAVAILABLE", async () => {
		const { deps } = buildService({
			create: {
				status: 201,
				body: {
					number: 7,
					html_url: "https://github.com/acme/widgets/pull/7",
					head: { ref: "agent/task-1", sha: HEAD_SHA },
				},
			},
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});

	test("a non-https PR URL is refused by the shared record contract", async () => {
		const { deps } = buildService({
			create: {
				status: 201,
				body: prBody({ html_url: "http://github.com/acme/widgets/pull/7" }),
			},
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});

	test("malformed PR list maps to INTEGRATION_UNAVAILABLE", async () => {
		const { deps } = buildService({
			list: { status: 200, body: { not: "an array" } },
		});
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);
		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
	});
});

describe("bounds and credential hygiene", () => {
	test("title is capped at 256 and body at 20000 before any call", async () => {
		const { deps, calls } = buildService();
		const longTitle = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ title: "t".repeat(257) }),
			),
		);
		expect(longTitle.code).toBe("VALIDATION_FAILED");
		expect(longTitle.message).toContain("title");

		const longBody = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ body: "b".repeat(20_001) }),
			),
		);
		expect(longBody.code).toBe("VALIDATION_FAILED");
		expect(longBody.message).toContain("body");
		expect(calls).toHaveLength(0);
	});

	test("accepts the exact title and body bounds", async () => {
		const { deps } = buildService();
		const result = expectSuccess(
			await createPullRequestForTask(
				deps,
				await approvedInput({
					title: "t".repeat(256),
					body: "b".repeat(20_000),
				}),
			),
		);
		expect(result.created).toBe(true);
	});

	test("refuses a malformed head SHA before any call", async () => {
		const { deps, calls } = buildService();
		const failure = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ headSha: "not-a-sha" }),
			),
		);
		expect(failure.code).toBe("VALIDATION_FAILED");
		expect(calls).toHaveLength(0);
	});

	test("refuses credential-shaped title/body before any call", async () => {
		const { deps, calls } = buildService();
		const failure = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ body: `leaked ${FABRICATED_TOKEN}` }),
			),
		);
		expect(failure.code).toBe("VALIDATION_FAILED");
		expect(failure.message).toContain("credentials");
		expect(calls).toHaveLength(0);
	});

	test("refuses a title containing the minted token before the ref lookup", async () => {
		const { deps, calls } = buildService();
		const failure = expectFailure(
			await createPullRequestForTask(
				deps,
				await approvedInput({ title: `chore: rotate ${TOKEN}` }),
			),
		);
		expect(failure.code).toBe("VALIDATION_FAILED");
		expect(failure.message).not.toContain(TOKEN);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/access_tokens");
	});
});

describe("token seam", () => {
	test("rejects an already-expired minted token without using it", async () => {
		const requests: GitHubInstallationTokenRequest[] = [];
		const expired: GitHubInstallationToken = {
			token: TOKEN,
			expiresAt: new Date(NOW_MS - 1_000).toISOString(),
		};
		const { deps, calls } = buildService(
			{},
			{
				tokenProvider: {
					getInstallationToken: async (request) => {
						requests.push(request);
						return expired;
					},
				},
			},
		);
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(failure.message).toContain("unusable installation token");
		expect(calls).toHaveLength(0);
		expect(requests).toEqual([
			{
				repositoryFullName: REPOSITORY,
				contents: "write",
				pullRequests: "write",
			},
		]);
	});

	test("maps a token-broker PlatformError to the union and never echoes it", async () => {
		const { deps, calls } = buildService(
			{},
			{
				tokenProvider: {
					getInstallationToken: async () => {
						throw new PlatformError(
							"MISSING_CONFIG",
							"github app private key is missing",
						);
					},
				},
			},
		);
		const failure = expectFailure(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(failure.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(failure.message).toBe(
			"github installation token could not be minted",
		);
		expect(calls).toHaveLength(0);
	});
});

describe("shared record contract", () => {
	test("the returned record parses through pullRequestRecordSchema", async () => {
		const { deps } = buildService();
		const result = expectSuccess(
			await createPullRequestForTask(deps, await approvedInput()),
		);

		expect(pullRequestRecordSchema.safeParse(result.pullRequest).success).toBe(
			true,
		);
		expect(Object.keys(result.pullRequest).sort()).toEqual([
			"baseBranch",
			"headBranch",
			"headSha",
			"number",
			"url",
		]);
		expect(JSON.stringify(result.pullRequest)).not.toContain(TOKEN);
	});
});
