import type { SandboxToolBackend } from "@isolate/mastra";
import {
	type ArgumentRule,
	type CommandPolicy,
	type CommandResult,
	executeCommand,
	MAX_OUTPUT_BYTES,
	SandboxError,
	type SandboxHandle,
	type SandboxProvider,
	validateSandboxPath,
} from "@isolate/sandbox";
import { PlatformError } from "@isolate/shared";

/**
 * Sandbox-bound tool backend (wave 6).
 *
 * The worker builds one of these per job from the sandbox handle it just
 * provisioned. Every call goes through `executeCommand`, so the trusted
 * `CommandPolicy` (executable allowlist, argument shapes, timeout, output cap,
 * egress) is applied before the provider is asked to run anything.
 *
 * Paths are resolved inside the sandbox workspace only; traversal, absolute
 * host paths and NUL bytes are rejected. Errors are collapsed to bounded
 * platform codes: no command line, repository content or provider text is
 * echoed to the model or logs.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_QUERY_LENGTH = 1024;
const MAX_ENTRIES = 1000;
const MAX_MATCHES = 1000;
const MAX_PREVIEW = 300;
const DEFAULT_TIMEOUT_MS = 60_000;

const ABS_PATH =
	/^\/(?:[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}\/)*[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}$/;
const QUERY = /^[A-Za-z0-9_.][A-Za-z0-9_./ :@=+,-]{0,1023}$/;
const EXECUTABLE = /^[a-z][a-z0-9-]{0,63}$/;

const PATH_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: ABS_PATH,
	maxLength: MAX_PATH_LENGTH,
};
const QUERY_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: QUERY,
	maxLength: MAX_QUERY_LENGTH,
};

/**
 * Conservative default policy for the read-only tools plus a bounded test
 * runner. Everything else (`sandbox.exec` with other commands, non-read-only
 * git) is denied by the same policy engine the provider uses.
 */
export function createWorkspaceToolPolicy(
	workspaceRoot: string,
): CommandPolicy {
	return {
		workspaceRoot,
		allowlist: [
			{ executable: "cat", args: [PATH_RULE] },
			{ executable: "ls", args: [{ kind: "literal", value: "-1" }, PATH_RULE] },
			{
				executable: "grep",
				args: [{ kind: "literal", value: "-rn" }, QUERY_RULE, PATH_RULE],
			},
			{ executable: "git", args: [{ kind: "literal", value: "status" }] },
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "status" },
					{ kind: "literal", value: "--porcelain" },
				],
			},
			{ executable: "git", args: [{ kind: "literal", value: "diff" }] },
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "diff" },
					{ kind: "literal", value: "--stat" },
				],
			},
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "log" },
					{ kind: "literal", value: "--oneline" },
					{ kind: "literal", value: "-n" },
					{
						kind: "pattern",
						pattern: /^[1-9][0-9]{0,2}$/,
						maxLength: 3,
					},
				],
			},
			{ executable: "bun", args: [{ kind: "literal", value: "test" }] },
			{
				executable: "bun",
				args: [
					{ kind: "literal", value: "run" },
					{ kind: "oneOf", values: ["test", "typecheck", "lint"] },
				],
			},
		],
		maxTimeoutMs: DEFAULT_TIMEOUT_MS,
		maxOutputBytes: MAX_OUTPUT_BYTES,
		egress: { mode: "deny" },
	};
}

export type SandboxToolBackendOptions = {
	provider: SandboxProvider;
	sandbox: SandboxHandle;
	policy: CommandPolicy;
	signal?: AbortSignal;
};

/** Resolves a tool path inside the workspace; never a host path. */
export function resolveSandboxPath(
	workspaceRoot: string,
	input: string,
): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.length > MAX_PATH_LENGTH ||
		input.includes("\0")
	) {
		throw new PlatformError("VALIDATION_FAILED", "invalid sandbox path");
	}
	const clean = input.replace(/\\/g, "/");
	const parts = clean.split("/");
	if (parts.includes("..")) {
		throw new PlatformError("VALIDATION_FAILED", "invalid sandbox path");
	}
	const absolute = clean.startsWith("/") ? clean : `${workspaceRoot}/${clean}`;
	const normalized = `/${absolute
		.split("/")
		.filter((part) => part.length > 0 && part !== ".")
		.join("/")}`;
	try {
		return validateSandboxPath(workspaceRoot, normalized);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "invalid sandbox path");
	}
}

function boundedTimeout(value: number | undefined, policy: CommandPolicy) {
	const requested =
		value === undefined || !Number.isFinite(value)
			? policy.maxTimeoutMs
			: Math.floor(value);
	return Math.max(1, Math.min(requested, policy.maxTimeoutMs));
}

function boundedOutput(value: number | undefined, policy: CommandPolicy) {
	const requested =
		value === undefined || !Number.isFinite(value)
			? policy.maxOutputBytes
			: Math.floor(value);
	return Math.max(1, Math.min(requested, policy.maxOutputBytes));
}

function platformError(error: unknown): PlatformError {
	if (error instanceof PlatformError) return error;
	if (error instanceof SandboxError) {
		switch (error.code) {
			case "POLICY_DENIED":
				return new PlatformError(
					"POLICY_DENIED",
					"sandbox command denied by policy",
				);
			case "CANCELLED":
				return new PlatformError("LEASE_LOST", "sandbox command cancelled");
			case "TIMEOUT":
				return new PlatformError(
					"AGENT_EXECUTION_FAILED",
					"sandbox command timed out",
				);
			case "OUTPUT_LIMIT":
				return new PlatformError(
					"AGENT_EXECUTION_FAILED",
					"sandbox output limit exceeded",
				);
			default:
				return new PlatformError(
					"AGENT_EXECUTION_FAILED",
					"sandbox command failed",
				);
		}
	}
	return new PlatformError("AGENT_EXECUTION_FAILED", "sandbox tool failed");
}

export function createSandboxToolBackend(
	options: SandboxToolBackendOptions,
): SandboxToolBackend {
	const { provider, sandbox, policy, signal } = options;
	if (sandbox.workspaceRoot !== policy.workspaceRoot) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"sandbox policy does not belong to this sandbox",
		);
	}

	async function run(
		executable: string,
		args: readonly string[],
		timeoutMs?: number,
		maxOutputBytes?: number,
	): Promise<CommandResult> {
		if (signal?.aborted) {
			throw new PlatformError("LEASE_LOST", "sandbox command cancelled");
		}
		try {
			return await executeCommand(
				provider,
				sandbox,
				policy,
				{
					executable,
					args: [...args],
					cwd: sandbox.workspaceRoot,
					timeoutMs: boundedTimeout(timeoutMs, policy),
					maxOutputBytes: boundedOutput(maxOutputBytes, policy),
					egress: { mode: "deny" },
				},
				signal,
			);
		} catch (error) {
			throw platformError(error);
		}
	}

	return {
		async readFile(path, readOptions) {
			const absolute = resolveSandboxPath(sandbox.workspaceRoot, path);
			const result = await run(
				"cat",
				[absolute],
				policy.maxTimeoutMs,
				readOptions?.maxBytes,
			);
			if (result.exitCode !== 0) {
				throw new PlatformError("NOT_FOUND", "file could not be read");
			}
			return { content: result.stdout, truncated: false };
		},

		async listFiles(path, listOptions) {
			const absolute = resolveSandboxPath(sandbox.workspaceRoot, path);
			const result = await run("ls", ["-1", absolute]);
			if (result.exitCode !== 0) {
				throw new PlatformError("NOT_FOUND", "directory could not be listed");
			}
			const limit = Math.max(
				1,
				Math.min(listOptions?.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES),
			);
			return result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.slice(0, limit);
		},

		async search(query, searchOptions) {
			if (
				typeof query !== "string" ||
				query.length === 0 ||
				query.length > MAX_QUERY_LENGTH ||
				query.includes("\n")
			) {
				throw new PlatformError("VALIDATION_FAILED", "invalid search query");
			}
			const base =
				searchOptions?.path === undefined
					? sandbox.workspaceRoot
					: resolveSandboxPath(sandbox.workspaceRoot, searchOptions.path);
			const result = await run("grep", ["-rn", query, base]);
			if (result.exitCode !== 0 && result.exitCode !== 1) {
				throw new PlatformError("AGENT_EXECUTION_FAILED", "search failed");
			}
			const limit = Math.max(
				1,
				Math.min(searchOptions?.maxMatches ?? MAX_MATCHES, MAX_MATCHES),
			);
			const matches: Array<{ path: string; line: number; preview: string }> =
				[];
			for (const entry of result.stdout.split("\n")) {
				if (matches.length >= limit) break;
				const match = /^(.+?):(\d+):(.*)$/.exec(entry);
				if (!match) continue;
				const line = Number(match[2]);
				if (!Number.isSafeInteger(line) || line < 1) continue;
				const preview = match[3] ?? "";
				matches.push({
					path: match[1] ?? "",
					line,
					preview:
						preview.length > MAX_PREVIEW
							? `${preview.slice(0, MAX_PREVIEW - 1)}…`
							: preview,
				});
			}
			return matches;
		},

		async exec(argv, execOptions) {
			const executable = argv[0];
			if (
				executable === undefined ||
				!EXECUTABLE.test(executable) ||
				argv.length > 64
			) {
				throw new PlatformError("VALIDATION_FAILED", "invalid command");
			}
			const result = await run(
				executable,
				argv.slice(1),
				execOptions?.timeoutMs,
			);
			return toExecResult(result);
		},

		async git(args, gitOptions) {
			if (args.length === 0 || args.length > 16) {
				throw new PlatformError("VALIDATION_FAILED", "invalid git command");
			}
			const result = await run("git", args, gitOptions?.timeoutMs);
			return toExecResult(result);
		},
	};
}

function toExecResult(result: CommandResult) {
	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		durationMs: result.durationMs,
		truncated: result.outputLimitExceeded,
	};
}
