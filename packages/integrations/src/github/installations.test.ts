import { beforeAll, describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	createGitHubAppClient,
	createGitHubInstallationTokenResolver,
	type GitHubAppCredentials,
} from "./auth";
import {
	listInstallationRepositories,
	MAX_INSTALLATION_BRANCH_CHARS,
	MAX_INSTALLATION_REPOSITORIES,
	MAX_INSTALLATION_REPOSITORY_NAME_CHARS,
} from "./installations";

const APP_ID = "123456";
const INSTALLATION_ID = "987654";
const NOW_MS = 1_762_000_000_000;

let privateKeyPem: string;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	const body = Buffer.from(der).toString("base64");
	privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
});

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fakeTransport(handler: (call: FetchCall) => Response) {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const call = {
			url: input instanceof Request ? input.url : input.toString(),
			init: init ?? {},
		};
		calls.push(call);
		return handler(call);
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function credentials(fetchImpl: typeof fetch): GitHubAppCredentials {
	return {
		appId: APP_ID,
		privateKeyPem,
		fetchImpl,
		now: () => NOW_MS,
		apiBaseUrl: "https://api.github.test",
	};
}

function tokenBody(): unknown {
	return {
		// Runtime-built fake: never a static token-shaped literal.
		token: crypto.randomUUID(),
		expires_at: new Date(NOW_MS + 3_600_000).toISOString(),
	};
}

function repoEntry(
	index: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		full_name: `acme/repo-${index}`,
		default_branch: "main",
		private: index % 2 === 0,
		...overrides,
	};
}

function repositoryTransport(
	listResponse: () => Response,
): ReturnType<typeof fakeTransport> & { token: string } {
	const token = crypto.randomUUID();
	const transport = fakeTransport((call) => {
		if (call.url.endsWith("/access_tokens")) {
			return json(200, {
				token,
				expires_at: new Date(NOW_MS + 3_600_000).toISOString(),
			});
		}
		return listResponse();
	});
	return { ...transport, token };
}

describe("GitHub App installation token resolver", () => {
	test("mints a token for the supplied installation id, not a bound one", async () => {
		const transport = fakeTransport(() => json(200, tokenBody()));
		const client = createGitHubAppClient(credentials(transport.impl));
		const resolver = createGitHubInstallationTokenResolver(
			credentials(transport.impl),
		);
		await client.getInstallationToken({ installationId: "111" });
		await resolver.getInstallationToken({ installationId: "222" });
		expect(transport.calls[0].url).toContain(
			"/app/installations/111/access_tokens",
		);
		expect(transport.calls[1].url).toContain(
			"/app/installations/222/access_tokens",
		);
	});

	test("validates installation ids, repository names and permissions", async () => {
		const transport = fakeTransport(() => json(200, tokenBody()));
		const client = createGitHubAppClient(credentials(transport.impl));
		for (const installationId of ["", "0", "12ab", "1".repeat(21)]) {
			await expect(
				client.getInstallationToken({ installationId }),
			).rejects.toBeInstanceOf(PlatformError);
		}
		await expect(
			client.getInstallationToken({
				installationId: INSTALLATION_ID,
				repositoryName: "acme/widgets",
			}),
		).rejects.toBeInstanceOf(PlatformError);
		await expect(
			client.getInstallationToken({
				installationId: INSTALLATION_ID,
				repositoryName: "widgets",
				permissions: { secrets: "write" } as never,
			}),
		).rejects.toBeInstanceOf(PlatformError);
		expect(transport.calls).toHaveLength(0);
	});

	test("maps 401/403/5xx without leaking a body", async () => {
		for (const [status, code] of [
			[401, "INTEGRATION_UNAVAILABLE"],
			[403, "POLICY_DENIED"],
			[500, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const transport = fakeTransport(() =>
				json(status, { message: "provider body with sensitive text" }),
			);
			const client = createGitHubAppClient(credentials(transport.impl));
			const error = await client
				.getInstallationToken({ installationId: INSTALLATION_ID })
				.then(
					() => null,
					(thrown: unknown) => thrown,
				);
			expect(error).toBeInstanceOf(PlatformError);
			expect((error as PlatformError).code).toBe(code);
			expect((error as PlatformError).message).not.toContain("sensitive");
		}
	});
});

describe("listInstallationRepositories", () => {
	test("lists bounded repositories with the installation token", async () => {
		const transport = repositoryTransport(() =>
			json(200, {
				total_count: 2,
				repositories: [
					repoEntry(1),
					repoEntry(2, { default_branch: "develop" }),
				],
			}),
		);
		const client = createGitHubAppClient(credentials(transport.impl));
		const result = await listInstallationRepositories(
			{
				client,
				fetchImpl: transport.impl,
				apiBaseUrl: "https://api.github.test",
			},
			{ installationId: INSTALLATION_ID },
		);
		expect(result.truncated).toBe(false);
		expect(result.repositories).toEqual([
			{
				fullName: "acme/repo-1",
				defaultBranch: "main",
				private: false,
				installationId: INSTALLATION_ID,
			},
			{
				fullName: "acme/repo-2",
				defaultBranch: "develop",
				private: true,
				installationId: INSTALLATION_ID,
			},
		]);
		const listCall = transport.calls.find((call) =>
			call.url.includes("/installation/repositories"),
		);
		expect(listCall?.url).toContain(
			`per_page=${MAX_INSTALLATION_REPOSITORIES}`,
		);
		const headers = listCall?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${transport.token}`);
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
	});

	test("caps at 100 repositories and marks the result truncated", async () => {
		const repositories = Array.from(
			{ length: MAX_INSTALLATION_REPOSITORIES + 50 },
			(_, index) => repoEntry(index),
		);
		const transport = repositoryTransport(() =>
			json(200, { total_count: repositories.length, repositories }),
		);
		const client = createGitHubAppClient(credentials(transport.impl));
		const result = await listInstallationRepositories(
			{
				client,
				fetchImpl: transport.impl,
				apiBaseUrl: "https://api.github.test",
			},
			{ installationId: INSTALLATION_ID },
		);
		expect(result.repositories).toHaveLength(MAX_INSTALLATION_REPOSITORIES);
		expect(result.truncated).toBe(true);
	});

	test("drops names/branches outside the caps and reports truncation", async () => {
		const transport = repositoryTransport(() =>
			json(200, {
				total_count: 5,
				repositories: [
					repoEntry(1),
					repoEntry(2, {
						full_name: `a/${"x".repeat(MAX_INSTALLATION_REPOSITORY_NAME_CHARS)}`,
					}),
					repoEntry(3, {
						default_branch: "b".repeat(MAX_INSTALLATION_BRANCH_CHARS + 1),
					}),
					repoEntry(4, { private: "yes" }),
					{
						full_name: "not-a-full-name",
						default_branch: "main",
						private: true,
					},
				],
			}),
		);
		const client = createGitHubAppClient(credentials(transport.impl));
		const result = await listInstallationRepositories(
			{
				client,
				fetchImpl: transport.impl,
				apiBaseUrl: "https://api.github.test",
			},
			{ installationId: INSTALLATION_ID },
		);
		expect(result.repositories.map((repo) => repo.fullName)).toEqual([
			"acme/repo-1",
		]);
		expect(result.truncated).toBe(true);
	});

	test("maps 401/403/5xx from the list call without a provider body", async () => {
		for (const [status, code] of [
			[401, "INTEGRATION_UNAVAILABLE"],
			[403, "POLICY_DENIED"],
			[503, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const transport = repositoryTransport(() =>
				json(status, { message: "leaky provider text" }),
			);
			const client = createGitHubAppClient(credentials(transport.impl));
			const error = await listInstallationRepositories(
				{
					client,
					fetchImpl: transport.impl,
					apiBaseUrl: "https://api.github.test",
				},
				{ installationId: INSTALLATION_ID },
			).then(
				() => null,
				(thrown: unknown) => thrown,
			);
			expect(error).toBeInstanceOf(PlatformError);
			expect((error as PlatformError).code).toBe(code);
			expect((error as PlatformError).message).not.toContain("leaky");
		}
	});

	test("rejects unusable JSON and malformed installation ids", async () => {
		const transport = repositoryTransport(
			() => new Response("not-json", { status: 200 }),
		);
		const client = createGitHubAppClient(credentials(transport.impl));
		await expect(
			listInstallationRepositories(
				{
					client,
					fetchImpl: transport.impl,
					apiBaseUrl: "https://api.github.test",
				},
				{ installationId: INSTALLATION_ID },
			),
		).rejects.toBeInstanceOf(PlatformError);
		await expect(
			listInstallationRepositories(
				{
					client,
					fetchImpl: transport.impl,
					apiBaseUrl: "https://api.github.test",
				},
				{ installationId: "not-numeric" },
			),
		).rejects.toBeInstanceOf(PlatformError);
	});
});

describe("GitHub App installation details", () => {
	test("returns bounded account metadata from the App JWT call", async () => {
		const transport = fakeTransport((call) => {
			expect(call.url).toContain(`/app/installations/${INSTALLATION_ID}`);
			return json(200, {
				account: { login: "acme", type: "Organization" },
				repository_selection: "selected",
				token: "never-returned",
			});
		});
		const client = createGitHubAppClient(credentials(transport.impl));
		expect(
			await client.getInstallation({ installationId: INSTALLATION_ID }),
		).toEqual({
			installationId: INSTALLATION_ID,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "selected",
		});
	});

	test("rejects an unusable installation body", async () => {
		const transport = fakeTransport(() =>
			json(200, { account: { login: "", type: "Bot" } }),
		);
		const client = createGitHubAppClient(credentials(transport.impl));
		await expect(
			client.getInstallation({ installationId: INSTALLATION_ID }),
		).rejects.toBeInstanceOf(PlatformError);
	});
});
