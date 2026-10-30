import { deny, SandboxError } from "../errors";
import type { AuthorizedCommand } from "../policy/command-policy";
import { validateSandboxEnv } from "../policy/env";
import { validateAbsolutePath } from "../policy/paths";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "./types";

/** The sandbox entrypoint sleeps; commands run as child processes via exec. */
const SANDBOX_COMMAND = ["sleep", "48h"] as const;
const MIN_CPU = 0.125;
const MAX_CPU = 8;
const MIN_MEMORY_MB = 128;
const MAX_MEMORY_MB = 16_384;
const MIN_LIFETIME_MS = 1_000;
const MAX_LIFETIME_MS = 3_600_000;
export const DEFAULT_MODAL_IDLE_TIMEOUT_MS = 300_000;
const MAX_ALLOWLIST_HOSTS = 32;
const MAX_HOST_LENGTH = 253;
const MAX_ID_LENGTH = 512;
/** Modal command timeouts surface as a result, not a protocol failure. */
const TIMEOUT_EXIT_CODE = 124;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface ModalCreateParams {
	readonly cpu: number;
	readonly memoryMiB: number;
	readonly timeoutMs: number;
	readonly idleTimeoutMs: number;
	readonly workdir: string;
	readonly command: readonly string[];
	readonly blockNetwork: boolean;
	readonly outboundDomainAllowlist?: readonly string[];
	/** Create-time environment; consumed by Git via `GIT_CONFIG_*`. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface ModalExecParams {
	readonly timeoutMs: number;
	readonly workdir: string;
}

export interface ModalExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

/**
 * Normalized, injectable seam over the Modal SDK. The production implementation
 * lives in `modal-client.ts`; tests inject a fake so no SDK, network, or
 * credential is ever touched offline.
 */
export interface ModalSandboxClient {
	create(params: ModalCreateParams): Promise<{ id: string }>;
	exec(
		id: string,
		argv: readonly string[],
		params: ModalExecParams,
		stdinText?: string,
	): Promise<ModalExecResult>;
	/** Rejects when the sandbox is already gone; callers must tolerate that. */
	terminate(id: string): Promise<void>;
}

function invalidLimit(): never {
	deny("Sandbox resource limits are not allowed");
}

function validateCpu(value: number): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < MIN_CPU ||
		value > MAX_CPU
	)
		invalidLimit();
}

function validateMemory(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		value < MIN_MEMORY_MB ||
		value > MAX_MEMORY_MB
	)
		invalidLimit();
}

function validateLifetime(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		value < MIN_LIFETIME_MS ||
		value > MAX_LIFETIME_MS
	)
		invalidLimit();
}

function validateIdleTimeout(value: number, lifetimeMs: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > lifetimeMs)
		invalidLimit();
}

function egressParams(egress: SandboxSpec["egress"]): {
	readonly blockNetwork: boolean;
	readonly outboundDomainAllowlist?: readonly string[];
} {
	if (!egress || typeof egress !== "object")
		deny("Invalid sandbox egress policy");
	if (egress.mode === "deny") return { blockNetwork: true };
	if (
		egress.mode !== "allowlist" ||
		!Array.isArray(egress.hosts) ||
		egress.hosts.length === 0 ||
		egress.hosts.length > MAX_ALLOWLIST_HOSTS
	)
		deny("Invalid sandbox egress allowlist");
	const hosts = [...new Set(egress.hosts)];
	for (const host of hosts) {
		if (
			typeof host !== "string" ||
			host.length > MAX_HOST_LENGTH ||
			!HOSTNAME.test(host)
		)
			deny("Invalid sandbox egress hostname");
	}
	return {
		blockNetwork: false,
		outboundDomainAllowlist: Object.freeze(hosts),
	};
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ID_LENGTH
	);
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	// The first excluded byte starts a sequence that is incomplete; back up over
	// its trailing continuation bytes so the prefix ends on a code-point boundary.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function cancelled(): SandboxError {
	return new SandboxError("CANCELLED", "Command was cancelled");
}

export class ModalSandboxProvider implements SandboxProvider {
	readonly name = "modal";
	private readonly client: ModalSandboxClient;
	private readonly now: () => number;
	private readonly destroyed = new Set<string>();
	private readonly terminating = new Map<string, Promise<void>>();

	constructor(options: { client: ModalSandboxClient; now?: () => number }) {
		this.client = options.client;
		this.now = options.now ?? Date.now;
	}

	async create(spec: SandboxSpec): Promise<SandboxHandle> {
		// Validate everything before the provider is asked to spend resources.
		const workspaceRoot = validateAbsolutePath(spec.workspaceRoot);
		validateCpu(spec.cpuCount);
		validateMemory(spec.memoryMb);
		validateLifetime(spec.lifetimeMs);
		const idleTimeoutMs = spec.idleTimeoutMs ?? DEFAULT_MODAL_IDLE_TIMEOUT_MS;
		validateIdleTimeout(idleTimeoutMs, spec.lifetimeMs);
		const egress = egressParams(spec.egress);
		const env = validateSandboxEnv(spec.env);

		const params: ModalCreateParams = {
			cpu: spec.cpuCount,
			memoryMiB: spec.memoryMb,
			timeoutMs: spec.lifetimeMs,
			idleTimeoutMs,
			workdir: workspaceRoot,
			command: [...SANDBOX_COMMAND],
			...egress,
			...(env ? { env } : {}),
		};

		let created: { id: string };
		try {
			created = await this.client.create(params);
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			throw new SandboxError(
				"PROVIDER_UNAVAILABLE",
				"Modal sandbox provisioning failed",
			);
		}
		if (!created || !validId(created.id)) {
			throw new SandboxError(
				"PROVIDER_PROTOCOL",
				"Modal sandbox returned an invalid handle",
			);
		}
		return Object.freeze({ id: created.id, workspaceRoot });
	}

	async execute(
		sandbox: SandboxHandle,
		command: AuthorizedCommand,
		signal?: AbortSignal,
		stdinText?: string,
	): Promise<CommandResult> {
		if (signal?.aborted) throw cancelled();
		if (
			!Number.isSafeInteger(command.maxOutputBytes) ||
			command.maxOutputBytes < 1
		) {
			throw new SandboxError(
				"PROVIDER_PROTOCOL",
				"Invalid sandbox output budget",
			);
		}

		const startedAt = this.now();
		let raw: ModalExecResult;
		try {
			raw = await this.client.exec(
				sandbox.id,
				[command.executable, ...command.args],
				{ timeoutMs: command.timeoutMs, workdir: command.cwd },
				stdinText,
			);
		} catch (error) {
			if (signal?.aborted) throw cancelled();
			if (error instanceof SandboxError) throw error;
			throw new SandboxError(
				"PROVIDER_UNAVAILABLE",
				"Modal sandbox execution failed",
			);
		}
		if (signal?.aborted) throw cancelled();

		if (
			!raw ||
			typeof raw !== "object" ||
			typeof raw.stdout !== "string" ||
			typeof raw.stderr !== "string" ||
			!Number.isInteger(raw.exitCode) ||
			typeof raw.timedOut !== "boolean"
		) {
			throw new SandboxError(
				"PROVIDER_PROTOCOL",
				"Invalid Modal execution result",
			);
		}

		const elapsed = this.now() - startedAt;
		const durationMs =
			Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0;

		// Combined UTF-8 budget: stdout first, stderr gets the remainder. The
		// returned streams can never exceed command.maxOutputBytes together.
		const stdout = utf8Prefix(raw.stdout, command.maxOutputBytes);
		const stderr = utf8Prefix(
			raw.stderr,
			command.maxOutputBytes - Buffer.byteLength(stdout, "utf8"),
		);
		return {
			exitCode: raw.timedOut ? TIMEOUT_EXIT_CODE : raw.exitCode,
			stdout,
			stderr,
			durationMs,
			timedOut: raw.timedOut,
			outputLimitExceeded: stdout !== raw.stdout || stderr !== raw.stderr,
		};
	}

	async destroy(sandbox: SandboxHandle): Promise<void> {
		if (!validId(sandbox.id)) {
			throw new SandboxError(
				"PROVIDER_PROTOCOL",
				"Invalid Modal sandbox handle",
			);
		}
		if (this.destroyed.has(sandbox.id)) return;
		const pending = this.terminating.get(sandbox.id);
		if (pending) {
			await pending;
			return;
		}
		const task = (async () => {
			try {
				await this.client.terminate(sandbox.id);
			} catch {
				// Termination is best-effort: an already-gone sandbox is success.
			} finally {
				this.destroyed.add(sandbox.id);
				this.terminating.delete(sandbox.id);
			}
		})();
		this.terminating.set(sandbox.id, task);
		await task;
	}
}
