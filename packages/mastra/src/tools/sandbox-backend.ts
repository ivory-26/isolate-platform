/**
 * Trusted sandbox tool bridge (wave 4).
 *
 * The platform tools in `tools/registry.ts` are authored in `@isolate/mastra`,
 * but the actual filesystem/process operations belong to one provisioned
 * sandbox. The worker implements this interface over `@isolate/sandbox`
 * (`SandboxProvider` + `commandPolicy`) and injects it; the tool layer and the
 * model never receive a provider handle, credentials, or host paths.
 *
 * Implementations must:
 * - confine every path to the sandbox workspace (reject traversal/absolute host paths),
 * - enforce a timeout and a combined output cap on every call,
 * - return bounded text only (no environment values, no provider payloads),
 * - reject `git` subcommands that write (the tool layer exposes read ops only).
 */
export type SandboxExecResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	/** True when the implementation cut output at its cap. */
	readonly truncated: boolean;
};

export type SandboxSearchMatch = {
	readonly path: string;
	/** 1-based line number. */
	readonly line: number;
	/** Bounded, single-line preview. */
	readonly preview: string;
};

export type SandboxToolTimeouts = {
	readonly execTimeoutMs?: number;
	readonly gitTimeoutMs?: number;
};

export interface SandboxToolBackend {
	readFile(
		path: string,
		options?: { readonly maxBytes?: number },
	): Promise<{ readonly content: string; readonly truncated: boolean }>;
	listFiles(
		path: string,
		options?: { readonly maxEntries?: number },
	): Promise<readonly string[]>;
	search(
		query: string,
		options?: {
			readonly path?: string;
			readonly maxMatches?: number;
		},
	): Promise<readonly SandboxSearchMatch[]>;
	/** Runs argv without a shell through the command policy. */
	exec(
		argv: readonly string[],
		options?: { readonly timeoutMs?: number },
	): Promise<SandboxExecResult>;
	/** Read-only git operations (`status`, `diff`, `log`, `show`, ...). */
	git(
		args: readonly string[],
		options?: { readonly timeoutMs?: number },
	): Promise<SandboxExecResult>;
}
