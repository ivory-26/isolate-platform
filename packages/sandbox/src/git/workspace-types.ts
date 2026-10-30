import type { SandboxHandle, SandboxProvider } from "../providers/types";

/**
 * Task workspace contract (wave 7).
 *
 * A task workspace is one repository checkout inside one sandbox. The clone,
 * branch, commit, diff and push operations below are the only supported ways
 * to move repository content; they are argv-only, use the trusted command
 * policy, and never receive a credential as a command argument.
 *
 * The credential travels as create-time sandbox environment (`SandboxSpec.env`)
 * and is consumed by Git through `GIT_CONFIG_*` variables, so `git remote -v`
 * stays clean and no token can reach model context, logs, or event payloads.
 *
 * Implementations live in the owning package; callers only depend on this
 * interface. `createTaskWorkspaceGit` is the expected factory name.
 */
export interface TaskWorkspace {
	/** Absolute path inside the sandbox. */
	readonly path: string;
	/** The branch the workspace was cloned from. */
	readonly baseBranch: string;
}

export type TaskDiffStat = {
	readonly filesChanged: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly files: readonly string[];
};

export type TaskWorkspaceCommitInput = {
	readonly message: string;
	readonly authorName: string;
	readonly authorEmail: string;
};

export type TaskWorkspaceCloneInput = {
	/** Public https repository URL without credentials. */
	readonly repoUrl: string;
	readonly baseBranch: string;
	/** Absolute sandbox path; must be empty or absent. */
	readonly targetPath: string;
	readonly signal?: AbortSignal;
};

export interface TaskWorkspaceGit {
	/** Fails closed when the image lacks git/bun/grep. */
	assertToolchain(signal?: AbortSignal): Promise<void>;
	cloneAndCheckout(
		input: TaskWorkspaceCloneInput,
		signal?: AbortSignal,
	): Promise<TaskWorkspace>;
	createBranch(
		workspace: TaskWorkspace,
		branch: string,
		signal?: AbortSignal,
	): Promise<void>;
	commitAll(
		workspace: TaskWorkspace,
		input: TaskWorkspaceCommitInput,
		signal?: AbortSignal,
	): Promise<{ readonly commitSha: string }>;
	diffStat(
		workspace: TaskWorkspace,
		baseBranch: string,
		signal?: AbortSignal,
	): Promise<TaskDiffStat>;
	/** Bounded patch text; implementations cap both bytes and file count. */
	diffPatch(
		workspace: TaskWorkspace,
		baseBranch: string,
		options?: { readonly maxBytes?: number },
		signal?: AbortSignal,
	): Promise<{ readonly patch: string; readonly truncated: boolean }>;
	pushBranch(
		workspace: TaskWorkspace,
		branch: string,
		signal?: AbortSignal,
	): Promise<void>;
}

export type CreateTaskWorkspaceGit = (input: {
	readonly provider: SandboxProvider;
	readonly sandbox: SandboxHandle;
	readonly signal?: AbortSignal;
}) => TaskWorkspaceGit;
