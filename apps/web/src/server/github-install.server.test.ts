import { beforeAll, describe, expect, test } from "bun:test";
import {
	InMemoryGitHubInstallationRepository,
	InMemoryRepositoryRepository,
	type UserRole,
} from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	createGitHubInstallService,
	createGitHubInstallState,
	GITHUB_INSTALL_STATE_TTL_MS,
	type GitHubAppRuntimeConfig,
	handleGitHubCallbackRoute,
	handleGitHubInstallRoute,
	handleGitHubRepositoriesRoute,
	handleRepositoryImportRoute,
	readGitHubAppRuntimeConfig,
	verifyGitHubInstallState,
} from "./github-install.server";
import type { CallerScope } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER = asUserId("33333333-3333-4333-8333-333333333333");
const OTHER_USER = asUserId("44444444-4444-4444-8444-444444444444");
const NOW = 1_762_100_000_000;
const STATE_SECRET = "s".repeat(32);
const INSTALLATION_ID = "987654";

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

function appConfig(
	overrides: Partial<GitHubAppRuntimeConfig> = {},
): GitHubAppRuntimeConfig {
	return {
		slug: "isolate-platform",
		appId: "123456",
		privateKeyPem,
		stateSecret: STATE_SECRET,
		...overrides,
	};
}

function scope(role: UserRole = "owner", organizationId = ORG_A): CallerScope {
	return { organizationId, userId: USER, role };
}

type FetchCall = { url: string; init: RequestInit };

function fakeTransport(
	repositories: Array<Record<string, unknown>> = [
		{ full_name: "acme/widgets", default_branch: "main", private: true },
		{ full_name: "acme/api", default_branch: "develop", private: false },
	],
) {
	const calls: FetchCall[] = [];
	const token = crypto.randomUUID();
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (url.endsWith("/access_tokens")) {
			return Response.json({
				token,
				expires_at: new Date(NOW + 3_600_000).toISOString(),
			});
		}
		if (url.includes("/installation/repositories")) {
			return Response.json({
				total_count: repositories.length,
				repositories,
			});
		}
		if (url.includes(`/app/installations/${INSTALLATION_ID}`)) {
			return Response.json({
				account: { login: "acme", type: "Organization" },
				repository_selection: "selected",
			});
		}
		return new Response("not found", { status: 404 });
	};
	return { impl: impl as unknown as typeof fetch, calls, token };
}

function harness(
	options: {
		role?: UserRole;
		config?: GitHubAppRuntimeConfig | null;
		fetchImpl?: typeof fetch;
		installations?: InMemoryGitHubInstallationRepository;
	} = {},
) {
	const installations =
		options.installations ?? new InMemoryGitHubInstallationRepository();
	const repositories = new InMemoryRepositoryRepository();
	const service = createGitHubInstallService({
		installations,
		repositories,
		appConfig: options.config === undefined ? appConfig() : options.config,
		...(options.fetchImpl === undefined
			? {}
			: { fetchImpl: options.fetchImpl }),
		now: () => NOW,
	});
	return { service, installations, repositories };
}

function installState(
	overrides: Partial<Parameters<typeof createGitHubInstallState>[0]> = {},
) {
	return createGitHubInstallState({
		organizationId: ORG_A,
		userId: USER,
		secret: STATE_SECRET,
		now: NOW,
		...overrides,
	}).state;
}

describe("signed install state", () => {
	test("round-trips the tenant, user and nonce", () => {
		const state = installState();
		expect(state.length).toBeLessThan(2048);
		const verified = verifyGitHubInstallState(state, {
			secret: STATE_SECRET,
			now: NOW,
		});
		expect(verified).toMatchObject({
			organizationId: ORG_A,
			userId: USER,
			issuedAt: NOW,
			expiresAt: NOW + GITHUB_INSTALL_STATE_TTL_MS,
		});
		expect(verified?.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
		// The secret itself never appears in the token or its payload.
		expect(state).not.toContain(STATE_SECRET);
	});

	test("rejects tampering, the wrong secret and malformed values", () => {
		const state = installState();
		const [payload, signature] = state.split(".");
		expect(
			verifyGitHubInstallState(`${payload}x.${signature}`, {
				secret: STATE_SECRET,
				now: NOW,
			}),
		).toBeNull();
		expect(
			verifyGitHubInstallState(state, {
				secret: "x".repeat(32),
				now: NOW,
			}),
		).toBeNull();
		for (const malformed of ["", ".", "abc", `${payload}.`, `.${signature}`]) {
			expect(
				verifyGitHubInstallState(malformed, {
					secret: STATE_SECRET,
					now: NOW,
				}),
			).toBeNull();
		}
	});

	test("expires after ten minutes and rejects future-issued states", () => {
		const state = installState();
		expect(
			verifyGitHubInstallState(state, {
				secret: STATE_SECRET,
				now: NOW + GITHUB_INSTALL_STATE_TTL_MS,
			}),
		).toBeNull();
		expect(
			verifyGitHubInstallState(installState({ now: NOW + 10 * 60 * 1000 }), {
				secret: STATE_SECRET,
				now: NOW,
			}),
		).toBeNull();
	});
});

describe("GitHub App configuration", () => {
	test("is absent unless every piece is present", () => {
		expect(readGitHubAppRuntimeConfig({})).toBeNull();
		expect(
			readGitHubAppRuntimeConfig({
				GITHUB_APP_SLUG: "isolate-platform",
				GITHUB_APP_ID: "123",
				GITHUB_APP_STATE_SECRET: "short",
				GITHUB_APP_PRIVATE_KEY: privateKeyPem,
			}),
		).toBeNull();
		expect(
			readGitHubAppRuntimeConfig({
				GITHUB_APP_SLUG: "isolate-platform",
				GITHUB_APP_ID: "123",
				GITHUB_APP_STATE_SECRET: STATE_SECRET,
				GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
			}),
		).toBeNull();
		expect(
			readGitHubAppRuntimeConfig({
				GITHUB_APP_SLUG: "isolate-platform",
				GITHUB_APP_ID: "123",
				GITHUB_APP_STATE_SECRET: STATE_SECRET,
				GITHUB_APP_PRIVATE_KEY: privateKeyPem,
			}),
		).toMatchObject({ slug: "isolate-platform", appId: "123" });
	});
});

describe("install service", () => {
	test("returns a fixed result when the App is not configured", async () => {
		const { service } = harness({ config: null });
		expect(await service.startInstall(scope())).toEqual({
			ok: false,
			error: {
				code: "GITHUB_APP_NOT_CONFIGURED",
				message: expect.stringContaining("not configured"),
			},
		});
		expect(await service.listRepositories(scope())).toMatchObject({
			ok: false,
			error: { code: "GITHUB_APP_NOT_CONFIGURED" },
		});
		expect(
			await service.importRepositories(scope(), {
				fullNames: ["acme/widgets"],
			}),
		).toMatchObject({
			ok: false,
			error: { code: "GITHUB_APP_NOT_CONFIGURED" },
		});
	});

	test("owner/admin start an install; members are refused", async () => {
		const { service } = harness();
		const started = await service.startInstall(scope("admin"));
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect(
			started.value.url.startsWith(
				"https://github.com/apps/isolate-platform/installations/new?state=",
			),
		).toBe(true);
		const state = new URL(started.value.url).searchParams.get("state");
		expect(state).not.toBeNull();
		expect(
			verifyGitHubInstallState(state as string, {
				secret: STATE_SECRET,
				now: NOW,
			}),
		).toMatchObject({ organizationId: ORG_A, userId: USER });
		expect(await service.startInstall(scope("member"))).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN" },
		});
	});

	test("callback state is bound to the caller and the organization", async () => {
		const transport = fakeTransport();
		const { service, installations } = harness({
			fetchImpl: transport.impl,
		});
		const foreignState = installState({ organizationId: ORG_B });
		expect(
			await service.completeInstall(scope(), {
				state: foreignState,
				installationId: INSTALLATION_ID,
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		const otherUserState = installState({ userId: OTHER_USER });
		expect(
			await service.completeInstall(scope(), {
				state: otherUserState,
				installationId: INSTALLATION_ID,
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(installations.rowCount).toBe(0);

		const result = await service.completeInstall(scope(), {
			state: installState(),
			installationId: INSTALLATION_ID,
		});
		expect(result).toEqual({
			ok: true,
			value: { installationId: INSTALLATION_ID, accountLogin: "acme" },
		});
		expect(
			await installations.findByOrganization(ORG_A, INSTALLATION_ID),
		).toMatchObject({
			account_login: "acme",
			status: "active",
			created_by: USER,
		});
		expect(transport.calls[0].url).toContain(
			`/app/installations/${INSTALLATION_ID}`,
		);
	});

	test("a numeric installation id owned by another tenant is refused", async () => {
		const installations = new InMemoryGitHubInstallationRepository();
		await installations.upsert({
			organizationId: ORG_B,
			installationId: INSTALLATION_ID,
			accountLogin: "other",
			accountType: "Organization",
			repositorySelection: "all",
		});
		const { service } = harness({
			installations,
			fetchImpl: fakeTransport().impl,
		});
		expect(
			await service.completeInstall(scope(), {
				state: installState(),
				installationId: INSTALLATION_ID,
			}),
		).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(
			(await installations.findByOrganization(ORG_B, INSTALLATION_ID))
				?.organization_id,
		).toBe(ORG_B);
	});

	test("list and import require an active installation", async () => {
		const { service } = harness();
		expect(await service.listRepositories(scope())).toMatchObject({
			ok: false,
			error: { code: "NOT_FOUND" },
		});
		expect(
			await service.importRepositories(scope(), {
				fullNames: ["acme/widgets"],
			}),
		).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
	});

	test("imports at most 25 visible repositories and skips the rest", async () => {
		const transport = fakeTransport();
		const installations = new InMemoryGitHubInstallationRepository();
		const installation = await installations.upsert({
			organizationId: ORG_A,
			installationId: INSTALLATION_ID,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "selected",
		});
		if (installation === null) throw new Error("installation seed failed");
		const { service, repositories } = harness({
			installations,
			fetchImpl: transport.impl,
		});
		const imported = await service.importRepositories(scope(), {
			fullNames: ["acme/widgets", "acme/unknown", "Acme/API"],
		});
		expect(imported).toMatchObject({
			ok: true,
			value: {
				imported: [
					{ externalFullName: "acme/widgets" },
					{ externalFullName: "acme/api" },
				],
				skipped: ["acme/unknown"],
			},
		});
		const rows = await repositories.list(ORG_A);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.github_installation_id).toBe(installation.id);
		}
		const tooMany = await service.importRepositories(scope(), {
			fullNames: Array.from({ length: 26 }, (_, index) => `acme/repo-${index}`),
		});
		expect(tooMany).toMatchObject({
			ok: false,
			error: { code: "INVALID_INPUT" },
		});
	});
});

describe("route adapters", () => {
	test("install route redirects with a verifiable state", async () => {
		const { service } = harness();
		const response = await handleGitHubInstallRoute(
			new Request("https://app.test/api/github/install", { method: "GET" }),
			{ scope: scope(), service },
		);
		expect(response.status).toBe(302);
		const location = response.headers.get("location") as string;
		expect(
			location.startsWith(
				"https://github.com/apps/isolate-platform/installations/new?state=",
			),
		).toBe(true);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("install route returns a fixed NOT_CONFIGURED response", async () => {
		const { service } = harness({ config: null });
		const response = await handleGitHubInstallRoute(
			new Request("https://app.test/api/github/install", { method: "GET" }),
			{ scope: scope(), service },
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: "GITHUB_APP_NOT_CONFIGURED",
				message: expect.stringContaining("not configured"),
			},
		});
	});

	test("callback route redirects on success and on fixed failure", async () => {
		const { service } = harness({ fetchImpl: fakeTransport().impl });
		const success = await handleGitHubCallbackRoute(
			new Request(
				`https://app.test/api/github/callback?state=${encodeURIComponent(installState())}&installation_id=${INSTALLATION_ID}`,
				{ method: "GET" },
			),
			{ scope: scope(), service },
		);
		expect(success.status).toBe(302);
		expect(success.headers.get("location")).toBe(
			"/repositories?github=connected",
		);
		const invalid = await handleGitHubCallbackRoute(
			new Request(
				`https://app.test/api/github/callback?state=bad&installation_id=${INSTALLATION_ID}`,
				{ method: "GET" },
			),
			{ scope: scope(), service },
		);
		expect(invalid.status).toBe(302);
		expect(invalid.headers.get("location")).toBe(
			"/repositories?github=error&code=INVALID_INPUT",
		);
	});

	test("repository list and import routes keep the fixed JSON contracts", async () => {
		const transport = fakeTransport();
		const installations = new InMemoryGitHubInstallationRepository();
		await installations.upsert({
			organizationId: ORG_A,
			installationId: INSTALLATION_ID,
			accountLogin: "acme",
			accountType: "Organization",
			repositorySelection: "selected",
		});
		const { service } = harness({
			installations,
			fetchImpl: transport.impl,
		});
		const list = await handleGitHubRepositoriesRoute(
			new Request("https://app.test/api/github/repositories", {
				method: "GET",
			}),
			{ scope: scope(), service },
		);
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({
			repositories: [
				{
					fullName: "acme/widgets",
					defaultBranch: "main",
					private: true,
					installationId: INSTALLATION_ID,
				},
				{
					fullName: "acme/api",
					defaultBranch: "develop",
					private: false,
					installationId: INSTALLATION_ID,
				},
			],
			truncated: false,
		});

		const imported = await handleRepositoryImportRoute(
			new Request("https://app.test/api/repositories/import", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://app.test",
					host: "app.test",
				},
				body: JSON.stringify({ fullNames: ["acme/widgets"] }),
			}),
			{ scope: scope(), service },
		);
		expect(imported.status).toBe(200);
		expect(await imported.json()).toMatchObject({
			imported: [{ externalFullName: "acme/widgets" }],
			skipped: [],
		});
	});
});
