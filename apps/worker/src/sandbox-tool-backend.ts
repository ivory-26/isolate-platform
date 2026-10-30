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

/** Wave 7 write surface bounds (the tool layer applies the same caps). */
export const MAX_WRITE_BYTES = 262_144;
export const MAX_DIFF_BYTES = 65_536;
const MAX_DIFF_FILES = 200;
const MAX_COMMIT_MESSAGE_CHARS = 200;
const MAX_AUTHOR_NAME_CHARS = 100;
const MAX_AUTHOR_EMAIL_CHARS = 200;
const MAX_BRANCH_NAME_CHARS = 200;

const DEFAULT_AUTHOR_NAME = "Isolate Worker";
const DEFAULT_AUTHOR_EMAIL = "worker@isolate.local";

/**
 * Trusted file-write executor: argv-only Bun, content arrives on stdin so it
 * never appears in the process list, logs or a shell. Exact literal, part of
 * the command policy below.
 */
export const WRITE_FILE_SCRIPT =
	'const fs=require("fs");fs.writeFileSync(process.argv[1],fs.readFileSync(0))';

const ABS_PATH =
	/^\/(?:[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}\/)*[A-Za-z0-9_][A-Za-z0-9_. -]{0,127}$/;
const QUERY = /^[A-Za-z0-9_.][A-Za-z0-9_./ :@=+,-]{0,1023}$/;
const EXECUTABLE = /^[a-z][a-z0-9-]{0,63}$/;
const COMMIT_MESSAGE = /^[\x20-\x7E]{1,200}$/;
const AUTHOR_NAME_ARG = /^user\.name=[\x20-\x7E]{1,100}$/;
const AUTHOR_EMAIL_ARG =
	/^user\.email=[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DIFF_RANGE = /^origin\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.\.\.HEAD$/;
const BRANCH_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

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
const COMMIT_MESSAGE_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: COMMIT_MESSAGE,
	maxLength: MAX_COMMIT_MESSAGE_CHARS,
};
const AUTHOR_NAME_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: AUTHOR_NAME_ARG,
	maxLength: MAX_AUTHOR_NAME_CHARS + "user.name=".length,
};
const AUTHOR_EMAIL_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: AUTHOR_EMAIL_ARG,
	maxLength: MAX_AUTHOR_EMAIL_CHARS + "user.email=".length,
};
const DIFF_RANGE_RULE: ArgumentRule = {
	kind: "pattern",
	pattern: DIFF_RANGE,
	maxLength: MAX_BRANCH_NAME_CHARS + "origin/...HEAD".length,
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
			// Wave 7 write surface: content is stdin, never argv.
			{
				executable: "bun",
				args: [
					{ kind: "literal", value: "-e" },
					{ kind: "literal", value: WRITE_FILE_SCRIPT },
					PATH_RULE,
				],
			},
			// Commit shape: stage everything, fixed identity config, bounded message.
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "add" },
					{ kind: "literal", value: "-A" },
					{ kind: "literal", value: "--" },
					{ kind: "literal", value: "." },
				],
			},
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "-c" },
					AUTHOR_NAME_RULE,
					{ kind: "literal", value: "-c" },
					AUTHOR_EMAIL_RULE,
					{ kind: "literal", value: "commit" },
					{ kind: "literal", value: "-m" },
					COMMIT_MESSAGE_RULE,
				],
			},
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "rev-parse" },
					{ kind: "literal", value: "HEAD" },
				],
			},
			// Bounded diff shapes against the task base ref.
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "diff" },
					{ kind: "literal", value: "--numstat" },
					DIFF_RANGE_RULE,
				],
			},
			{
				executable: "git",
				args: [
					{ kind: "literal", value: "diff" },
					{ kind: "literal", value: "--no-ext-diff" },
					{ kind: "literal", value: "--unified=3" },
					DIFF_RANGE_RULE,
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
	/**
	 * Wave 7: base branch for `diffSummary`/`diffPatch` (compared as
	 * `origin/<base>...HEAD`). Supplied by the handler from the task context;
	 * the backend never stores a whole `TaskContext`.
	 */
	baseBranch?: string;
	/**
	 * Wave 7: checkout inside the sandbox. Defaults to `<root>/repo`, which is
	 * where the execution handler clones (`${sandbox.workspaceRoot}/repo`).
	 */
	repoPath?: string;
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

function sha256Hex(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function boundedBytes(
	value: number | undefined,
	fallback: number,
	cap: number,
): number {
	const requested =
		value === undefined || !Number.isFinite(value)
			? fallback
			: Math.floor(value);
	return Math.max(1, Math.min(requested, cap));
}

/** `user.name=` / `user.email=` argv values, validated before the policy gate. */
function authorArg(
	kind: "name" | "email",
	value: string | undefined,
	fallback: string,
): string {
	const resolved = value === undefined ? fallback : value;
	const candidate = `user.${kind}=${resolved}`;
	const rule = kind === "name" ? AUTHOR_NAME_ARG : AUTHOR_EMAIL_ARG;
	if (resolved.trim().length === 0 || !rule.test(candidate)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`invalid commit author ${kind}`,
		);
	}
	return candidate;
}

/** True for the mapped form of a sandbox `OUTPUT_LIMIT` failure. */
function isOutputLimit(error: unknown): boolean {
	return (
		error instanceof PlatformError &&
		error.code === "AGENT_EXECUTION_FAILED" &&
		error.message === "sandbox output limit exceeded"
	);
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
	// The handler clones to `<root>/repo`; a caller may override the checkout
	// path, but it always has to resolve inside this workspace.
	const repoPath = resolveSandboxPath(
		sandbox.workspaceRoot,
		options.repoPath ?? `${sandbox.workspaceRoot}/repo`,
	);

	function diffRange(): string {
		const baseBranch = options.baseBranch;
		if (
			typeof baseBranch !== "string" ||
			baseBranch.length === 0 ||
			baseBranch.length > MAX_BRANCH_NAME_CHARS ||
			!BRANCH_NAME.test(baseBranch) ||
			baseBranch
				.split("/")
				.some(
					(segment) =>
						segment === "" ||
						segment === "." ||
						segment === ".." ||
						segment.startsWith("-"),
				)
		) {
			throw new PlatformError(
				"MISSING_CONFIG",
				"workspace base branch is not configured",
			);
		}
		return `origin/${baseBranch}...HEAD`;
	}

	async function run(
		executable: string,
		args: readonly string[],
		timeoutMs?: number,
		maxOutputBytes?: number,
		stdinText?: string,
		cwd?: string,
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
					cwd: cwd ?? sandbox.workspaceRoot,
					timeoutMs: boundedTimeout(timeoutMs, policy),
					maxOutputBytes: boundedOutput(maxOutputBytes, policy),
					egress: { mode: "deny" },
				},
				signal,
				stdinText,
			);
		} catch (error) {
			throw platformError(error);
		}
	}

	return {
		async readFile(path, readOptions) {
			const absolute = resolveSandboxPath(repoPath, path);
			const result = await run(
				"cat",
				[absolute],
				policy.maxTimeoutMs,
				readOptions?.maxBytes,
				undefined,
				repoPath,
			);
			if (result.exitCode !== 0) {
				throw new PlatformError("NOT_FOUND", "file could not be read");
			}
			return { content: result.stdout, truncated: false };
		},

		async listFiles(path, listOptions) {
			const absolute = resolveSandboxPath(repoPath, path);
			const result = await run(
				"ls",
				["-1", absolute],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
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
					? repoPath
					: resolveSandboxPath(repoPath, searchOptions.path);
			const result = await run(
				"grep",
				["-rn", query, base],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
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
				undefined,
				undefined,
				repoPath,
			);
			return toExecResult(result);
		},

		async git(args, gitOptions) {
			if (args.length === 0 || args.length > 16) {
				throw new PlatformError("VALIDATION_FAILED", "invalid git command");
			}
			const result = await run(
				"git",
				args,
				gitOptions?.timeoutMs,
				undefined,
				undefined,
				repoPath,
			);
			return toExecResult(result);
		},

		async writeFile(path, content, writeOptions) {
			const absolute = resolveSandboxPath(repoPath, path);
			if (typeof content !== "string") {
				throw new PlatformError("VALIDATION_FAILED", "invalid file content");
			}
			const bytes = Buffer.byteLength(content, "utf8");
			const limit = boundedBytes(
				writeOptions?.maxBytes,
				MAX_WRITE_BYTES,
				MAX_WRITE_BYTES,
			);
			if (bytes > limit) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"file content exceeds the write budget",
				);
			}
			// Content travels on stdin only: no shell, no argv-sized payload and
			// nothing to observe in a process listing.
			const result = await run(
				"bun",
				["-e", WRITE_FILE_SCRIPT, absolute],
				policy.maxTimeoutMs,
				undefined,
				content,
				repoPath,
			);
			if (result.exitCode !== 0) {
				throw new PlatformError(
					"AGENT_EXECUTION_FAILED",
					"file could not be written",
				);
			}
			return { bytesWritten: bytes, sha256: sha256Hex(content) };
		},

		async commitAll(message, commitOptions) {
			if (typeof message !== "string" || !COMMIT_MESSAGE.test(message)) {
				throw new PlatformError("VALIDATION_FAILED", "invalid commit message");
			}
			const name = authorArg(
				"name",
				commitOptions?.authorName,
				DEFAULT_AUTHOR_NAME,
			);
			const email = authorArg(
				"email",
				commitOptions?.authorEmail,
				DEFAULT_AUTHOR_EMAIL,
			);
			const staged = await run(
				"git",
				["add", "-A", "--", "."],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
			if (staged.exitCode !== 0) {
				throw new PlatformError("GIT_OPERATION_FAILED", "git add failed");
			}
			const committed = await run(
				"git",
				["-c", name, "-c", email, "commit", "-m", message],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
			if (committed.exitCode !== 0) {
				throw new PlatformError("GIT_OPERATION_FAILED", "git commit failed");
			}
			const head = await run(
				"git",
				["rev-parse", "HEAD"],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
			const commitSha = head.stdout.trim();
			if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commitSha)) {
				throw new PlatformError(
					"GIT_OPERATION_FAILED",
					"git commit sha unavailable",
				);
			}
			return { commitSha };
		},

		async diffSummary() {
			const result = await run(
				"git",
				["diff", "--numstat", diffRange()],
				policy.maxTimeoutMs,
				undefined,
				undefined,
				repoPath,
			);
			if (result.exitCode !== 0) {
				throw new PlatformError("GIT_OPERATION_FAILED", "git diff failed");
			}
			let filesChanged = 0;
			let insertions = 0;
			let deletions = 0;
			const files: string[] = [];
			for (const line of result.stdout.split("\n")) {
				if (line.trim() === "") continue;
				const [added, removed, ...pathParts] = line.split("\t");
				if (added === undefined || removed === undefined) continue;
				filesChanged += 1;
				if (Number.isSafeInteger(Number(added))) insertions += Number(added);
				if (Number.isSafeInteger(Number(removed))) {
					deletions += Number(removed);
				}
				if (files.length < MAX_DIFF_FILES) {
					files.push(pathParts.join("\t"));
				}
			}
			return { filesChanged, insertions, deletions, files };
		},

		async diffPatch(patchOptions) {
			const limit = boundedBytes(
				patchOptions?.maxBytes,
				MAX_DIFF_BYTES,
				MAX_DIFF_BYTES,
			);
			try {
				const result = await run(
					"git",
					["diff", "--no-ext-diff", "--unified=3", diffRange()],
					policy.maxTimeoutMs,
					limit,
					undefined,
					repoPath,
				);
				if (result.exitCode !== 0) {
					throw new PlatformError("GIT_OPERATION_FAILED", "git diff failed");
				}
				return { patch: result.stdout, truncated: false };
			} catch (error) {
				// An oversized patch is an explicit truncation, not a failure: the
				// artifact keeps its bounded bytes and the caller sees the flag.
				if (isOutputLimit(error)) return { patch: "", truncated: true };
				throw error;
			}
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
