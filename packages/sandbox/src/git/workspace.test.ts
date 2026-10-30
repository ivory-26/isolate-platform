import { describe, expect, spyOn, test } from "bun:test";
import { SandboxError } from "../errors";
import type { AuthorizedCommand } from "../policy/command-policy";
import { validateEgress } from "../policy/command-policy";
import type {
	CommandResult,
	SandboxHandle,
	SandboxProvider,
} from "../providers/types";
import {
	createTaskWorkspaceGit,
	DEFAULT_COMMIT_AUTHOR,
	DEFAULT_PATCH_BYTES,
	MAX_DIFF_FILES,
	MAX_PATCH_BYTES,
	normalizeCommitMessage,
	REMOTE_GIT_EGRESS,
	validateBranchName,
	validateRepoUrl,
} from "./workspace";
import type { TaskWorkspace, TaskWorkspaceCloneInput } from "./workspace-types";

const sandbox: SandboxHandle = { id: "sb-1", workspaceRoot: "/workspace" };
const TOKEN = "ghs_w7sbx_do_not_leak_0123456789";
const COMMIT = "b".repeat(40);
const HEAD = "a".repeat(40);

function result(overrides: Partial<CommandResult> = {}): CommandResult {
	return {
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 1,
		timedOut: false,
		outputLimitExceeded: false,
		...overrides,
	};
}

type Resolver = (command: AuthorizedCommand) => CommandResult;

/** Scriptable provider that never touches a real sandbox or network. */
const defaultResolver: Resolver = (command) => {
	const args = command.args;
	if (command.executable === "test") return result({ exitCode: 1 });
	if (command.executable === "ls") return result({ exitCode: 2 });
	if (args.includes("--version")) return result({ stdout: "tool 1.0\n" });
	if (args.includes("clone")) return result();
	if (args.includes("--abbrev-ref")) return result({ stdout: "main\n" });
	if (args.includes("--verify")) return result({ stdout: `${HEAD}\n` });
	if (args.includes("--numstat"))
		return result({ stdout: "3\t1\tsrc/a.ts\n0\t2\tsrc/b.ts\n" });
	if (args.includes("--unified=3"))
		return result({ stdout: "diff --git a/x b/x\n" });
	if (args.includes("rev-parse")) return result({ stdout: `${COMMIT}\n` });
	return result();
};

interface Recorded {
	readonly command: AuthorizedCommand;
	readonly stdinText?: string;
}

function recordingProvider(resolve: Resolver = defaultResolver) {
	const calls: Recorded[] = [];
	let destroys = 0;
	const provider: SandboxProvider = {
		name: "recording-fake",
		create: async () => sandbox,
		async execute(_handle, command, _signal, stdinText) {
			calls.push({ command, stdinText });
			return resolve(command);
		},
		async destroy() {
			destroys++;
		},
	};
	return {
		provider,
		calls,
		get destroys() {
			return destroys;
		},
	};
}

function fixture(resolve?: Resolver) {
	const recorded = recordingProvider(resolve);
	const git = createTaskWorkspaceGit({
		provider: recorded.provider,
		sandbox,
	});
	return { ...recorded, git };
}

function cloneInput(
	overrides: Partial<TaskWorkspaceCloneInput> = {},
): TaskWorkspaceCloneInput {
	return {
		repoUrl: "https://github.com/acme/repo.git",
		baseBranch: "main",
		targetPath: "/workspace/repo",
		...overrides,
	};
}

function expectDeniedSync(action: () => unknown): void {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toMatchObject({ code: "POLICY_DENIED" });
}

function cloneCommand(calls: readonly Recorded[]): AuthorizedCommand {
	const found = calls.filter(({ command }) => command.args.includes("clone"));
	expect(found).toHaveLength(1);
	return found[0].command;
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toMatchObject({ code: "POLICY_DENIED" });
}

describe("assertToolchain", () => {
	test("probes git, bun and grep with bounded, offline argv", async () => {
		const { git, calls } = fixture();
		await git.assertToolchain();
		expect(calls.map(({ command }) => command.executable)).toEqual([
			"git",
			"bun",
			"grep",
		]);
		for (const { command } of calls) {
			expect(command.args).toEqual(["--version"]);
			expect(command.cwd).toBe("/workspace");
			expect(command.egress).toEqual({ mode: "deny" });
			expect(command.timeoutMs).toBeLessThanOrEqual(300_000);
			expect(command.maxOutputBytes).toBeLessThanOrEqual(1_048_576);
		}
	});

	test.each([
		["missing binary", result({ exitCode: 127 })],
		["failing binary", result({ exitCode: 1 })],
		["timed out", result({ timedOut: true })],
		["output over budget", result({ outputLimitExceeded: true })],
	] as const)("fails closed for a %s", async (_label, response) => {
		const { git } = fixture(() => response);
		let thrown: unknown;
		try {
			await git.assertToolchain();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			code: "SANDBOX_IMAGE_UNSUPPORTED",
			message: "Sandbox image is missing a required toolchain binary",
		});
	});

	test("propagates provider failures and cancellation instead of blaming the image", async () => {
		const unavailable: SandboxProvider = {
			name: "unavailable",
			create: async () => sandbox,
			execute: async () => {
				throw new SandboxError("PROVIDER_UNAVAILABLE", "transport down");
			},
			destroy: async () => {},
		};
		const git = createTaskWorkspaceGit({ provider: unavailable, sandbox });
		await expect(git.assertToolchain()).rejects.toMatchObject({
			code: "PROVIDER_UNAVAILABLE",
		});
		const recorded = fixture();
		await expect(
			recorded.git.assertToolchain(AbortSignal.abort()),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(recorded.calls).toHaveLength(0);
	});
});

describe("URL and branch validation", () => {
	test.each([
		"https://github.com/acme/repo",
		"https://github.com/acme/repo.git",
		"https://github.com/acme-org/repo.name",
		"https://github.com/a/b",
	])("accepts clean URL %s", (url) => {
		expect(validateRepoUrl(url)).toBe(url);
	});

	test.each([
		"http://github.com/acme/repo",
		"git://github.com/acme/repo",
		"ssh://github.com/acme/repo",
		"https://evil.com/acme/repo",
		"https://github.com.evil.com/acme/repo",
		"https://token@github.com/acme/repo",
		"https://user:pass@github.com/acme/repo",
		"https://github.com:443/acme/repo",
		"https://github.com/acme/repo?ref=main",
		"https://github.com/acme/repo#readme",
		"https://github.com/acme/../repo",
		"https://github.com/acme/repo/tree/main",
		"https://github.com/acme/repo/",
		"https://github.com/acme/%2e%2e",
		"https://github.com//repo",
		"",
		"not-a-url",
	])("rejects unsafe URL %j", (url) => {
		expectDeniedSync(() => validateRepoUrl(url));
	});

	test("rejects unsafe URLs before dispatch", async () => {
		const { git, calls } = fixture();
		await expectDenied(git.cloneAndCheckout(cloneInput({ repoUrl: TOKEN })));
		await expectDenied(
			git.cloneAndCheckout(
				cloneInput({ repoUrl: `https://${TOKEN}@github.com/acme/repo` }),
			),
		);
		expect(calls).toHaveLength(0);
	});

	test.each([
		"main",
		"feature/x-1",
		"release/v1.2.3",
		"a_b.c",
	])("accepts branch %j", (branch) => {
		expect(validateBranchName(branch)).toBe(branch);
	});

	test.each([
		"",
		"-x",
		"a..b",
		"a b",
		"a;b",
		"a\nb",
		"a$b",
		"/x",
		"x/",
		"a//b",
		"x.",
		"x.lock",
		"x".repeat(121),
	])("rejects unsafe branch %j", (branch) => {
		expectDeniedSync(() => validateBranchName(branch));
	});

	test("rejects unsafe base branches and task branches before dispatch", async () => {
		const { git, calls } = fixture();
		await expectDenied(
			git.cloneAndCheckout(cloneInput({ baseBranch: "-main" })),
		);
		await expectDenied(
			git.createBranch({ path: "/workspace/repo", baseBranch: "main" }, "-x"),
		);
		expect(calls).toHaveLength(0);
	});
});

describe("cloneAndCheckout", () => {
	test("validates an empty target and clones one shallow branch from the clean URL", async () => {
		const { git, calls } = fixture();
		const workspace = await git.cloneAndCheckout(cloneInput(), undefined);
		expect(workspace).toEqual({
			path: "/workspace/repo",
			baseBranch: "main",
		});
		expect(Object.isFrozen(workspace)).toBe(true);

		const command = cloneCommand(calls);
		expect(command.executable).toBe("git");
		expect(command.egress).toEqual({
			mode: "allowlist",
			hosts: ["github.com", "codeload.github.com"],
		});
		expect(command.cwd).toBe("/workspace");
		expect(command.timeoutMs).toBe(120_000);
		expect(command.args).toContain("core.hooksPath=/dev/null");
		expect(command.args).toContain("core.fsmonitor=false");
		expect(command.args).toContain("protocol.allow=never");
		expect(command.args).toContain("protocol.https.allow=always");
		expect(command.args.join(" ")).not.toContain("--recursive");
		expect(command.args.slice(-9)).toEqual([
			"clone",
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			"main",
			"--no-tags",
			"https://github.com/acme/repo.git",
			"/workspace/repo",
		]);
		const verification = calls.filter(({ command: call }) =>
			call.args.includes("rev-parse"),
		);
		expect(verification.map(({ command: call }) => call.cwd)).toEqual([
			"/workspace/repo",
			"/workspace/repo",
		]);
		for (const { command: call } of verification)
			expect(call.egress).toEqual({ mode: "deny" });
	});

	test("rejects a non-empty, symlinked, root or out-of-sandbox target before cloning", async () => {
		const occupied = fixture((command) =>
			command.executable === "ls"
				? result({ exitCode: 0, stdout: "stray.txt\n" })
				: defaultResolver(command),
		);
		await expectDenied(occupied.git.cloneAndCheckout(cloneInput()));
		expect(
			occupied.calls.some(({ command }) => command.args.includes("clone")),
		).toBe(false);

		const symlinked = fixture((command) =>
			command.executable === "test"
				? result({ exitCode: 0 })
				: defaultResolver(command),
		);
		await expectDenied(symlinked.git.cloneAndCheckout(cloneInput()));
		expect(
			symlinked.calls.some(({ command }) => command.args.includes("clone")),
		).toBe(false);

		const { git, calls } = fixture();
		await expectDenied(
			git.cloneAndCheckout(cloneInput({ targetPath: "/workspace" })),
		);
		await expectDenied(
			git.cloneAndCheckout(cloneInput({ targetPath: "/outside/repo" })),
		);
		await expectDenied(
			git.cloneAndCheckout(cloneInput({ targetPath: "/workspace/../repo" })),
		);
		expect(calls).toHaveLength(0);
	});

	test("accepts an empty listing and an absent target", async () => {
		const empty = fixture((command) =>
			command.executable === "ls"
				? result({ exitCode: 0, stdout: "\n" })
				: defaultResolver(command),
		);
		await empty.git.cloneAndCheckout(cloneInput());
		expect(cloneCommand(empty.calls)).toBeDefined();

		const absent = fixture();
		await absent.git.cloneAndCheckout(cloneInput());
		expect(cloneCommand(absent.calls)).toBeDefined();
	});

	test("fails closed when clone fails or HEAD/branch does not match", async () => {
		const failed = fixture((command) =>
			command.args.includes("clone")
				? result({ exitCode: 128, stderr: "fatal: secret repo content" })
				: defaultResolver(command),
		);
		let thrown: unknown;
		try {
			await failed.git.cloneAndCheckout(cloneInput());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			code: "GIT_FAILED",
			message: "Sandbox Git operation failed",
		});
		expect((thrown as Error).message).not.toContain("secret");

		const wrongBranch = fixture((command) =>
			command.args.includes("--abbrev-ref")
				? result({ stdout: "other\n" })
				: defaultResolver(command),
		);
		await expect(
			wrongBranch.git.cloneAndCheckout(cloneInput()),
		).rejects.toMatchObject({ code: "GIT_FAILED" });
	});
});

describe("createBranch and commitAll", () => {
	test("creates a new branch without force or reuse", async () => {
		const { git, calls } = fixture();
		await git.createBranch(
			{ path: "/workspace/repo", baseBranch: "main" },
			"feature/x",
		);
		const command = calls[0].command;
		expect(command.args.slice(-3)).toEqual(["switch", "-c", "feature/x"]);
		expect(command.args).not.toContain("--force");
		expect(command.args).not.toContain("-f");
		expect(command.egress).toEqual({ mode: "deny" });
	});

	test("rejects a forged workspace path before dispatch", async () => {
		const { git, calls } = fixture();
		await expectDenied(
			git.createBranch(
				{ path: "/outside/repo", baseBranch: "main" } as TaskWorkspace,
				"task/x",
			),
		);
		expect(calls).toHaveLength(0);
	});

	test("stages everything, commits with trusted author config, and returns HEAD", async () => {
		const { git, calls } = fixture();
		const committed = await git.commitAll(
			{ path: "/workspace/repo", baseBranch: "main" },
			{
				message: "fix:  two\n\nlines\tnow ",
				authorName: "Acme Bot",
				authorEmail: "bot@example.com",
			},
		);
		expect(committed).toEqual({ commitSha: COMMIT });
		expect(calls[0].command.args.slice(-4)).toEqual(["add", "-A", "--", "."]);
		const commit = calls[1].command.args;
		expect(commit).toContain("user.name=Acme Bot");
		expect(commit).toContain("user.email=bot@example.com");
		expect(commit).toContain("--no-gpg-sign");
		expect(commit[commit.indexOf("-m") + 1]).toBe("fix: two lines now");
		expect(calls[2].command.args.slice(-2)).toEqual(["rev-parse", "HEAD"]);
	});

	test("uses trusted author defaults when the caller supplies none", async () => {
		const { git, calls } = fixture();
		await git.commitAll(
			{ path: "/workspace/repo", baseBranch: "main" },
			{ message: "chore: default", authorName: "", authorEmail: "" },
		);
		const commit = calls[1].command.args;
		expect(commit).toContain(`user.name=${DEFAULT_COMMIT_AUTHOR.name}`);
		expect(commit).toContain(`user.email=${DEFAULT_COMMIT_AUTHOR.email}`);
	});

	test.each([
		["empty message", { message: "   " }],
		["oversized message", { message: "m".repeat(201) }],
		["control character", { message: "a\u0000b" }],
		["injected author name", { authorName: "Bot\n-e" }],
		["injected author email", { authorEmail: "bot@example.com -c x=y" }],
	] as const)("rejects an %s before dispatch", async (_label, override) => {
		const { git, calls } = fixture();
		await expectDenied(
			git.commitAll(
				{ path: "/workspace/repo", baseBranch: "main" },
				{
					message: "chore: safe",
					authorName: "Acme Bot",
					authorEmail: "bot@example.com",
					...override,
				},
			),
		);
		expect(calls).toHaveLength(0);
	});

	test("normalizes commit messages to one bounded line", () => {
		expect(normalizeCommitMessage(" a\n\nb\tc ")).toBe("a b c");
		expectDeniedSync(() => normalizeCommitMessage(""));
	});

	test("rejects a malformed HEAD from the provider", async () => {
		const { git } = fixture((command) =>
			command.args.includes("rev-parse")
				? result({ stdout: "not-a-sha\n" })
				: defaultResolver(command),
		);
		await expect(
			git.commitAll(
				{ path: "/workspace/repo", baseBranch: "main" },
				{
					message: "chore: x",
					authorName: "Acme Bot",
					authorEmail: "bot@example.com",
				},
			),
		).rejects.toMatchObject({ code: "GIT_FAILED" });
	});
});

describe("diffStat and diffPatch", () => {
	test("parses numstat within the file cap", async () => {
		const { git, calls } = fixture();
		const stat = await git.diffStat(
			{ path: "/workspace/repo", baseBranch: "main" },
			"main",
		);
		expect(stat).toEqual({
			filesChanged: 2,
			insertions: 3,
			deletions: 3,
			files: ["src/a.ts", "src/b.ts"],
		});
		expect(Object.isFrozen(stat)).toBe(true);
		expect(Object.isFrozen(stat.files)).toBe(true);
		const command = calls[0].command;
		expect(command.args.slice(-3)).toEqual([
			"diff",
			"--numstat",
			"origin/main...HEAD",
		]);
		expect(command.egress).toEqual({ mode: "deny" });
	});

	test("counts binary entries without inventing line counts", async () => {
		const { git } = fixture((command) =>
			command.args.includes("--numstat")
				? result({ stdout: "-\t-\tassets/logo.png\n" })
				: defaultResolver(command),
		);
		const stat = await git.diffStat(
			{ path: "/workspace/repo", baseBranch: "main" },
			"main",
		);
		expect(stat).toEqual({
			filesChanged: 1,
			insertions: 0,
			deletions: 0,
			files: ["assets/logo.png"],
		});
	});

	test("rejects more than the file cap, malformed lines and quoted paths", async () => {
		const lines = Array.from(
			{ length: MAX_DIFF_FILES + 1 },
			(_, index) => `1\t0\tfile-${index}.ts`,
		).join("\n");
		const over = fixture((command) =>
			command.args.includes("--numstat")
				? result({ stdout: `${lines}\n` })
				: defaultResolver(command),
		);
		await expectDenied(
			over.git.diffStat(
				{ path: "/workspace/repo", baseBranch: "main" },
				"main",
			),
		);

		const malformed = fixture((command) =>
			command.args.includes("--numstat")
				? result({ stdout: "garbage\n" })
				: defaultResolver(command),
		);
		await expect(
			malformed.git.diffStat(
				{ path: "/workspace/repo", baseBranch: "main" },
				"main",
			),
		).rejects.toMatchObject({ code: "GIT_FAILED" });

		const quoted = fixture((command) =>
			command.args.includes("--numstat")
				? result({ stdout: '1\t0\t"a\\tb.ts"\n' })
				: defaultResolver(command),
		);
		await expect(
			quoted.git.diffStat(
				{ path: "/workspace/repo", baseBranch: "main" },
				"main",
			),
		).rejects.toMatchObject({ code: "GIT_FAILED" });
	});

	test("bounds the patch command by the requested byte budget", async () => {
		const { git, calls } = fixture();
		const patch = await git.diffPatch(
			{ path: "/workspace/repo", baseBranch: "main" },
			"main",
		);
		expect(patch).toEqual({
			patch: "diff --git a/x b/x\n",
			truncated: false,
		});
		const diff = calls[0].command.args;
		expect(diff).toContain("--no-ext-diff");
		expect(diff).toContain("--unified=3");
		expect(diff).toContain("origin/main...HEAD");
		expect(diff).not.toContain("--ext-diff");
		expect(calls[0].command.maxOutputBytes).toBe(DEFAULT_PATCH_BYTES);

		const sized = fixture();
		await sized.git.diffPatch(
			{ path: "/workspace/repo", baseBranch: "main" },
			"main",
			{ maxBytes: 1024 },
		);
		expect(sized.calls[0].command.maxOutputBytes).toBe(1024);
	});

	test("returns a truncated stat-only marker when the patch exceeds its budget", async () => {
		const { git } = fixture((command) =>
			command.args.includes("--unified=3")
				? result({ outputLimitExceeded: true, stdout: "x".repeat(32) })
				: defaultResolver(command),
		);
		const patch = await git.diffPatch(
			{ path: "/workspace/repo", baseBranch: "main" },
			"main",
		);
		expect(patch).toEqual({ patch: "", truncated: true });
	});

	test.each([
		0,
		-1,
		1.5,
		MAX_PATCH_BYTES + 1,
	])("rejects an invalid patch budget %s", async (maxBytes) => {
		const { git, calls } = fixture();
		await expectDenied(
			git.diffPatch({ path: "/workspace/repo", baseBranch: "main" }, "main", {
				maxBytes,
			}),
		);
		expect(calls).toHaveLength(0);
	});
});

describe("pushBranch", () => {
	test("pushes only the isolated branch with GitHub egress and no force", async () => {
		const { git, calls } = fixture();
		await git.pushBranch(
			{ path: "/workspace/repo", baseBranch: "main" },
			"task/abc",
		);
		const command = calls[0].command;
		expect(command.args.slice(-3)).toEqual([
			"push",
			"origin",
			"HEAD:refs/heads/task/abc",
		]);
		expect(command.args).not.toContain("--force");
		expect(command.args).not.toContain("-f");
		expect(command.egress).toEqual(REMOTE_GIT_EGRESS);
	});

	test("is refused when the trusted policy denies egress", () => {
		expectDeniedSync(() => validateEgress(REMOTE_GIT_EGRESS, { mode: "deny" }));
		expectDeniedSync(() =>
			validateEgress(REMOTE_GIT_EGRESS, {
				mode: "allowlist",
				hosts: ["github.com"],
			}),
		);
	});

	test("a provider that denies egress refuses the push before any output", async () => {
		const provider: SandboxProvider = {
			name: "egress-denied",
			create: async () => sandbox,
			execute: async () => {
				throw new SandboxError("POLICY_DENIED", "Egress is denied");
			},
			destroy: async () => {},
		};
		const git = createTaskWorkspaceGit({ provider, sandbox });
		await expect(
			git.pushBranch({ path: "/workspace/repo", baseBranch: "main" }, "task/a"),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
	});
});

describe("credential and process hygiene", () => {
	test("no token or userinfo appears in any argv across every operation", async () => {
		const { git, calls } = fixture();
		await git.assertToolchain();
		await git.cloneAndCheckout(cloneInput());
		const workspace = { path: "/workspace/repo", baseBranch: "main" };
		await git.createBranch(workspace, "task/abc");
		await git.commitAll(workspace, {
			message: "chore: x",
			authorName: "Acme Bot",
			authorEmail: "bot@example.com",
		});
		await git.diffStat(workspace, "main");
		await git.diffPatch(workspace, "main");
		await git.pushBranch(workspace, "task/abc");
		for (const { command } of calls) {
			for (const arg of command.args) {
				expect(arg).not.toContain(TOKEN);
				expect(arg).not.toContain("x-access-token");
			}
			expect(command.executable).not.toContain("/");
		}
		const clone = cloneCommand(calls);
		const url = clone.args[clone.args.indexOf("--no-tags") + 1];
		expect(url).not.toContain("@");
		expect(url).toBe("https://github.com/acme/repo.git");
	});

	test("never spawns a host process and never destroys the sandbox", async () => {
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
			throw new Error("host execution forbidden");
		});
		try {
			const { git, destroys } = fixture();
			await git.assertToolchain();
			await git.cloneAndCheckout(cloneInput());
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
			expect(destroys).toBe(0);
		} finally {
			spawn.mockRestore();
			spawnSync.mockRestore();
		}
	});
});
