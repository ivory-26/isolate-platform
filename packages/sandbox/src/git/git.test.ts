import { describe, expect, mock, test } from "bun:test";
import type { AuthorizedCommand } from "../policy/command-policy";
import { NullProvider } from "../providers/null";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";
import {
	createBranch,
	createWorktree,
	type GitRepository,
	type GitWorktree,
	openRepo,
	removeWorktree,
	taskBranchName,
} from "./index";

const sandbox: SandboxHandle = { id: "isolated", workspaceRoot: "/workspace" };
function recording() {
	let output: CommandResult = {
		exitCode: 0,
		stdout: "/workspace/repo\n",
		stderr: "",
		durationMs: 1,
		timedOut: false,
		outputLimitExceeded: false,
	};
	const execute = mock(
		async (_handle: SandboxHandle, _command: AuthorizedCommand) => output,
	);
	const provider: SandboxProvider = {
		name: "in-memory",
		create: mock(async () => sandbox),
		execute,
		destroy: mock(async () => {}),
	};
	return {
		provider,
		execute,
		setOutput(value: Partial<CommandResult>) {
			output = { ...output, ...value };
		},
	};
}

describe("Git helpers only cross the sandbox adapter boundary", () => {
	test("all operations are bounded argv with denied network, disabled hooks, no force and no checkout", async () => {
		const fake = recording();
		const repo = await openRepo({
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		});
		fake.setOutput({ stdout: "" });
		expect(await createBranch(repo, "branch-1")).toBe("task/branch-1");
		const worktree = await createWorktree(
			repo,
			"run-2",
			"/workspace/worktrees/run-2",
		);
		await removeWorktree(repo, worktree);
		expect(fake.execute).toHaveBeenCalledTimes(4);
		for (const [handle, command] of fake.execute.mock.calls) {
			expect(handle.id).toBe("isolated");
			expect(command.executable).toBe("git");
			expect(command.cwd).toBe("/workspace/repo");
			expect(command.egress).toEqual({ mode: "deny" });
			expect(command.timeoutMs).toBe(10000);
			expect(command.maxOutputBytes).toBe(16384);
			expect(command.args).toContain("core.hooksPath=/dev/null");
			expect(command.args).toContain("core.fsmonitor=false");
			expect(command.args).toContain("protocol.allow=never");
			expect(command.args).toContain("--no-pager");
			expect(command.args).not.toContain("--force");
		}
		expect(fake.execute.mock.calls[2][1].args.slice(-8)).toEqual([
			"worktree",
			"add",
			"--no-checkout",
			"-b",
			"task/run-2",
			"--",
			"/workspace/worktrees/run-2",
			"HEAD",
		]);
		expect(fake.execute.mock.calls[3][1].args.slice(-4)).toEqual([
			"worktree",
			"remove",
			"--",
			worktree.path,
		]);
		expect(Object.isFrozen(repo)).toBe(true);
		expect(Object.isFrozen(worktree)).toBe(true);
		await expect(removeWorktree(repo, worktree)).rejects.toMatchObject({
			code: "POLICY_DENIED",
		});
		expect(fake.execute).toHaveBeenCalledTimes(4);
	});

	test.each([
		"-c",
		"--force",
		"../other",
		"a/b",
		"a..b",
		"a.lock",
		"a@{b",
		"a b",
		"a;b",
		"a\nb",
		"",
		"A",
		"a".repeat(65),
	])("rejects branch injection %j before dispatch", async (id) => {
		const fake = recording();
		const repo = await openRepo({
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		});
		expect(() => taskBranchName(id)).toThrow();
		await expect(createBranch(repo, id)).rejects.toMatchObject({
			code: "POLICY_DENIED",
		});
		await expect(
			createWorktree(repo, id, "/workspace/worktrees/new"),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		expect(fake.execute).toHaveBeenCalledTimes(1);
	});

	test.each([
		"/workspace",
		"/workspace/repo",
		"/workspace/repo/sub",
		"/outside/new",
		"/workspace-other/new",
		"/workspace/../new",
		"--force",
		"/workspace/-force",
		"/workspace/a;bad",
	])("rejects unsafe worktree path %j", async (path) => {
		const fake = recording();
		const repo = await openRepo({
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		});
		await expect(createWorktree(repo, "safe", path)).rejects.toMatchObject({
			code: "POLICY_DENIED",
		});
		expect(fake.execute).toHaveBeenCalledTimes(1);
	});

	test("requires minted repository and worktree handles, not forged/cross-repo paths", async () => {
		const fake = recording();
		const repo = await openRepo({
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		});
		const other = await openRepo({
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		});
		fake.setOutput({ stdout: "" });
		const worktree = await createWorktree(
			repo,
			"safe",
			"/workspace/worktrees/safe",
		);
		await expect(
			createBranch({ path: repo.path } as GitRepository, "safe"),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			removeWorktree(repo, { path: repo.path } as GitWorktree),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(removeWorktree(other, worktree)).rejects.toMatchObject({
			code: "POLICY_DENIED",
		});
		expect(fake.execute).toHaveBeenCalledTimes(3);
	});

	test("invalid open paths and budgets are rejected before adapter execution", async () => {
		const fake = recording();
		const options = {
			provider: fake.provider,
			sandbox,
			path: "/workspace/repo",
		};
		for (const override of [
			{ path: "C:/host/repo" },
			{ path: "/outside/repo" },
			{ timeoutMs: 30001 },
			{ maxOutputBytes: 65537 },
			{ timeoutMs: 0 },
		]) {
			await expect(openRepo({ ...options, ...override })).rejects.toMatchObject(
				{ code: "POLICY_DENIED" },
			);
		}
		expect(fake.execute).not.toHaveBeenCalled();
	});

	test.each([
		"/outside/repo\n",
		"/workspace/repo/sub\n",
		"/workspace/repo\nextra\n",
	])("rejects unexpected root from provider %j", async (stdout) => {
		const fake = recording();
		fake.setOutput({ stdout });
		await expect(
			openRepo({ provider: fake.provider, sandbox, path: "/workspace/repo" }),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
	});

	test("NullProvider never falls back to local Git", async () => {
		await expect(
			openRepo({
				provider: new NullProvider(),
				sandbox,
				path: "/workspace/repo",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
	});

	test("Git failures do not echo repository-controlled output", async () => {
		const fake = recording();
		fake.setOutput({ exitCode: 128, stderr: "secret-like repository content" });
		await expect(
			openRepo({ provider: fake.provider, sandbox, path: "/workspace/repo" }),
		).rejects.toMatchObject({
			code: "GIT_FAILED",
			message: "Sandbox Git operation failed",
		});
	});
});
