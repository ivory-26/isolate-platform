import { deny, SandboxError } from "../errors";
import { executeCommand } from "../execute";
import type { EgressPolicy } from "../policy/command-policy";
import { validateSandboxPath } from "../policy/paths";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";
import { GIT_OPTIONS } from "./index";
import type {
	CreateTaskWorkspaceGit,
	TaskDiffStat,
	TaskWorkspace,
	TaskWorkspaceGit,
} from "./workspace-types";

/** Clone/push are the only commands allowed to reach the network. */
export const REMOTE_GIT_HOSTS = ["github.com", "codeload.github.com"] as const;
export const REMOTE_GIT_EGRESS: EgressPolicy = Object.freeze({
	mode: "allowlist",
	hosts: Object.freeze([...REMOTE_GIT_HOSTS]),
});
const DENY_EGRESS: EgressPolicy = Object.freeze({ mode: "deny" });

const TOOLCHAIN_TIMEOUT_MS = 10_000;
const TOOLCHAIN_OUTPUT_BYTES = 4_096;
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_OUTPUT_BYTES = 65_536;
const LOCAL_TIMEOUT_MS = 30_000;
const LOCAL_OUTPUT_BYTES = 16_384;
const PUSH_TIMEOUT_MS = 120_000;
const PUSH_OUTPUT_BYTES = 16_384;

export const MAX_DIFF_FILES = 200;
export const DEFAULT_PATCH_BYTES = 65_536;
export const MAX_PATCH_BYTES = 262_144;

export const DEFAULT_COMMIT_AUTHOR = Object.freeze({
	name: "Isolate Agent",
	email: "agent@isolate.invalid",
});

const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const RAW_REPO_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const AUTHOR_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{0,99}$/;
const AUTHOR_EMAIL =
	/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,63}$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;

interface Context {
	readonly provider: SandboxProvider;
	readonly sandbox: SandboxHandle;
	readonly signal?: AbortSignal;
}

interface RunOptions {
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly egress: EgressPolicy;
}

/** Branch names reach `git` as a single argv element; reject revisions/flags. */
export function validateBranchName(value: string): string {
	if (
		typeof value !== "string" ||
		!BRANCH.test(value) ||
		value.includes("..") ||
		value.startsWith("-") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("//") ||
		value.endsWith(".") ||
		value.endsWith(".lock")
	)
		deny("Branch name is not allowed");
	return value;
}

/**
 * Accepts only a clean `https://github.com/<owner>/<name>(.git)` URL.
 * Userinfo, ports, queries, fragments, percent-encoding and extra segments are
 * rejected so no credential can hide in the URL.
 */
export function validateRepoUrl(value: string): string {
	if (typeof value !== "string" || value.length > 2048)
		deny("Repository URL must be a clean https GitHub URL");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		deny("Repository URL must be a clean https GitHub URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "github.com" ||
		parsed.port !== "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	)
		deny("Repository URL must be a clean https GitHub URL");
	const match = RAW_REPO_URL.exec(value);
	if (!match) deny("Repository URL must be a clean https GitHub URL");
	const owner = match[1];
	const name = match[2];
	if (
		owner === "." ||
		owner === ".." ||
		!OWNER.test(owner) ||
		name === "." ||
		name === ".." ||
		!REPO_NAME.test(name)
	)
		deny("Repository URL must be a clean https GitHub URL");
	return value;
}

/** Single-line commit subject; control characters and runaway length fail. */
export function normalizeCommitMessage(value: string): string {
	if (typeof value !== "string") deny("Commit message must be text");
	const normalized = value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0 || normalized.length > 200)
		deny("Commit message must be a single line of at most 200 characters");
	if (
		Array.from(normalized).some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127;
		})
	)
		deny("Commit message must not contain control characters");
	return normalized;
}

function controlledGitFailure(): SandboxError {
	return new SandboxError("GIT_FAILED", "Sandbox Git operation failed");
}

function unsupportedImage(): SandboxError {
	return new SandboxError(
		"SANDBOX_IMAGE_UNSUPPORTED",
		"Sandbox image is missing a required toolchain binary",
	);
}

async function run(
	context: Context,
	executable: string,
	args: readonly string[],
	options: RunOptions,
	signal?: AbortSignal,
	stdinText?: string,
): Promise<CommandResult> {
	return executeCommand(
		context.provider,
		context.sandbox,
		{
			workspaceRoot: context.sandbox.workspaceRoot,
			allowlist: [
				{
					executable,
					args: args.map((value) => ({ kind: "literal" as const, value })),
				},
			],
			maxTimeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: options.egress,
		},
		{
			executable,
			args,
			cwd: options.cwd,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: options.egress,
		},
		signal ?? context.signal,
		stdinText,
	);
}

/** All Git commands carry the shared hardening flags; no shell is involved. */
async function git(
	context: Context,
	args: readonly string[],
	options: RunOptions,
	signal?: AbortSignal,
): Promise<string> {
	const result = await run(
		context,
		"git",
		[...GIT_OPTIONS, ...args],
		options,
		signal,
	);
	if (result.exitCode !== 0) throw controlledGitFailure();
	return result.stdout;
}

function workspacePath(context: Context, workspace: TaskWorkspace): string {
	if (!workspace || typeof workspace.path !== "string")
		deny("Unknown task workspace");
	return validateSandboxPath(context.sandbox.workspaceRoot, workspace.path);
}

/** Repository operations require the explicit GitHub egress allowlist. */
function remoteEgress(): EgressPolicy {
	return REMOTE_GIT_EGRESS;
}

function authorName(value: string | undefined): string {
	if (value === undefined || value === "") return DEFAULT_COMMIT_AUTHOR.name;
	if (typeof value !== "string" || !AUTHOR_NAME.test(value))
		deny("Commit author name is not allowed");
	return value;
}

function authorEmail(value: string | undefined): string {
	if (value === undefined || value === "") return DEFAULT_COMMIT_AUTHOR.email;
	if (typeof value !== "string" || !AUTHOR_EMAIL.test(value))
		deny("Commit author email is not allowed");
	return value;
}

export type CreateTaskWorkspaceGitOptions =
	Parameters<CreateTaskWorkspaceGit>[0];

export const createTaskWorkspaceGit: CreateTaskWorkspaceGit = (
	input: CreateTaskWorkspaceGitOptions,
): TaskWorkspaceGit => {
	if (!input || typeof input !== "object") deny("Invalid workspace factory");
	if (!input.sandbox || typeof input.sandbox.id !== "string")
		deny("Invalid sandbox handle");
	const context: Context = Object.freeze({
		provider: input.provider,
		sandbox: Object.freeze({ ...input.sandbox }),
		signal: input.signal,
	});
	const remote = remoteEgress();

	async function probe(
		executable: string,
		args: readonly string[],
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			const result = await run(
				context,
				executable,
				args,
				{
					cwd: context.sandbox.workspaceRoot,
					timeoutMs: TOOLCHAIN_TIMEOUT_MS,
					maxOutputBytes: TOOLCHAIN_OUTPUT_BYTES,
					egress: DENY_EGRESS,
				},
				signal,
			);
			return result.exitCode === 0;
		} catch (error) {
			if (
				error instanceof SandboxError &&
				(error.code === "CANCELLED" ||
					error.code === "PROVIDER_UNAVAILABLE" ||
					error.code === "PROVIDER_PROTOCOL")
			)
				throw error;
			return false;
		}
	}

	return {
		async assertToolchain(signal) {
			for (const [executable, args] of [
				["git", ["--version"]],
				["bun", ["--version"]],
				["grep", ["--version"]],
			] as const) {
				if (!(await probe(executable, args, signal))) throw unsupportedImage();
			}
		},

		async cloneAndCheckout(cloneInput, signal) {
			const repoUrl = validateRepoUrl(cloneInput.repoUrl);
			const baseBranch = validateBranchName(cloneInput.baseBranch);
			const targetPath = validateSandboxPath(
				context.sandbox.workspaceRoot,
				cloneInput.targetPath,
			);
			if (targetPath === context.sandbox.workspaceRoot)
				deny("Workspace target must be separate from the sandbox root");
			const egress = remoteEgress();

			// A symlinked target could redirect the clone outside the workspace.
			const symlink = await run(
				context,
				"test",
				["-L", targetPath],
				{
					cwd: context.sandbox.workspaceRoot,
					timeoutMs: TOOLCHAIN_TIMEOUT_MS,
					maxOutputBytes: TOOLCHAIN_OUTPUT_BYTES,
					egress: DENY_EGRESS,
				},
				signal,
			);
			if (symlink.exitCode === 0)
				deny("Workspace target must not be a symbolic link");

			const listing = await run(
				context,
				"ls",
				["-A", "--", targetPath],
				{
					cwd: context.sandbox.workspaceRoot,
					timeoutMs: TOOLCHAIN_TIMEOUT_MS,
					maxOutputBytes: TOOLCHAIN_OUTPUT_BYTES,
					egress: DENY_EGRESS,
				},
				signal,
			);
			if (listing.exitCode === 0 && listing.stdout.trim() !== "")
				deny("Workspace target directory is not empty");

			await git(
				context,
				[
					"-c",
					"protocol.https.allow=always",
					"clone",
					"--depth",
					"1",
					"--single-branch",
					"--branch",
					baseBranch,
					"--no-tags",
					repoUrl,
					targetPath,
				],
				{
					cwd: context.sandbox.workspaceRoot,
					timeoutMs: CLONE_TIMEOUT_MS,
					maxOutputBytes: CLONE_OUTPUT_BYTES,
					egress,
				},
				signal,
			);

			const head = (
				await git(
					context,
					["rev-parse", "--abbrev-ref", "HEAD"],
					{
						cwd: targetPath,
						timeoutMs: LOCAL_TIMEOUT_MS,
						maxOutputBytes: LOCAL_OUTPUT_BYTES,
						egress: DENY_EGRESS,
					},
					signal,
				)
			).trim();
			if (head !== baseBranch) throw controlledGitFailure();
			const sha = (
				await git(
					context,
					["rev-parse", "--verify", "HEAD"],
					{
						cwd: targetPath,
						timeoutMs: LOCAL_TIMEOUT_MS,
						maxOutputBytes: LOCAL_OUTPUT_BYTES,
						egress: DENY_EGRESS,
					},
					signal,
				)
			).trim();
			if (!COMMIT_SHA.test(sha)) throw controlledGitFailure();

			return Object.freeze({ path: targetPath, baseBranch });
		},

		async createBranch(workspace, branch, signal) {
			const path = workspacePath(context, workspace);
			const name = validateBranchName(branch);
			await git(
				context,
				["switch", "-c", name],
				{
					cwd: path,
					timeoutMs: LOCAL_TIMEOUT_MS,
					maxOutputBytes: LOCAL_OUTPUT_BYTES,
					egress: DENY_EGRESS,
				},
				signal,
			);
		},

		async commitAll(workspace, commitInput, signal) {
			const path = workspacePath(context, workspace);
			const message = normalizeCommitMessage(commitInput.message);
			const name = authorName(commitInput.authorName);
			const email = authorEmail(commitInput.authorEmail);
			const options: RunOptions = {
				cwd: path,
				timeoutMs: LOCAL_TIMEOUT_MS,
				maxOutputBytes: LOCAL_OUTPUT_BYTES,
				egress: DENY_EGRESS,
			};
			await git(context, ["add", "-A", "--", "."], options, signal);
			await git(
				context,
				[
					"-c",
					`user.name=${name}`,
					"-c",
					`user.email=${email}`,
					"commit",
					"--no-gpg-sign",
					"-m",
					message,
				],
				options,
				signal,
			);
			const sha = (
				await git(context, ["rev-parse", "HEAD"], options, signal)
			).trim();
			if (!COMMIT_SHA.test(sha)) throw controlledGitFailure();
			return Object.freeze({ commitSha: sha });
		},

		async diffStat(workspace, baseBranch, signal) {
			const path = workspacePath(context, workspace);
			const base = validateBranchName(baseBranch);
			const stdout = await git(
				context,
				["diff", "--numstat", `origin/${base}...HEAD`],
				{
					cwd: path,
					timeoutMs: LOCAL_TIMEOUT_MS,
					maxOutputBytes: CLONE_OUTPUT_BYTES,
					egress: DENY_EGRESS,
				},
				signal,
			);
			const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
			if (lines.length > MAX_DIFF_FILES)
				deny("Diff touches more than 200 files");
			let insertions = 0;
			let deletions = 0;
			const files: string[] = [];
			for (const line of lines) {
				const match = NUMSTAT.exec(line);
				if (!match) throw controlledGitFailure();
				const added = match[1];
				const removed = match[2];
				const file = match[3];
				if (file.startsWith('"') || file.endsWith('"'))
					throw controlledGitFailure();
				if (added !== "-") insertions += Number.parseInt(added, 10);
				if (removed !== "-") deletions += Number.parseInt(removed, 10);
				files.push(file);
			}
			const stat: TaskDiffStat = Object.freeze({
				filesChanged: files.length,
				insertions,
				deletions,
				files: Object.freeze(files),
			});
			return stat;
		},

		async diffPatch(workspace, baseBranch, options, signal) {
			const path = workspacePath(context, workspace);
			const base = validateBranchName(baseBranch);
			const maxBytes = options?.maxBytes ?? DEFAULT_PATCH_BYTES;
			if (
				!Number.isSafeInteger(maxBytes) ||
				maxBytes < 1 ||
				maxBytes > MAX_PATCH_BYTES
			)
				deny("Patch byte budget is not allowed");
			try {
				const result = await run(
					context,
					"git",
					[
						...GIT_OPTIONS,
						"diff",
						"--no-ext-diff",
						"--unified=3",
						`origin/${base}...HEAD`,
					],
					{
						cwd: path,
						timeoutMs: LOCAL_TIMEOUT_MS,
						maxOutputBytes: maxBytes,
						egress: DENY_EGRESS,
					},
					signal,
				);
				if (result.exitCode !== 0) throw controlledGitFailure();
				return Object.freeze({ patch: result.stdout, truncated: false });
			} catch (error) {
				if (error instanceof SandboxError && error.code === "OUTPUT_LIMIT")
					return Object.freeze({ patch: "", truncated: true });
				throw error;
			}
		},

		async pushBranch(workspace, branch, signal) {
			const path = workspacePath(context, workspace);
			const name = validateBranchName(branch);
			await git(
				context,
				["push", "origin", `HEAD:refs/heads/${name}`],
				{
					cwd: path,
					timeoutMs: PUSH_TIMEOUT_MS,
					maxOutputBytes: PUSH_OUTPUT_BYTES,
					egress: remote,
				},
				signal,
			);
		},
	};
};
