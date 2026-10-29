import { PlatformError } from "@isolate/shared";
import { z } from "zod";
import { denyByDefault, type ToolName, type ToolRiskBand } from "./policy";
import {
	type ToolDecisionRecord,
	type ToolImplementation,
	type WiredToolRegistry,
	wirePlatformTools,
} from "./registry";
import type { SandboxToolBackend } from "./sandbox-backend";

/**
 * Sandbox-backed tool implementations (wave 4).
 *
 * The five tools below are read-only in the policy table; every other platform
 * tool (writes, pushes, migrations, deploys) stays absent and therefore
 * deny-by-default. Argument validation happens inside the implementation so a
 * malformed model call never reaches the sandbox backend, and failures surface
 * as a bounded `VALIDATION_FAILED` outcome rather than echoing argument values.
 */

const MAX_PATH_LENGTH = 4096;
const MAX_ARGV_ENTRIES = 64;
const MAX_ARGV_LENGTH = 4096;
const MAX_QUERY_LENGTH = 1024;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ENTRIES_LIMIT = 1000;
const MAX_MATCHES_LIMIT = 1000;

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

/** The five sandbox tools are read-only; nothing else is allowlisted. */
export const SANDBOX_TOOL_RISKS = {
	"repo.read_file": "read_only",
	"repo.list_files": "read_only",
	"repo.search": "read_only",
	"sandbox.exec": "read_only",
	"git.read": "read_only",
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
	};
}

export type SandboxToolWiringOptions = {
	/** Optional audit sink only; there is no approval bypass. */
	onDecision?: (record: ToolDecisionRecord) => Promise<void> | void;
};

/**
 * Wires the sandbox tools through the existing deny-by-default policy gate.
 * All five tools are `read_only`; anything else in the registry is denied
 * before any implementation runs.
 */
export function wireSandboxTools(
	backend: SandboxToolBackend,
	options: SandboxToolWiringOptions = {},
): WiredToolRegistry {
	return wirePlatformTools({
		policy: denyByDefault(SANDBOX_TOOL_RISKS),
		implementations: createSandboxToolImplementations(backend),
		onDecision: options.onDecision,
	});
}
