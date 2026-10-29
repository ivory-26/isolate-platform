import { deny, SandboxError } from "../errors";
import { executeCommand } from "../execute";
import { validateOutputLimit, validateTimeout } from "../policy/command-policy";
import { validateSandboxPath } from "../policy/paths";
import type { SandboxHandle, SandboxProvider } from "../providers/types";

export interface OpenRepoOptions {
	readonly provider: SandboxProvider;
	readonly sandbox: SandboxHandle;
	readonly path: string;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
}

const repoBrand: unique symbol = Symbol("sandbox-repository");
const worktreeBrand: unique symbol = Symbol("sandbox-worktree");
export interface GitRepository {
	readonly path: string;
	readonly sandboxId: string;
	readonly [repoBrand]: true;
}
export interface GitWorktree {
	readonly path: string;
	readonly branch: string;
	readonly [worktreeBrand]: true;
}

type RepoState = Required<OpenRepoOptions>;
const repositories = new WeakMap<GitRepository, RepoState>();
const worktrees = new WeakMap<
	GitWorktree,
	{ repo: GitRepository; removed: boolean }
>();

// Defense in depth INSIDE the sandbox, never a host security boundary.
const GIT_OPTIONS = [
	"--no-pager",
	"--no-optional-locks",
	"--no-replace-objects",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"core.sshCommand=false",
	"-c",
	"credential.helper=",
	"-c",
	"protocol.allow=never",
	"-c",
	"submodule.recurse=false",
	"-c",
	"maintenance.auto=false",
	"-c",
	"gc.auto=0",
] as const;

function state(repo: GitRepository): RepoState {
	const found = repositories.get(repo);
	if (!found) deny("Unknown repository capability");
	return found;
}

async function git(
	options: RepoState,
	args: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	const argv = [...GIT_OPTIONS, ...args];
	const result = await executeCommand(
		options.provider,
		options.sandbox,
		{
			workspaceRoot: options.sandbox.workspaceRoot,
			allowlist: [
				{
					executable: "git",
					args: argv.map((value) => ({ kind: "literal", value })),
				},
			],
			maxTimeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: { mode: "deny" },
		},
		{
			executable: "git",
			args: argv,
			cwd: options.path,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			egress: { mode: "deny" },
		},
		signal,
	);
	if (result.exitCode !== 0)
		throw new SandboxError("GIT_FAILED", "Sandbox Git operation failed");
	return result.stdout;
}

export function taskBranchName(taskId: string): string {
	if (
		typeof taskId !== "string" ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(taskId)
	) {
		deny("Task id must be a lowercase, single-component identifier");
	}
	return `task/${taskId}`;
}

export async function openRepo(
	options: OpenRepoOptions,
	signal?: AbortSignal,
): Promise<GitRepository> {
	validateSandboxPath(options.sandbox.workspaceRoot, options.path);
	const resolved: RepoState = {
		provider: options.provider,
		sandbox: Object.freeze({ ...options.sandbox }),
		path: options.path,
		timeoutMs: validateTimeout(options.timeoutMs ?? 10_000, 30_000),
		maxOutputBytes: validateOutputLimit(
			options.maxOutputBytes ?? 16_384,
			65_536,
		),
	};
	const root = (
		await git(
			resolved,
			["rev-parse", "--path-format=absolute", "--show-toplevel"],
			signal,
		)
	).replace(/\r?\n$/, "");
	if (root !== options.path)
		deny("Expected the exact repository root inside the sandbox");
	const repo: GitRepository = Object.freeze({
		path: options.path,
		sandboxId: options.sandbox.id,
		[repoBrand]: true as const,
	});
	repositories.set(repo, resolved);
	return repo;
}

/** No force/reset: a reused task id fails instead of overwriting an existing branch. */
export async function createBranch(
	repo: GitRepository,
	taskId: string,
	signal?: AbortSignal,
): Promise<string> {
	const options = state(repo);
	const branch = taskBranchName(taskId);
	await git(options, ["branch", "--no-track", "--", branch, "HEAD"], signal);
	return branch;
}

/** Metadata-only: populating files requires a separately isolated checkout operation. */
export async function createWorktree(
	repo: GitRepository,
	taskId: string,
	path: string,
	signal?: AbortSignal,
): Promise<GitWorktree> {
	const options = state(repo);
	const branch = taskBranchName(taskId);
	validateSandboxPath(options.sandbox.workspaceRoot, path);
	if (
		path === options.sandbox.workspaceRoot ||
		path === repo.path ||
		path.startsWith(`${repo.path}/`) ||
		repo.path.startsWith(`${path}/`)
	) {
		deny("Worktree must be separate from the repository checkout");
	}
	await git(
		options,
		["worktree", "add", "--no-checkout", "-b", branch, "--", path, "HEAD"],
		signal,
	);
	const worktree: GitWorktree = Object.freeze({
		path,
		branch,
		[worktreeBrand]: true as const,
	});
	worktrees.set(worktree, { repo, removed: false });
	return worktree;
}

/** Only remove a minted capability; never force-delete dirty data or branches. */
export async function removeWorktree(
	repo: GitRepository,
	worktree: GitWorktree,
	signal?: AbortSignal,
): Promise<void> {
	const options = state(repo);
	const owned = worktrees.get(worktree);
	if (!owned || owned.repo !== repo || owned.removed)
		deny("Unknown or already removed worktree capability");
	await git(options, ["worktree", "remove", "--", worktree.path], signal);
	owned.removed = true;
}
