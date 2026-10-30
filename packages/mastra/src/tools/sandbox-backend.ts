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
 * - route write operations through the optional write surface only; the plain
 *   `git` method stays read-only.
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

	/**
	 * Write surface (wave 7). Optional so a read-only backend stays valid; the
	 * tool layer refuses write tools when an implementation omits them.
	 * Implementations must confine `path` to the workspace, enforce a byte cap,
	 * and never return file content beyond what was written.
	 */
	writeFile?(
		path: string,
		content: string,
		options?: { readonly maxBytes?: number },
	): Promise<{ readonly bytesWritten: number; readonly sha256: string }>;

	/** Stages every change and commits; returns the commit sha. */
	commitAll?(
		message: string,
		options?: {
			readonly paths?: readonly string[];
			readonly authorName?: string;
			readonly authorEmail?: string;
		},
	): Promise<{ readonly commitSha: string }>;

	/** Bounded `--stat` view; file list is capped by the implementation. */
	diffSummary?(): Promise<{
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
		readonly files: readonly string[];
	}>;

	/** Bounded patch text for the task artifact; never streamed to the model. */
	diffPatch?(options?: {
		readonly maxBytes?: number;
	}): Promise<{ readonly patch: string; readonly truncated: boolean }>;
}
