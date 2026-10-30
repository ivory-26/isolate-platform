import { PlatformError } from "@isolate/shared";
import { z } from "zod";
import {
	createOwnershipMatcher,
	MAX_OWNERSHIP_PATH_LENGTH,
	normalizeOwnershipPath,
} from "./ownership";
import {
	createRiskTablePolicy,
	type ToolName,
	type ToolRiskBand,
} from "./policy";
import {
	type ToolCallContext,
	type ToolDecisionRecord,
	type ToolImplementation,
	type WiredToolRegistry,
	wirePlatformTools,
} from "./registry";
import type { SandboxToolBackend } from "./sandbox-backend";

/**
 * Sandbox-backed tool implementations (waves 4/7).
 *
 * Read-only tools execute for any task. Wave-7 writes (`repo.write_file`,
 * `git.commit_local`) are `scoped_write`: they run only when the changed paths
 * stay inside the task's persisted `fileOwnership`, which is supplied by
 * trusted worker code and never by the model. `git.push_branch` and PR creation
 * are `sensitive` (surfaced as `APPROVAL_REQUIRED` for the worker to execute
 * after a persisted approval); merges, migrations and deploy requests are
 * `destructive` and denied. Argument validation happens inside each
 * implementation so a malformed model call never reaches the sandbox backend,
 * and every failure surfaces as a bounded error code rather than echoing
 * argument values, file content or paths.
 */

const MAX_PATH_LENGTH = 4096;
const MAX_ARGV_ENTRIES = 64;
const MAX_ARGV_LENGTH = 4096;
const MAX_QUERY_LENGTH = 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ENTRIES_LIMIT = 1000;
const MAX_MATCHES_LIMIT = 1000;
/** 256 KiB of UTF-8 content per write. */
const MAX_WRITE_CONTENT_BYTES = 262_144;
const MAX_COMMIT_MESSAGE_LENGTH = 200;
/** Changed files considered for one local commit. */
const MAX_COMMIT_PATHS = 200;

/** Strict: unknown keys are rejected, not silently forwarded. */
const ReadFileArgs = z
	.object({ path: z.string().min(1).max(MAX_PATH_LENGTH) })
	.strict();

const ListFilesArgs = z
	.object({
		path: z.string().min(1).max(MAX_PATH_LENGTH),
		maxEntries: z.number().int().min(1).max(MAX_ENTRIES_LIMIT).optional(),
	})
	.strict();

const SearchArgs = z
	.object({
		query: z.string().min(1).max(MAX_QUERY_LENGTH),
		path: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
		maxMatches: z.number().int().min(1).max(MAX_MATCHES_LIMIT).optional(),
	})
	.strict();

const ArgvSchema = z
	.array(z.string().max(MAX_ARGV_LENGTH))
	.min(1)
	.max(MAX_ARGV_ENTRIES);

const TimeoutSchema = z.number().int().min(1).max(MAX_TIMEOUT_MS).optional();

const ExecArgs = z
	.object({ argv: ArgvSchema, timeoutMs: TimeoutSchema })
	.strict();

const GitReadArgs = z
	.object({ args: ArgvSchema, timeoutMs: TimeoutSchema })
	.strict();

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
	return utf8Encoder.encode(value).byteLength;
}

const WriteFileArgs = z
	.object({
		path: z.string().min(1).max(MAX_OWNERSHIP_PATH_LENGTH),
		content: z
			.string()
			.refine(
				(content) => utf8ByteLength(content) <= MAX_WRITE_CONTENT_BYTES,
				"content exceeds 262144 bytes",
			),
	})
	.strict();

const CommitArgs = z
	.object({ message: z.string().min(1).max(MAX_COMMIT_MESSAGE_LENGTH) })
	.strict();

const NoArgs = z.object({}).strict();

/**
 * Read-only git subcommands. `git.read` is the only git surface exposed to the
 * model; write-capable subcommands (`push`, `commit`, `checkout`, `branch`
 * with arguments, ...) are rejected before the backend sees them.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"cat-file",
	"blame",
	"describe",
	"shortlog",
	"grep",
]);

/** Flags that make an otherwise read-only command write to the filesystem. */
const WRITE_FLAG_PREFIXES = ["--output"] as const;

function parseArgs<T>(
	schema: z.ZodType<T>,
	args: Record<string, unknown>,
	tool: ToolName,
): T {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		// Bounded: never echo argument values back into model context.
		throw new PlatformError(
			"VALIDATION_FAILED",
			`invalid arguments for ${tool}`,
		);
	}
	return parsed.data;
}

function assertReadOnlyGitArgs(args: readonly string[]): void {
	const subcommand = args[0];
	if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"git.read permits read-only subcommands only",
		);
	}
	for (const arg of args) {
		if (WRITE_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
			throw new PlatformError(
				"VALIDATION_FAILED",
				"git.read permits read-only subcommands only",
			);
		}
	}
}

/**
 * Enforces the task's persisted ownership before a write reaches the backend.
 * Empty/absent ownership denies; malformed paths or patterns fail closed.
 */
function assertOwned(
	context: ToolCallContext,
	path: string,
	tool: ToolName,
): void {
	const matcher = createOwnershipMatcher(context.fileOwnership);
	if (!matcher.owns(path)) {
		throw new PlatformError(
			"POLICY_DENIED",
			`${tool} path is outside task ownership`,
		);
	}
}

function execResultValue(result: {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
}): Record<string, unknown> {
	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		durationMs: result.durationMs,
		truncated: result.truncated,
	};
}

/**
 * Wave-7 risk table. Reads are `read_only`; writes are `scoped_write` and are
 * additionally constrained by task ownership; push/PR creation are `sensitive`
 * (the worker executes them only after an approval); merges, migrations and
 * deploys are `destructive` and stay denied.
 */
export const SANDBOX_TOOL_RISKS = {
	"repo.read_file": "read_only",
	"repo.list_files": "read_only",
	"repo.search": "read_only",
	"sandbox.exec": "read_only",
	"git.read": "read_only",
	"git.diff_summary": "read_only",
	"repo.write_file": "scoped_write",
	"git.commit_local": "scoped_write",
	"git.push_branch": "sensitive",
	"github.create_pull_request": "sensitive",
	"github.merge_pull_request": "destructive",
	"db.migrate": "destructive",
	"deploy.request": "destructive",
} as const satisfies Partial<Record<ToolName, ToolRiskBand>>;

export function createSandboxToolImplementations(
	backend: SandboxToolBackend,
): Partial<Record<ToolName, ToolImplementation>> {
	return {
		"repo.read_file": async (args) => {
			const parsed = parseArgs(ReadFileArgs, args, "repo.read_file");
			const result = await backend.readFile(parsed.path);
			return {
				path: parsed.path,
				content: result.content,
				truncated: result.truncated,
			};
		},
		"repo.list_files": async (args) => {
			const parsed = parseArgs(ListFilesArgs, args, "repo.list_files");
			const entries = await backend.listFiles(parsed.path, {
				...(parsed.maxEntries === undefined
					? {}
					: { maxEntries: parsed.maxEntries }),
			});
			return { path: parsed.path, entries: [...entries] };
		},
		"repo.search": async (args) => {
			const parsed = parseArgs(SearchArgs, args, "repo.search");
			const matches = await backend.search(parsed.query, {
				...(parsed.path === undefined ? {} : { path: parsed.path }),
				...(parsed.maxMatches === undefined
					? {}
					: { maxMatches: parsed.maxMatches }),
			});
			return {
				matches: matches.map((match) => ({
					path: match.path,
					line: match.line,
					preview: match.preview,
				})),
			};
		},
		"sandbox.exec": async (args) => {
			const parsed = parseArgs(ExecArgs, args, "sandbox.exec");
			const result = await backend.exec(parsed.argv, {
				...(parsed.timeoutMs === undefined
					? {}
					: { timeoutMs: parsed.timeoutMs }),
			});
			return execResultValue(result);
		},
		"git.read": async (args) => {
			const parsed = parseArgs(GitReadArgs, args, "git.read");
			assertReadOnlyGitArgs(parsed.args);
			const result = await backend.git(parsed.args, {
				...(parsed.timeoutMs === undefined
					? {}
					: { timeoutMs: parsed.timeoutMs }),
			});
			return execResultValue(result);
		},
		"git.diff_summary": async (args) => {
			parseArgs(NoArgs, args, "git.diff_summary");
			const diffSummary = backend.diffSummary?.bind(backend);
			if (diffSummary === undefined) {
				throw new PlatformError(
					"MISSING_CONFIG",
					"sandbox backend has no diff surface",
				);
			}
			const summary = await diffSummary();
			return {
				filesChanged: summary.filesChanged,
				insertions: summary.insertions,
				deletions: summary.deletions,
				files: [...summary.files],
			};
		},
		"repo.write_file": async (args, context) => {
			const parsed = parseArgs(WriteFileArgs, args, "repo.write_file");
			const path = normalizeOwnershipPath(parsed.path);
			if (path === null) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"invalid path for repo.write_file",
				);
			}
			// Ownership is checked before the backend is consulted at all.
			assertOwned(context, path, "repo.write_file");
			const writeFile = backend.writeFile?.bind(backend);
			if (writeFile === undefined) {
				throw new PlatformError(
					"MISSING_CONFIG",
					"sandbox backend has no write surface",
				);
			}
			const result = await writeFile(path, parsed.content, {
				maxBytes: MAX_WRITE_CONTENT_BYTES,
			});
			return {
				path,
				bytesWritten: result.bytesWritten,
				sha256: result.sha256,
			};
		},
		"git.commit_local": async (args, context) => {
			const parsed = parseArgs(CommitArgs, args, "git.commit_local");
			const diffSummary = backend.diffSummary?.bind(backend);
			const pendingPaths = backend.pendingPaths?.bind(backend);
			const commitAll = backend.commitAll?.bind(backend);
			if (
				commitAll === undefined ||
				(pendingPaths === undefined && diffSummary === undefined)
			) {
				throw new PlatformError(
					"MISSING_CONFIG",
					"sandbox backend has no commit surface",
				);
			}
			let files: readonly string[];
			if (pendingPaths !== undefined) {
				files = await pendingPaths();
			} else {
				const summary = await diffSummary?.();
				files = summary?.files ?? [];
				if (
					summary !== undefined &&
					(summary.filesChanged > MAX_COMMIT_PATHS ||
						summary.files.length !== summary.filesChanged)
				) {
					throw new PlatformError(
						"VALIDATION_FAILED",
						"incomplete or oversized diff summary",
					);
				}
			}
			if (files.length === 0) {
				throw new PlatformError("VALIDATION_FAILED", "no changes to commit");
			}
			if (files.length > MAX_COMMIT_PATHS) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"too many changed files to commit",
				);
			}
			const matcher = createOwnershipMatcher(context.fileOwnership);
			if (!files.every((file) => matcher.owns(file))) {
				throw new PlatformError(
					"POLICY_DENIED",
					"commit touches files outside task ownership",
				);
			}
			const result = await commitAll(parsed.message);
			return { commitSha: result.commitSha };
		},
	};
}

export type SandboxToolWiringOptions = {
	/** Optional audit sink only; there is no approval bypass. */
	onDecision?: (record: ToolDecisionRecord) => Promise<void> | void;
};

/**
 * Wires the sandbox tools through the wave-7 risk-table policy. Read-only and
 * scoped-write tools execute (writes are ownership-checked in their
 * implementations); sensitive and destructive bands resolve to structured
 * denials before any implementation runs.
 */
export function wireSandboxTools(
	backend: SandboxToolBackend,
	options: SandboxToolWiringOptions = {},
): WiredToolRegistry {
	return wirePlatformTools({
		policy: createRiskTablePolicy(SANDBOX_TOOL_RISKS),
		implementations: createSandboxToolImplementations(backend),
		onDecision: options.onDecision,
	});
}
