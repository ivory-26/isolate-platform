import { beforeAll, describe, expect, test } from "bun:test";
import { type ErrorCode, PlatformError } from "@isolate/shared";
import {
	createGitHubAppTokenProvider,
	type GitHubInstallationTokenRequest,
	type GitHubRepoPermission,
	type GitHubTokenProviderOptions,
	toGitHubCredentials,
} from "./auth";

const APP_ID = "123456";
const INSTALLATION_ID = "987654";
const REPOSITORY = "acme/widgets";
const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const EXPIRES_AT = new Date(NOW_MS + 3_600_000).toISOString();
const TOKEN_A = "ghs_w7gh_token_aaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "ghs_w7gh_token_bbbbbbbbbbbbbbbbbbbb";

const REQUEST: GitHubInstallationTokenRequest = {
	repositoryFullName: REPOSITORY,
	contents: "write",
	pullRequests: "write",
};

let publicKey: CryptoKey;
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
	publicKey = keyPair.publicKey;
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

type FetchCall = { url: string; init: RequestInit };

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

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function tokenBody(token: string, expiresAt = EXPIRES_AT): unknown {
	return { token, expires_at: expiresAt };
}

function providerFor(
	impl: typeof fetch,
	overrides: Partial<GitHubTokenProviderOptions> = {},
): ReturnType<typeof createGitHubAppTokenProvider> {
	return createGitHubAppTokenProvider({
		appId: APP_ID,
		privateKeyPem,
		installationId: INSTALLATION_ID,
		fetchImpl: impl,
		now: () => NOW_MS,
		...overrides,
	});
}

function decodeBase64Url(segment: string): string {
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	return atob(padded);
}

function decodeJson(segment: string): unknown {
	const parsed: unknown = JSON.parse(decodeBase64Url(segment));
	return parsed;
}

type JwtHeader = { alg: string; typ: string };
type JwtPayload = { iat: number; exp: number; iss: string };

async function verifyAppJwt(
	jwt: string,
): Promise<{ header: JwtHeader; payload: JwtPayload }> {
	const segments = jwt.split(".");
	expect(segments).toHaveLength(3);
	const headerSegment = segments[0];
	const payloadSegment = segments[1];
	const signatureBinary = decodeBase64Url(segments[2]);
	const signature = new Uint8Array(signatureBinary.length);
	for (let index = 0; index < signatureBinary.length; index += 1) {
		signature[index] = signatureBinary.charCodeAt(index);
	}
	const valid = await globalThis.crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		publicKey,
		signature,
		new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
	);
	expect(valid).toBe(true);
	return {
		header: decodeJson(headerSegment) as JwtHeader,
		payload: decodeJson(payloadSegment) as JwtPayload,
	};
}

function authJwt(call: FetchCall): string {
	const headers = call.init.headers as Record<string, string>;
	expect(headers.Authorization.startsWith("Bearer ")).toBe(true);
	return headers.Authorization.slice("Bearer ".length);
}

async function captureError(promise: Promise<unknown>): Promise<PlatformError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof PlatformError) {
			return error;
		}
		throw error;
	}
	throw new Error("expected the provider to fail");
}

describe("createGitHubAppTokenProvider", () => {
	test("mints a repository-scoped token with a signed RS256 app JWT", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, tokenBody(TOKEN_A)),
		);
		const provider = providerFor(impl);

		const token = await provider.getInstallationToken(REQUEST);

		expect(token).toEqual({ token: TOKEN_A, expiresAt: EXPIRES_AT });
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.url).toBe(
			`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
		);
		expect(call.url.includes(TOKEN_A)).toBe(false);
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.Accept).toBe("application/vnd.github+json");
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
		expect(headers["Content-Type"]).toBe("application/json");
		const body: unknown = JSON.parse(String(call.init.body));
		expect(body).toEqual({
			repository: "widgets",
			permissions: { contents: "write", pull_requests: "write" },
		});

		const { header, payload } = await verifyAppJwt(authJwt(call));
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
		expect(payload).toEqual({
			iat: NOW_SECONDS - 60,
			exp: NOW_SECONDS + 600,
			iss: APP_ID,
		});
	});

	test("requests only contents when pull_requests is not asked for", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, tokenBody(TOKEN_A)),
		);
		const provider = providerFor(impl);

		await provider.getInstallationToken({
			repositoryFullName: REPOSITORY,
			contents: "read",
		});

		const body: unknown = JSON.parse(String(calls[0].init.body));
		expect(body).toEqual({
			repository: "widgets",
			permissions: { contents: "read" },
		});
	});

	test("serves a cached token after the first exchange", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, tokenBody(TOKEN_A)),
		);
		const provider = providerFor(impl);

		const first = await provider.getInstallationToken(REQUEST);
		const second = await provider.getInstallationToken({ ...REQUEST });

		expect(calls).toHaveLength(1);
		expect(second).toEqual(first);
	});

	test("caches each permission set independently", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, tokenBody(TOKEN_A)),
		);
		const provider = providerFor(impl);

		await provider.getInstallationToken({
			repositoryFullName: REPOSITORY,
			contents: "read",
		});
		await provider.getInstallationToken({
			repositoryFullName: REPOSITORY,
			contents: "write",
		});

		expect(calls).toHaveLength(2);
	});

	test("refreshes once the cache reaches expires_at minus 300s", async () => {
		let issued = 0;
		let current = NOW_MS;
		const { impl, calls } = recordingFetch(() => {
			issued += 1;
			return jsonResponse(201, tokenBody(issued === 1 ? TOKEN_A : TOKEN_B));
		});
		const provider = providerFor(impl, { now: () => current });

		const first = await provider.getInstallationToken(REQUEST);
		expect(first.token).toBe(TOKEN_A);

		current = NOW_MS + 3_600_000 - 300_000 + 1;
		const second = await provider.getInstallationToken(REQUEST);

		expect(second.token).toBe(TOKEN_B);
		expect(calls).toHaveLength(2);
	});

	test("coalesces concurrent requests into one exchange", async () => {
		const { impl, calls } = recordingFetch(async () => {
			await Promise.resolve();
			return jsonResponse(201, tokenBody(TOKEN_A));
		});
		const provider = providerFor(impl);

		const [first, second] = await Promise.all([
			provider.getInstallationToken(REQUEST),
			provider.getInstallationToken(REQUEST),
		]);

		expect(calls).toHaveLength(1);
		expect(second).toEqual(first);
	});

	test("honors a custom apiBaseUrl", async () => {
		const { impl, calls } = recordingFetch(() =>
			jsonResponse(201, tokenBody(TOKEN_A)),
		);
		const provider = providerFor(impl, {
			apiBaseUrl: "https://ghe.example.test/api/v3/",
		});

		await provider.getInstallationToken(REQUEST);

		expect(calls[0].url).toBe(
			`https://ghe.example.test/api/v3/app/installations/${INSTALLATION_ID}/access_tokens`,
		);
	});
});

describe("status mapping", () => {
	const mappings: ReadonlyArray<readonly [number, ErrorCode]> = [
		[401, "INTEGRATION_UNAVAILABLE"],
		[403, "POLICY_DENIED"],
		[404, "NOT_FOUND"],
		[429, "RATE_LIMITED"],
		[422, "AGENT_EXECUTION_FAILED"],
		[500, "INTEGRATION_UNAVAILABLE"],
	];

	for (const [status, code] of mappings) {
		test(`maps ${status} to ${code}`, async () => {
			const { impl } = recordingFetch(() =>
				jsonResponse(status, { message: "provider detail" }),
			);
			const error = await captureError(
				providerFor(impl).getInstallationToken(REQUEST),
			);

			expect(error.code).toBe(code);
			expect(error.message.includes("provider detail")).toBe(false);
		});
	}
});

describe("bounded failures", () => {
	test("never echoes response bodies or tokens in errors", async () => {
		const leakedToken = "ghs_leaked_response_token_0123456789";
		const { impl } = recordingFetch(() =>
			jsonResponse(401, {
				message: `Bad credentials for ${leakedToken}`,
				documentation_url: "https://docs.example.test/secret",
			}),
		);
		const error = await captureError(
			providerFor(impl).getInstallationToken(REQUEST),
		);

		expect(error.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(error.message.includes(leakedToken)).toBe(false);
		expect(error.message.includes("Bad credentials")).toBe(false);
		expect(error.message.includes("docs.example.test")).toBe(false);
	});

	test("maps network failures without echoing the cause", async () => {
		const { impl } = recordingFetch(() => {
			throw new Error("socket closed for ghs_leaked_network_secret");
		});
		const error = await captureError(
			providerFor(impl).getInstallationToken(REQUEST),
		);

		expect(error.code).toBe("AGENT_EXECUTION_FAILED");
		expect(error.message.includes("ghs_leaked_network_secret")).toBe(false);
	});

	const untrustedResponses: ReadonlyArray<readonly [string, string]> = [
		["a missing token", JSON.stringify({ expires_at: EXPIRES_AT })],
		["an empty token", JSON.stringify({ token: "", expires_at: EXPIRES_AT })],
		[
			"an expired expiry",
			JSON.stringify({
				token: TOKEN_A,
				expires_at: new Date(NOW_MS).toISOString(),
			}),
		],
		[
			"an unparseable expiry",
			JSON.stringify({ token: TOKEN_A, expires_at: "not-a-date" }),
		],
		["a non-JSON body", "not json"],
	];

	for (const [label, rawBody] of untrustedResponses) {
		test(`rejects ${label} as INTEGRATION_UNAVAILABLE`, async () => {
			const { impl } = recordingFetch(
				() => new Response(rawBody, { status: 201 }),
			);
			const error = await captureError(
				providerFor(impl).getInstallationToken(REQUEST),
			);

			expect(error.code).toBe("INTEGRATION_UNAVAILABLE");
			expect(error.message.includes(TOKEN_A)).toBe(false);
		});
	}
});

describe("configuration fails closed", () => {
	const fetchStub = (async () => new Response()) as unknown as typeof fetch;
	const cases: ReadonlyArray<
		readonly [string, Partial<GitHubTokenProviderOptions>]
	> = [
		["a non-numeric appId", { appId: "app-1" }],
		["a zero appId", { appId: "0" }],
		["a non-numeric installationId", { installationId: "12x" }],
		["a negative installationId", { installationId: "-1" }],
		["a PEM without PKCS#8 markers", { privateKeyPem: "not a pem" }],
		[
			"a PKCS#1 PEM",
			{
				privateKeyPem:
					"-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
			},
		],
		[
			"a credentialed apiBaseUrl",
			{ apiBaseUrl: "https://user:pass@example.test" },
		],
		["a non-http apiBaseUrl", { apiBaseUrl: "ftp://example.test" }],
		["a query-bearing apiBaseUrl", { apiBaseUrl: "https://example.test?x=1" }],
	];

	for (const [label, overrides] of cases) {
		test(`rejects ${label}`, () => {
			let thrown: unknown;
			try {
				providerFor(fetchStub, overrides);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(PlatformError);
			const error = thrown as PlatformError;
			expect(error.code).toBe("MISSING_CONFIG");
			expect(error.message.includes("PRIVATE KEY")).toBe(false);
		});
	}
});

describe("request validation", () => {
	const cases: ReadonlyArray<
		readonly [string, GitHubInstallationTokenRequest]
	> = [
		[
			"a repository without an owner",
			{ repositoryFullName: "widgets", contents: "read" },
		],
		[
			"an extra path segment",
			{ repositoryFullName: "acme/widgets/extra", contents: "read" },
		],
		[
			"an unknown contents permission",
			{
				repositoryFullName: REPOSITORY,
				contents: "admin" as unknown as GitHubRepoPermission,
			},
		],
		[
			"an unknown pull_requests permission",
			{
				repositoryFullName: REPOSITORY,
				contents: "read",
				pullRequests: "admin" as unknown as GitHubRepoPermission,
			},
		],
	];

	for (const [label, request] of cases) {
		test(`rejects ${label} without fetching`, async () => {
			const { impl, calls } = recordingFetch(() =>
				jsonResponse(201, tokenBody(TOKEN_A)),
			);
			const error = await captureError(
				providerFor(impl).getInstallationToken(request),
			);

			expect(error.code).toBe("VALIDATION_FAILED");
			expect(calls).toHaveLength(0);
		});
	}
});

describe("toGitHubCredentials", () => {
	test("adapts a minted token into the creator credential shape", () => {
		expect(
			toGitHubCredentials({ token: TOKEN_A, expiresAt: EXPIRES_AT }),
		).toEqual({ installationToken: TOKEN_A, passwordless: true });
	});

	test("fails closed on an empty token", () => {
		expect(() =>
			toGitHubCredentials({ token: "", expiresAt: EXPIRES_AT }),
		).toThrow(PlatformError);
	});
});
