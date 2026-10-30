import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createDb,
	type PgSql,
	PostgresExecutionLifecycle,
	PostgresQueueRepository,
	PostgresTaskContextRepository,
	PostgresUsageRepository,
} from "@isolate/db";
import {
	createGitHubAppTokenProvider,
	type GitHubTokenProvider,
} from "@isolate/integrations";
import type { SandboxToolBackend } from "@isolate/mastra";
import {
	createModalSandboxClient,
	createTaskWorkspaceGit,
	ModalSandboxProvider,
	NullProvider,
	type SandboxProvider,
} from "@isolate/sandbox";
import { type Logger, PlatformError, type UsageSink } from "@isolate/shared";
import type { WorkerCompositionOverrides } from "./composition";
import type { WorkerConfig } from "./config";
import type { QueueLike } from "./contracts";
import {
	createBasetenRuntimeFactory,
	createMetaRuntimeFactory,
} from "./runtime-factory";
import {
	createSandboxToolBackend,
	createWorkspaceToolPolicy,
} from "./sandbox-tool-backend";
import { createTaskContextLoader } from "./task-context";

/**
 * Production composition for the worker (wave 6).
 *
 * Offline defaults stay in `composition.ts`. This module binds the real
 * database queue, usage sink and task-context loader, plus the opted-in
 * providers:
 * - `SANDBOX_PROVIDER=modal` builds the lazy Modal client (no network at boot)
 *   and the per-job sandbox tool backend;
 * - `INFERENCE_PROVIDER=baseten` builds the Mastra runtime factory.
 *
 * Every provider selection fails closed with `MISSING_CONFIG`; nothing falls
 * back to a local process, a different provider, or a key-free path.
 */

export const DEFAULT_WORKER_SANDBOX_ROOT = "/tmp";
export const DEFAULT_MODAL_APP_NAME = "isolate-platform";

export type ConfiguredWorkerComposition = {
	/** Durable queue when a database is configured; otherwise the loop stays unavailable. */
	queue?: QueueLike;
	overrides: WorkerCompositionOverrides;
	providerName: string;
	inferenceProvider: string;
	/** True when a GitHub App broker is configured (no token is exposed). */
	githubAuth: boolean;
};

export type CompositionDependencies = {
	createDb?: (databaseUrl: string) => PgSql;
	createModalClient?: typeof createModalSandboxClient;
};

function usageSinkFor(repository: PostgresUsageRepository): UsageSink {
	return {
		async record(input) {
			await repository.record(input);
		},
	};
}

function readProviderName(env: Record<string, string | undefined>): string {
	return env.SANDBOX_PROVIDER?.trim() || "null";
}

export function readInferenceProvider(
	env: Record<string, string | undefined>,
): string {
	return env.INFERENCE_PROVIDER?.trim() || "none";
}

/**
 * Builds the opted-in sandbox provider. The Modal client only resolves its app
 * on the first create, so this is safe to construct at boot; the SDK module is
 * still loaded lazily inside `createModalSandboxClient`.
 */
export async function selectSandboxProvider(
	env: Record<string, string | undefined>,
	deps: Pick<CompositionDependencies, "createModalClient"> = {},
): Promise<{ provider: SandboxProvider; real: boolean }> {
	const name = readProviderName(env);
	if (name === "null") return { provider: new NullProvider(), real: false };
	if (name !== "modal") {
		throw new PlatformError(
			"MISSING_CONFIG",
			"SANDBOX_PROVIDER must be 'null' or 'modal'",
		);
	}
	const tokenId = env.MODAL_TOKEN_ID?.trim();
	const tokenSecret = env.MODAL_TOKEN_SECRET?.trim();
	if (!tokenId || !tokenSecret) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required when SANDBOX_PROVIDER=modal",
		);
	}
	const createClient = deps.createModalClient ?? createModalSandboxClient;
	const client = await createClient({
		tokenId,
		tokenSecret,
		appName: env.MODAL_APP_NAME?.trim() || DEFAULT_MODAL_APP_NAME,
		...(env.MODAL_IMAGE?.trim() ? { image: env.MODAL_IMAGE.trim() } : {}),
	});
	return { provider: new ModalSandboxProvider({ client }), real: true };
}

export function selectRuntimeFactory(
	env: Record<string, string | undefined>,
): WorkerCompositionOverrides["createRuntime"] {
	const name = readInferenceProvider(env);
	if (name === "none") return undefined;
	if (name === "meta") return createMetaRuntimeFactory(env);
	if (name === "baseten") return createBasetenRuntimeFactory(env);
	throw new PlatformError(
		"MISSING_CONFIG",
		"INFERENCE_PROVIDER must be 'none', 'meta' or 'baseten'",
	);
}

function sandboxBackendFactory(
	provider: SandboxProvider,
): (input: {
	sandbox: { id: string; workspaceRoot: string };
	signal: AbortSignal;
	baseBranch?: string;
	repoPath?: string;
}) => SandboxToolBackend {
	return ({ sandbox, signal, baseBranch, repoPath }) =>
		createSandboxToolBackend({
			provider,
			sandbox,
			policy: createWorkspaceToolPolicy(sandbox.workspaceRoot),
			signal,
			...(baseBranch === undefined ? {} : { baseBranch }),
			...(repoPath === undefined ? {} : { repoPath }),
		});
}

/**
 * Builds the GitHub App token broker only when the App identity and a complete
 * private key are present. A partial configuration fails closed instead of
 * silently cloning without a credential. No value is logged.
 *
 * The key may be supplied inline (`GITHUB_APP_PRIVATE_KEY`, quoted multiline or
 * literal `\n` escapes) or as a server-side file path
 * (`GITHUB_APP_PRIVATE_KEY_PATH`). The path form exists because an unquoted
 * multiline `.env` value is truncated by the dotenv parser; the file is read at
 * worker boot and never logged.
 */
export function selectGitHubTokenProvider(
	env: Record<string, string | undefined>,
): GitHubTokenProvider | null {
	const appId = env.GITHUB_APP_ID?.trim();
	const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
	const inlineKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
	const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
	const inlineComplete = inlineKey?.includes("END PRIVATE KEY") === true;

	const configured = [appId, installationId, inlineKey, keyPath].filter(
		(value) => value !== undefined && value.length > 0,
	).length;
	if (configured === 0) return null;
	if (!appId || !installationId) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required",
		);
	}
	if (!inlineComplete && !keyPath) {
		throw new PlatformError(
			"MISSING_CONFIG",
			inlineKey === undefined || inlineKey.length === 0
				? "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required"
				: "GITHUB_APP_PRIVATE_KEY is incomplete; quote the multiline value or set GITHUB_APP_PRIVATE_KEY_PATH",
		);
	}

	let privateKeyPem: string;
	if (inlineComplete && inlineKey !== undefined) {
		privateKeyPem = inlineKey;
	} else {
		const resolvedPath = resolve(keyPath as string);
		try {
			privateKeyPem = readFileSync(resolvedPath, "utf8");
		} catch {
			throw new PlatformError(
				"MISSING_CONFIG",
				"GITHUB_APP_PRIVATE_KEY_PATH could not be read",
			);
		}
	}

	const apiBaseUrl = env.GITHUB_API_BASE_URL?.trim();
	return createGitHubAppTokenProvider({
		appId,
		installationId,
		privateKeyPem,
		...(apiBaseUrl ? { apiBaseUrl } : {}),
	});
}

/** `owner/name` from the task's clean https GitHub URL. */
export function parseGitHubFullName(repoUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(repoUrl);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "invalid repository URL");
	}
	const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
		parsed.pathname,
	);
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "github.com" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		match === null
	) {
		throw new PlatformError("VALIDATION_FAILED", "invalid repository URL");
	}
	return `${match[1]}/${match[2]}`;
}

/**
 * Create-time sandbox environment for a private clone/push. The installation
 * token is consumed by Git through `GIT_CONFIG_*` (`http.extraheader`), so the
 * repository URL stays credential-free and the token never enters argv.
 */
export function createSandboxEnvResolver(provider: GitHubTokenProvider) {
	return async (input: {
		organizationId: string;
		taskId: string;
		repoUrl: string;
	}): Promise<Record<string, string>> => {
		const repositoryFullName = parseGitHubFullName(input.repoUrl);
		const installation = await provider.getInstallationToken({
			repositoryFullName,
			contents: "write",
		});
		const basic = Buffer.from(
			`x-access-token:${installation.token}`,
			"utf8",
		).toString("base64");
		return {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
			GIT_TERMINAL_PROMPT: "0",
		};
	};
}

export async function createConfiguredWorkerComposition(
	config: WorkerConfig,
	logger: Logger,
	env: Record<string, string | undefined> = process.env,
	deps: CompositionDependencies = {},
): Promise<ConfiguredWorkerComposition> {
	const inferenceProvider = readInferenceProvider(env);
	if (!config.databaseUrl) {
		logger.warn(
			"worker has no DATABASE_URL; queue, usage and task context stay unbound",
		);
		return {
			overrides: {},
			providerName: readProviderName(env),
			inferenceProvider,
			githubAuth: false,
		};
	}

	const sql = (deps.createDb ?? createDb)(config.databaseUrl);
	const queue = new PostgresQueueRepository(sql);
	const usageSink = usageSinkFor(new PostgresUsageRepository(sql));
	const loadTaskContext = createTaskContextLoader(
		new PostgresTaskContextRepository(sql),
	);

	const overrides: WorkerCompositionOverrides = {
		usageSink,
		loadTaskContext,
		// Wave 7: one durable lifecycle per worker. It is inert until a task
		// actually moves through the new handler path.
		lifecycle: new PostgresExecutionLifecycle(sql),
		pushEnabled: false,
	};

	const sandbox = await selectSandboxProvider(env, deps);
	if (sandbox.real) {
		const root =
			env.WORKER_WORKSPACE_ROOT?.trim() || DEFAULT_WORKER_SANDBOX_ROOT;
		overrides.provider = sandbox.provider;
		overrides.sandboxPolicy = createWorkspaceToolPolicy(root);
		overrides.createSandboxBackend = sandboxBackendFactory(sandbox.provider);
		overrides.createWorkspaceGit = createTaskWorkspaceGit;
	}
	const createRuntime = selectRuntimeFactory(env);
	if (createRuntime !== undefined) overrides.createRuntime = createRuntime;

	const githubTokenProvider = selectGitHubTokenProvider(env);
	if (githubTokenProvider !== null && sandbox.real) {
		overrides.resolveSandboxEnv = createSandboxEnvResolver(githubTokenProvider);
		// Push is the approval-gated action. Opt out explicitly with
		// GITHUB_PUSH_ENABLED=false; without a broker, tasks stop at review_ready.
		overrides.pushEnabled = env.GITHUB_PUSH_ENABLED?.trim() !== "false";
	}

	return {
		queue,
		overrides,
		providerName: sandbox.provider.name,
		inferenceProvider,
		githubAuth: githubTokenProvider !== null,
	};
}
