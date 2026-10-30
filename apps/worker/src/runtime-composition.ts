import {
	createDb,
	type PgSql,
	PostgresQueueRepository,
	PostgresTaskContextRepository,
	PostgresUsageRepository,
} from "@isolate/db";
import type { SandboxToolBackend } from "@isolate/mastra";
import {
	createModalSandboxClient,
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
	};

	const sandbox = await selectSandboxProvider(env, deps);
	if (sandbox.real) {
		const root =
			env.WORKER_WORKSPACE_ROOT?.trim() || DEFAULT_WORKER_SANDBOX_ROOT;
		overrides.provider = sandbox.provider;
		overrides.sandboxPolicy = createWorkspaceToolPolicy(root);
		overrides.createSandboxBackend = sandboxBackendFactory(sandbox.provider);
	}
	const createRuntime = selectRuntimeFactory(env);
	if (createRuntime !== undefined) overrides.createRuntime = createRuntime;

	return {
		queue,
		overrides,
		providerName: sandbox.provider.name,
		inferenceProvider,
	};
}
