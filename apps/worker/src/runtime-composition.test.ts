import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgSql } from "@isolate/db";
import { NullProvider } from "@isolate/sandbox";
import type { Logger } from "@isolate/shared";
import { workerConfigSchema } from "./config";
import {
	createConfiguredWorkerComposition,
	createSandboxEnvResolver,
	parseGitHubFullName,
	readInferenceProvider,
	selectGitHubTokenProvider,
	selectRuntimeFactory,
	selectSandboxProvider,
} from "./runtime-composition";

function logger(): Logger {
	const make = (): Logger => ({
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => make(),
	});
	return make();
}

const CONFIG = workerConfigSchema.parse({ workerId: "test-worker" });

describe("sandbox provider selection", () => {
	test("defaults to the null provider without credentials", async () => {
		const selected = await selectSandboxProvider({});
		expect(selected.real).toBe(false);
		expect(selected.provider).toBeInstanceOf(NullProvider);
	});

	test("rejects an unknown provider name", async () => {
		await expect(
			selectSandboxProvider({ SANDBOX_PROVIDER: "docker" }),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("requires both Modal credentials", async () => {
		await expect(
			selectSandboxProvider({
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
			}),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("builds the Modal provider from an injected client", async () => {
		const seen: Array<{
			appName: string;
			imageSetupCommands?: readonly string[];
		}> = [];
		const selected = await selectSandboxProvider(
			{
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
				MODAL_TOKEN_SECRET: "secret",
				MODAL_APP_NAME: "isolate-test",
			},
			{
				createModalClient: async (env) => {
					seen.push({
						appName: env.appName,
						imageSetupCommands: env.imageSetupCommands,
					});
					return {
						async create() {
							return { id: "sb-1" };
						},
						async exec() {
							return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
						},
						async terminate() {},
					};
				},
			},
		);
		expect(selected.real).toBe(true);
		expect(selected.provider.name).toBe("modal");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.appName).toBe("isolate-test");
		expect(seen[0]?.imageSetupCommands?.join(" ")).toContain("git");
	});

	test("MODAL_IMAGE_SETUP=off disables the setup layer", async () => {
		const seen: Array<readonly string[] | undefined> = [];
		await selectSandboxProvider(
			{
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
				MODAL_TOKEN_SECRET: "secret",
				MODAL_IMAGE_SETUP: "off",
			},
			{
				createModalClient: async (env) => {
					seen.push(env.imageSetupCommands);
					return {
						async create() {
							return { id: "sb-1" };
						},
						async exec() {
							return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
						},
						async terminate() {},
					};
				},
			},
		);
		expect(seen).toEqual([undefined]);
	});
});

describe("inference provider selection", () => {
	test("none yields no factory", () => {
		expect(readInferenceProvider({})).toBe("none");
		expect(selectRuntimeFactory({})).toBeUndefined();
	});

	test("unknown and key-free Baseten selections fail closed", () => {
		expect(() =>
			selectRuntimeFactory({ INFERENCE_PROVIDER: "openai" }),
		).toThrow(/INFERENCE_PROVIDER/);
		expect(() =>
			selectRuntimeFactory({ INFERENCE_PROVIDER: "baseten" }),
		).toThrow(/BASETEN_API_KEY/);
	});

	test("a configured Baseten key yields a factory", () => {
		const factory = selectRuntimeFactory({
			INFERENCE_PROVIDER: "baseten",
			BASETEN_API_KEY: "test-key",
		});
		expect(typeof factory).toBe("function");
	});

	test("meta requires its key and yields a factory when present", () => {
		expect(() => selectRuntimeFactory({ INFERENCE_PROVIDER: "meta" })).toThrow(
			/META_API_KEY/,
		);
		const factory = selectRuntimeFactory({
			INFERENCE_PROVIDER: "meta",
			META_API_KEY: "test-meta-key",
		});
		expect(typeof factory).toBe("function");
	});
});

describe("configured composition", () => {
	test("without a database it leaves every adapter unbound", async () => {
		const composition = await createConfiguredWorkerComposition(
			CONFIG,
			logger(),
			{},
		);
		expect(composition.overrides).toEqual({});
		expect(composition.queue).toBeUndefined();
	});

	test("with a database it binds the queue, usage sink and loader", async () => {
		const composition = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			{},
			{ createDb: () => ({}) as PgSql },
		);
		expect(composition.queue).toBeDefined();
		expect(typeof composition.overrides.usageSink?.record).toBe("function");
		expect(typeof composition.overrides.loadTaskContext).toBe("function");
		expect(composition.overrides.lifecycle).toBeDefined();
		expect(composition.overrides.provider).toBeUndefined();
		expect(composition.overrides.createRuntime).toBeUndefined();
		expect(composition.overrides.createWorkspaceGit).toBeUndefined();
		expect(composition.overrides.pushEnabled).toBe(false);
		expect(composition.githubAuth).toBe(false);
	});
});

describe("GitHub App credential wiring", () => {
	async function privateKeyPem(): Promise<string> {
		const pair = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
		const body = Buffer.from(der).toString("base64");
		return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
	}

	test("absent GitHub config yields no broker", () => {
		expect(selectGitHubTokenProvider({})).toBeNull();
	});

	test("partial GitHub config fails closed", () => {
		expect(() =>
			selectGitHubTokenProvider({
				GITHUB_APP_ID: "1",
			}),
		).toThrow(/GITHUB_APP_ID/);
	});

	test("full GitHub config builds a broker without a network call", async () => {
		const provider = selectGitHubTokenProvider({
			GITHUB_APP_ID: "1",
			GITHUB_APP_INSTALLATION_ID: "2",
			GITHUB_APP_PRIVATE_KEY: await privateKeyPem(),
		});
		expect(provider).not.toBeNull();
		expect(typeof provider?.getInstallationToken).toBe("function");
	});

	test("a key file path replaces an unquoted multiline .env value", async () => {
		const directory = mkdtempSync(join(tmpdir(), "isolate-key-"));
		const keyPath = join(directory, "app.pkcs8.pem");
		try {
			writeFileSync(keyPath, await privateKeyPem(), "utf8");
			const provider = selectGitHubTokenProvider({
				GITHUB_APP_ID: "1",
				GITHUB_APP_INSTALLATION_ID: "2",
				// Simulates dotenv truncating an unquoted multiline value at line 1.
				GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
				GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
			});
			expect(provider).not.toBeNull();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("an incomplete inline key without a path fails closed", () => {
		expect(() =>
			selectGitHubTokenProvider({
				GITHUB_APP_ID: "1",
				GITHUB_APP_INSTALLATION_ID: "2",
				GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
			}),
		).toThrow(/incomplete/);
	});

	test("an unreadable key file path fails closed", () => {
		expect(() =>
			selectGitHubTokenProvider({
				GITHUB_APP_ID: "1",
				GITHUB_APP_INSTALLATION_ID: "2",
				GITHUB_APP_PRIVATE_KEY_PATH: join(tmpdir(), "missing-isolate-key.pem"),
			}),
		).toThrow(/could not be read/);
	});

	test("sandbox env carries the credential through GIT_CONFIG, never the URL", async () => {
		const seen: string[] = [];
		const resolver = createSandboxEnvResolver({
			async getInstallationToken(request) {
				seen.push(request.repositoryFullName);
				return {
					token: "installation-token",
					expiresAt: "2099-01-01T00:00:00Z",
				};
			},
		});
		const env = await resolver({
			organizationId: "00000000-0000-4000-8000-000000000001",
			taskId: "00000000-0000-4000-8000-000000000002",
			repoUrl: "https://github.com/acme/widgets.git",
		});
		expect(seen).toEqual(["acme/widgets"]);
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
		expect(env.GIT_CONFIG_VALUE_0).toBe(
			`Authorization: Basic ${Buffer.from("x-access-token:installation-token").toString("base64")}`,
		);
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(JSON.stringify(env)).not.toContain("acme/widgets");
	});

	test("repository URL parsing rejects userinfo, other hosts and query strings", () => {
		expect(parseGitHubFullName("https://github.com/acme/widgets.git")).toBe(
			"acme/widgets",
		);
		for (const bad of [
			"https://user:pass@github.com/acme/widgets.git",
			"https://gitlab.com/acme/widgets.git",
			"https://github.com/acme/widgets.git?token=x",
			"http://github.com/acme/widgets.git",
			"https://github.com/acme",
		]) {
			expect(() => parseGitHubFullName(bad)).toThrow(/repository URL/);
		}
	});

	test("GitHub credentials are only bound to a real sandbox", async () => {
		const githubEnv = {
			GITHUB_APP_ID: "1",
			GITHUB_APP_INSTALLATION_ID: "2",
			GITHUB_APP_PRIVATE_KEY: await privateKeyPem(),
		};
		const withoutSandbox = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			githubEnv,
			{ createDb: () => ({}) as PgSql },
		);
		expect(withoutSandbox.githubAuth).toBe(true);
		expect(withoutSandbox.overrides.resolveSandboxEnv).toBeUndefined();
		expect(withoutSandbox.overrides.pushEnabled).toBe(false);

		const withSandbox = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			{
				...githubEnv,
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
				MODAL_TOKEN_SECRET: "secret",
			},
			{
				createDb: () => ({}) as PgSql,
				createModalClient: async () => ({
					async create() {
						return { id: "sb-1" };
					},
					async exec() {
						return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
					},
					async terminate() {},
				}),
			},
		);
		expect(typeof withSandbox.overrides.resolveSandboxEnv).toBe("function");
		expect(typeof withSandbox.overrides.createWorkspaceGit).toBe("function");
		expect(withSandbox.overrides.pushEnabled).toBe(true);
	});
});
