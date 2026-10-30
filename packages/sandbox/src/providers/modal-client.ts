import { SandboxError } from "../errors";
import type {
	ModalCreateParams,
	ModalExecResult,
	ModalSandboxClient,
} from "./modal";

/**
 * Git + Bun image. `oven/bun:1` is Bun on a Debian base and does not ship git,
 * so the default setup layer installs the two missing tools. The image name is
 * a convenience, not a guarantee: the worker still calls `assertToolchain`
 * before any network use and a missing binary fails closed.
 */
export const DEFAULT_MODAL_IMAGE = "oven/bun:1";
export const DEFAULT_MODAL_IMAGE_SETUP: readonly string[] = Object.freeze([
	"RUN apt-get update && apt-get install -y --no-install-recommends git grep && rm -rf /var/lib/apt/lists/*",
]);
const MAX_ID_LENGTH = 512;
const MAX_IMAGE_LENGTH = 255;
const MAX_NAME_LENGTH = 255;
const MAX_SETUP_COMMANDS = 8;
const MAX_SETUP_COMMAND_LENGTH = 2_048;

export interface ModalClientEnv {
	readonly tokenId: string;
	readonly tokenSecret: string;
	readonly appName: string;
	readonly image?: string;
	/**
	 * Dockerfile-like commands applied to the base image before the sandbox is
	 * created. Omit for an image that already has the toolchain. Builds are
	 * cached by Modal; only the first create in a fresh environment pays.
	 */
	readonly imageSetupCommands?: readonly string[];
}

/** Minimal structural view of the SDK objects the adapter actually uses. */
export interface ModalSdkWriteStream {
	/** Text mode; `writeText` is the SDK convenience over the WritableStream. */
	writeText(text: string): Promise<void>;
	/** EOF; the WritableStream `close()` marks stdin finished. */
	close(): Promise<void>;
}

export interface ModalSdkProcess {
	readonly stdin?: ModalSdkWriteStream;
	readonly stdout: { readText(): Promise<string> };
	readonly stderr: { readText(): Promise<string> };
	wait(): Promise<number>;
}

export interface ModalSdkSandbox {
	readonly sandboxId: string;
	exec(
		command: string[],
		params: { timeoutMs: number; workdir: string },
	): Promise<ModalSdkProcess>;
	terminate(): Promise<void>;
}

export interface ModalSdkImage {
	dockerfileCommands?(commands: string[]): ModalSdkImage;
	build?(app: unknown): Promise<unknown>;
}

export interface ModalSdkClient {
	readonly apps: {
		fromName(
			name: string,
			params?: { createIfMissing?: boolean },
		): Promise<unknown>;
	};
	readonly images: { fromRegistry(tag: string): ModalSdkImage };
	readonly sandboxes: {
		create(
			app: unknown,
			image: unknown,
			params: SdkCreateParams,
		): Promise<ModalSdkSandbox>;
	};
}

/** SDK-facing copy of the create params with mutable arrays. */
type SdkCreateParams = Omit<
	ModalCreateParams,
	"command" | "outboundDomainAllowlist"
> & {
	readonly command: string[];
	readonly outboundDomainAllowlist?: string[];
};

export interface ModalSdkModule {
	readonly ModalClient: new (params: {
		tokenId: string;
		tokenSecret: string;
	}) => ModalSdkClient;
}

export type ModalSdkLoader = () => Promise<ModalSdkModule>;

/** Dynamic import keeps the SDK (and its credentials plumbing) out of tests. */
const loadModalSdk: ModalSdkLoader = () => import("modal");

function required(value: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maximum
	) {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"Modal token credentials and app name are required",
		);
	}
	return value;
}

function imageReference(value: string | undefined): string {
	if (value === undefined) return DEFAULT_MODAL_IMAGE;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_IMAGE_LENGTH ||
		/\s/.test(value)
	) {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"Modal image reference is invalid",
		);
	}
	return value;
}

function timedOut(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "TimeoutError" || error.name === "SandboxTimeoutError")
	);
}

function alreadyGone(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "NotFoundError" || error.name === "ConflictError")
	);
}

function imageSetup(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_SETUP_COMMANDS) {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"Modal image setup commands are invalid",
		);
	}
	const commands: string[] = [];
	for (const command of value) {
		if (
			typeof command !== "string" ||
			command.trim().length === 0 ||
			command.length > MAX_SETUP_COMMAND_LENGTH ||
			/[\r\n\0]/.test(command)
		) {
			throw new SandboxError(
				"PROVIDER_UNAVAILABLE",
				"Modal image setup commands are invalid",
			);
		}
		commands.push(command.trim());
	}
	return Object.freeze(commands);
}

/**
 * Server-only factory for the real Modal SDK. Never call this in offline tests,
 * CI, or the web app: it requires MODAL_TOKEN_ID/MODAL_TOKEN_SECRET and talks
 * to the Modal API.
 */
export async function createModalSandboxClient(
	env: ModalClientEnv,
	loadSdk: ModalSdkLoader = loadModalSdk,
): Promise<ModalSandboxClient> {
	const tokenId = required(env.tokenId, MAX_NAME_LENGTH);
	const tokenSecret = required(env.tokenSecret, MAX_NAME_LENGTH);
	const appName = required(env.appName, MAX_NAME_LENGTH);
	const imageTag = imageReference(env.image);
	const setupCommands = imageSetup(env.imageSetupCommands);

	const { ModalClient } = await loadSdk();
	let client: ModalSdkClient;
	try {
		client = new ModalClient({ tokenId, tokenSecret });
	} catch {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"Modal client could not be initialized",
		);
	}

	let image: ModalSdkImage;
	let needsBuild = false;
	try {
		image = client.images.fromRegistry(imageTag);
		if (setupCommands.length > 0) {
			if (typeof image.dockerfileCommands !== "function") {
				throw new Error("image does not support setup commands");
			}
			image = image.dockerfileCommands([...setupCommands]);
			needsBuild = true;
		}
	} catch {
		throw new SandboxError(
			"PROVIDER_UNAVAILABLE",
			"Modal app or image could not be resolved",
		);
	}

	let builtImagePromise: Promise<unknown> | undefined;
	function resolveImage(app: unknown): Promise<unknown> {
		if (!needsBuild) return Promise.resolve(image);
		if (typeof image.build !== "function") {
			return Promise.reject(
				new SandboxError(
					"PROVIDER_UNAVAILABLE",
					"Modal image does not support builds",
				),
			);
		}
		builtImagePromise ??= image.build(app).catch(() => {
			builtImagePromise = undefined;
			throw new SandboxError(
				"PROVIDER_UNAVAILABLE",
				"Modal image could not be built",
			);
		});
		return builtImagePromise;
	}

	// App resolution is the first network call, so it is deferred until a
	// sandbox is actually requested: constructing the client (for example at
	// worker boot) never talks to Modal. A failed attempt is not memoized, so a
	// later retry can still succeed.
	let appPromise: Promise<unknown> | undefined;
	function resolveApp(): Promise<unknown> {
		appPromise ??= client.apps
			.fromName(appName, { createIfMissing: true })
			.catch(() => {
				appPromise = undefined;
				throw new SandboxError(
					"PROVIDER_UNAVAILABLE",
					"Modal app or image could not be resolved",
				);
			});
		return appPromise;
	}

	const sandboxes = new Map<string, ModalSdkSandbox>();

	return {
		async create(params) {
			let sandbox: ModalSdkSandbox;
			try {
				const app = await resolveApp();
				const preparedImage = await resolveImage(app);
				sandbox = await client.sandboxes.create(app, preparedImage, {
					cpu: params.cpu,
					memoryMiB: params.memoryMiB,
					timeoutMs: params.timeoutMs,
					idleTimeoutMs: params.idleTimeoutMs,
					workdir: params.workdir,
					command: [...params.command],
					...(params.blockNetwork === undefined
						? {}
						: { blockNetwork: params.blockNetwork }),
					...(params.outboundDomainAllowlist
						? {
								outboundDomainAllowlist: [...params.outboundDomainAllowlist],
							}
						: {}),
					...(params.env ? { env: { ...params.env } } : {}),
				});
			} catch (error) {
				if (error instanceof SandboxError) throw error;
				throw new SandboxError(
					"PROVIDER_UNAVAILABLE",
					"Modal sandbox provisioning failed",
				);
			}
			const id = sandbox?.sandboxId;
			if (
				typeof id !== "string" ||
				id.length === 0 ||
				id.length > MAX_ID_LENGTH
			) {
				throw new SandboxError(
					"PROVIDER_PROTOCOL",
					"Modal sandbox returned an invalid id",
				);
			}
			sandboxes.set(id, sandbox);
			return { id };
		},

		async exec(id, argv, params, stdinText): Promise<ModalExecResult> {
			const sandbox = sandboxes.get(id);
			if (!sandbox) {
				throw new SandboxError(
					"PROVIDER_PROTOCOL",
					"Unknown Modal sandbox handle",
				);
			}
			let proc: ModalSdkProcess;
			try {
				proc = await sandbox.exec([...argv], {
					timeoutMs: params.timeoutMs,
					workdir: params.workdir,
				});
			} catch {
				throw new SandboxError(
					"PROVIDER_UNAVAILABLE",
					"Modal command could not be started",
				);
			}

			// Stdin is written and closed (EOF) before output is consumed. The
			// payload is trusted tooling content and must never appear in errors.
			if (stdinText !== undefined) {
				if (!proc.stdin) {
					throw new SandboxError(
						"PROVIDER_UNAVAILABLE",
						"Modal command stdin is unavailable",
					);
				}
				try {
					await proc.stdin.writeText(stdinText);
					await proc.stdin.close();
				} catch {
					throw new SandboxError(
						"PROVIDER_UNAVAILABLE",
						"Modal command stdin failed",
					);
				}
			}

			// Streams are consumed concurrently; a deadline rejection must not lose
			// the output that was already produced by the other stream.
			const [stdout, stderr, exit] = await Promise.allSettled([
				proc.stdout.readText(),
				proc.stderr.readText(),
				proc.wait(),
			]);
			const expired = exit.status === "rejected" && timedOut(exit.reason);
			if (exit.status === "rejected" && !expired) {
				throw new SandboxError("PROVIDER_UNAVAILABLE", "Modal command failed");
			}
			const exitCode = exit.status === "fulfilled" ? exit.value : 124;
			if (!Number.isInteger(exitCode)) {
				throw new SandboxError(
					"PROVIDER_PROTOCOL",
					"Modal command returned an invalid exit code",
				);
			}
			return {
				exitCode,
				stdout: stdout.status === "fulfilled" ? stdout.value : "",
				stderr: stderr.status === "fulfilled" ? stderr.value : "",
				timedOut: expired,
			};
		},

		async terminate(id) {
			const sandbox = sandboxes.get(id);
			if (!sandbox) return;
			sandboxes.delete(id);
			try {
				await sandbox.terminate();
			} catch (error) {
				if (alreadyGone(error)) return;
				throw new SandboxError(
					"PROVIDER_UNAVAILABLE",
					"Modal sandbox termination failed",
				);
			}
		},
	};
}
