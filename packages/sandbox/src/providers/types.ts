import type { AuthorizedCommand, EgressPolicy } from "../policy/command-policy";

export interface SandboxSpec {
	readonly workspaceRoot: string;
	readonly lifetimeMs: number;
	readonly memoryMb: number;
	readonly cpuCount: number;
	readonly egress: EgressPolicy;
	/** Optional provider idle-reap window; defaults to 300_000 ms in the Modal adapter. */
	readonly idleTimeoutMs?: number;
}

/** Opaque provider-issued identity; paths refer ONLY to the isolated execution plane. */
export interface SandboxHandle {
	readonly id: string;
	readonly workspaceRoot: string;
}

export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly outputLimitExceeded: boolean;
}

/**
 * Server-only trusted adapter boundary, never a local-process fallback.
 * Providers bind handles to tenant/run, validate provisioning limits, and execute
 * argv without a shell inside a disposable sandbox using trusted image binaries.
 * Enforce CPU/memory/lifetime, timeout, combined output cap, cancellation, and
 * egress (deny by default; allowlists mean HTTPS:443 only).
 * Never inherit host Git config, credentials, proxies, SSH, or repo-controlled
 * PATH. Reject unsupported controls BEFORE execution. destroy must be idempotent
 * and reap descendants. Paths/symlinks must remain confined inside the sandbox.
 */
export interface SandboxProvider {
	readonly name: string;
	create(spec: SandboxSpec): Promise<SandboxHandle>;
	execute(
		sandbox: SandboxHandle,
		command: AuthorizedCommand,
		signal?: AbortSignal,
	): Promise<CommandResult>;
	destroy(sandbox: SandboxHandle): Promise<void>;
}
