import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ArtifactRow,
	PgSql,
	RepositoryRepository,
	RepositoryRow,
	RunEventRow,
	TaskAttemptRow,
	TaskRepository,
	TaskRow,
} from "@isolate/db";
import { NullProvider } from "@isolate/sandbox";
import type { Logger, OrganizationId, TaskId } from "@isolate/shared";
import { workerConfigSchema } from "./config";
import {
	createConfiguredWorkerComposition,
	createRunSummaryReader,
	createSandboxEnvResolver,
	createToolInvocationRecorder,
	loadPullRequestTargetFromEvents,
	loadPullRequestTaskState,
	loadValidationPolicyForTask,
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
		expect(typeof composition.overrides.loadValidationPolicy).toBe("function");
		// Wave 9: the tool audit sink is bound with the database composition.
		expect(typeof composition.overrides.recordToolInvocation).toBe("function");
		// Wave 9: acceptance checks and the per-branch lock are bound with the DB.
		expect(typeof composition.overrides.loadAcceptanceChecks).toBe("function");
		expect(typeof composition.overrides.acquireBranchLock).toBe("function");
		expect(composition.overrides.pullRequest).toBeUndefined();
		expect(composition.githubAuth).toBe(false);
	});

	test("the tool audit writer stores only the argument digest", async () => {
		const inserts: unknown[][] = [];
		const sql = {
			async unsafe(_query: string, params: unknown[]) {
				inserts.push(params);
				return [
					{
						id: "ti_1",
						organization_id: params[0],
						task_id: params[1],
						workflow_run_id: params[2],
						tool_name: params[3],
						arguments_redacted: params[4],
						decision: params[5],
						denial_reason: params[6],
						duration_ms: params[7],
						created_at: new Date(),
					},
				];
			},
		} as unknown as PgSql;
		const record = createToolInvocationRecorder(sql);
		await record({
			organizationId: "11111111-1111-4111-8111-111111111111" as OrganizationId,
			taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f" as TaskId,
			workflowRunId: null,
			toolName: "repo.write_file",
			outcome: "denied",
			denialReason: "POLICY_DENIED",
			argumentsSha256: "c".repeat(64),
			durationMs: 7,
		});

		expect(inserts).toHaveLength(1);
		const params = inserts[0] ?? [];
		expect(params[3]).toBe("repo.write_file");
		expect(params[4]).toBe(JSON.stringify({ sha256: "c".repeat(64) }));
		expect(params[5]).toBe("denied");
		expect(params[6]).toBe("POLICY_DENIED");
		expect(params[7]).toBe(7);
		// No tool argument content can reach the row.
		expect(JSON.stringify(params)).not.toContain("fileContent");
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
		expect(withoutSandbox.overrides.pullRequest).toBeUndefined();

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
		expect(typeof withSandbox.overrides.pullRequest?.loadTaskState).toBe(
			"function",
		);
		expect(
			typeof withSandbox.overrides.pullRequest?.loadPullRequestTarget,
		).toBe("function");
		expect(typeof withSandbox.overrides.pullRequest?.recordPullRequest).toBe(
			"function",
		);
		expect(typeof withSandbox.overrides.pullRequest?.createPullRequest).toBe(
			"function",
		);
	});
});

describe("wave-8 review reads", () => {
	const ORG = "11111111-1111-4111-8111-111111111111" as OrganizationId;
	const OTHER_ORG = "22222222-2222-4222-8222-222222222222" as OrganizationId;
	const TASK = "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f" as TaskId;
	const TARGET = {
		repositoryFullName: "acme/widget",
		headBranch: "task/abc",
		baseBranch: "main",
		headSha: "a".repeat(40),
	};

	function taskRow(overrides: Record<string, unknown> = {}): TaskRow {
		return {
			id: TASK,
			organization_id: ORG,
			repository_id: "repo_1",
			status: "executing",
			pull_request_number: 12,
			pull_request_url: "https://github.com/acme/widget/pull/12",
			...overrides,
		} as unknown as TaskRow;
	}

	function repositoryRow(
		overrides: Record<string, unknown> = {},
	): RepositoryRow {
		return {
			id: "repo_1",
			organization_id: ORG,
			provider: "github",
			external_full_name: "acme/widget",
			default_branch: "main",
			validation_command: "bun test",
			validation_timeout_ms: 30_000,
			created_at: new Date(),
			...overrides,
		} as unknown as RepositoryRow;
	}

	function runEvent(overrides: Record<string, unknown> = {}): RunEventRow {
		return {
			id: "evt_1",
			task_id: TASK,
			workflow_run_id: null,
			type: "approval.requested",
			actor: "worker",
			data: {},
			occurred_at: new Date(),
			...overrides,
		} as unknown as RunEventRow;
	}

	test("validation policy reads task → repository under one tenant", async () => {
		const tasks: Pick<TaskRepository, "get"> = { get: async () => taskRow() };
		const repositories: Pick<RepositoryRepository, "get"> = {
			get: async () => repositoryRow(),
		};

		expect(
			await loadValidationPolicyForTask(tasks, repositories, {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toEqual({ command: "bun test", timeoutMs: 30_000 });

		// Foreign organization is indistinguishable from an absent task.
		expect(
			await loadValidationPolicyForTask(tasks, repositories, {
				organizationId: OTHER_ORG,
				taskId: TASK,
			}),
		).toBeNull();

		const noCommand: Pick<RepositoryRepository, "get"> = {
			get: async () => repositoryRow({ validation_command: null }),
		};
		expect(
			await loadValidationPolicyForTask(tasks, noCommand, {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toBeNull();
	});

	test("the PR target is the latest valid github.create_pull_request event", async () => {
		const olderPush = runEvent({
			id: "evt_1",
			data: { action: "git.push_branch", payloadSha256: "b".repeat(64) },
		});
		const prEvent = runEvent({
			id: "evt_2",
			data: {
				action: "github.create_pull_request",
				payload: TARGET,
				payloadSha256: "c".repeat(64),
			},
		});
		const runEvents = { listByTask: async () => [olderPush, prEvent] };

		expect(
			await loadPullRequestTargetFromEvents(runEvents, {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toEqual(TARGET);

		// A malformed latest PR event fails closed; it never falls back to an
		// older approval.
		const malformed = runEvent({
			id: "evt_3",
			data: {
				action: "github.create_pull_request",
				payload: { ...TARGET, token: "ghs_secret" },
			},
		});
		expect(
			await loadPullRequestTargetFromEvents(
				{ listByTask: async () => [prEvent, malformed] },
				{ organizationId: ORG, taskId: TASK },
			),
		).toBeNull();

		// No PR approval at all.
		expect(
			await loadPullRequestTargetFromEvents(
				{ listByTask: async () => [olderPush] },
				{ organizationId: ORG, taskId: TASK },
			),
		).toBeNull();
	});

	test("the PR task snapshot is tenant-scoped", async () => {
		const tasks: Pick<TaskRepository, "get"> = { get: async () => taskRow() };
		expect(
			await loadPullRequestTaskState(tasks, {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toEqual({
			status: "executing",
			pullRequestNumber: 12,
			pullRequestUrl: "https://github.com/acme/widget/pull/12",
		});
		expect(
			await loadPullRequestTaskState(tasks, {
				organizationId: OTHER_ORG,
				taskId: TASK,
			}),
		).toBeNull();
	});
});

describe("wave-11 price table and run summary", () => {
	const TABLE = {
		models: [
			{
				modelId: "meta-llama/test-model",
				promptTokenUsdPerMillion: 0.27,
				completionTokenUsdPerMillion: 0.85,
			},
		],
		sandbox: { cpuSecondUsd: 0.00005, gibSecondUsd: 0.00001 },
	};

	const ORG = "11111111-1111-4111-8111-111111111111" as OrganizationId;
	const OTHER_ORG = "22222222-2222-4222-8222-222222222222" as OrganizationId;
	const TASK = "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f" as TaskId;

	test("a valid COST_PRICE_TABLE is parsed at boot and injected", async () => {
		const composition = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			{ COST_PRICE_TABLE: JSON.stringify(TABLE) },
			{ createDb: () => ({}) as PgSql },
		);
		expect(composition.overrides.priceTable).toEqual(TABLE);
		expect(typeof composition.summarizeTask).toBe("function");
	});

	test("an absent table leaves cost unknown and never fails boot", async () => {
		const composition = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			{},
			{ createDb: () => ({}) as PgSql },
		);
		expect(composition.overrides.priceTable).toBeNull();
	});

	test("a malformed table fails boot with a bounded code", async () => {
		await expect(
			createConfiguredWorkerComposition(
				{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
				logger(),
				{ COST_PRICE_TABLE: '{"models": [' },
				{ createDb: () => ({}) as PgSql },
			),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	});

	test("summarizeTask reads usage, attempts and artifacts under one tenant", async () => {
		const reader = createRunSummaryReader({
			tasks: {
				get: async () =>
					({
						id: TASK,
						organization_id: ORG,
						status: "review_ready",
						pull_request_number: 4,
						pull_request_url: "https://github.com/acme/widget/pull/4",
					}) as unknown as TaskRow,
			},
			usage: {
				sumByTask: async () => ({
					promptTokens: 120,
					completionTokens: 30,
					totalTokens: 150,
					costUsd: "0.000042",
				}),
			},
			attempts: {
				listByTask: async () =>
					[
						{
							id: "attempt_1",
							task_id: TASK,
							workflow_run_id: null,
							attempt_index: 1,
							started_at: new Date(0),
							finished_at: new Date(1000),
							outcome: {
								status: "review_ready",
								sandboxSeconds: 42,
								validation: { status: "passed" },
							},
						},
					] as unknown as TaskAttemptRow[],
			},
			artifacts: {
				listByTask: async () =>
					[{ id: "a1" }, { id: "a2" }] as unknown as ArtifactRow[],
			},
		});

		expect(await reader({ organizationId: ORG, taskId: TASK })).toEqual({
			taskId: TASK,
			status: "review_ready",
			promptTokens: 120,
			completionTokens: 30,
			sandboxSeconds: 42,
			costUsd: 0.000042,
			attempts: 1,
			artifacts: 2,
			validation: "passed",
			pullRequest: {
				number: 4,
				url: "https://github.com/acme/widget/pull/4",
			},
		});

		// A foreign organization is indistinguishable from an absent task.
		expect(
			await reader({ organizationId: OTHER_ORG, taskId: TASK }),
		).toBeNull();
	});
});
