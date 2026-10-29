import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import * as publicApi from "../index";
import { commandPolicy } from "../policy/command-policy";
import {
	createBranch,
	createWorktree,
	openRepo,
	removeWorktree,
} from "./index";
import { createTrustedFixture } from "./trusted-fixture.test-support";

// Each test owns a new platform-temp repository, never the platform checkout.
async function fixtureRepo() {
	const fixture = createTrustedFixture();
	try {
		const repo = await openRepo({
			provider: fixture.provider,
			sandbox: fixture.sandbox,
			path: "/workspace/repo",
		});
		return { ...fixture, repo };
	} catch (error) {
		await fixture.provider.destroy(fixture.sandbox);
		throw error;
	}
}

test("real offline Git: open, branch, create and remove worktree with cleanup", async () => {
	const fixture = await fixtureRepo();
	try {
		const diff = relative(tmpdir(), fixture.directory);
		expect(diff.startsWith("..")).toBe(false);
		expect(isAbsolute(diff)).toBe(false);
		expect(await createBranch(fixture.repo, "one")).toBe("task/one");
		expect(fixture.seed(["branch", "--show-current"]).trim()).toBe("main");
		const worktree = await createWorktree(
			fixture.repo,
			"two",
			"/workspace/worktrees/two",
		);
		expect(worktree.branch).toBe("task/two");
		expect(existsSync(join(fixture.hostPath(worktree.path), ".git"))).toBe(
			true,
		);
		expect(
			fixture.seed(["show-ref", "--verify", "refs/heads/task/two"]),
		).toContain("refs/heads/task/two");
		await removeWorktree(fixture.repo, worktree);
		expect(existsSync(fixture.hostPath(worktree.path))).toBe(false);
		expect(
			fixture.seed(["show-ref", "--verify", "refs/heads/task/two"]),
		).toContain("refs/heads/task/two");
	} finally {
		await fixture.provider.destroy(fixture.sandbox);
	}
	expect(existsSync(fixture.directory)).toBe(false);
	await fixture.provider.destroy(fixture.sandbox);
}, 20000);

test("duplicate task names never reset branches or reuse worktrees", async () => {
	const fixture = await fixtureRepo();
	try {
		await createBranch(fixture.repo, "existing");
		const before = fixture.seed(["rev-parse", "refs/heads/task/existing"]);
		await expect(createBranch(fixture.repo, "existing")).rejects.toMatchObject({
			code: "GIT_FAILED",
		});
		expect(fixture.seed(["rev-parse", "refs/heads/task/existing"])).toBe(
			before,
		);
		const first = await createWorktree(
			fixture.repo,
			"unique",
			"/workspace/worktrees/first",
		);
		await expect(
			createWorktree(fixture.repo, "unique", "/workspace/worktrees/second"),
		).rejects.toMatchObject({ code: "GIT_FAILED" });
		expect(existsSync(fixture.hostPath(first.path))).toBe(true);
		expect(existsSync(fixture.hostPath("/workspace/worktrees/second"))).toBe(
			false,
		);
		await removeWorktree(fixture.repo, first);
	} finally {
		await fixture.provider.destroy(fixture.sandbox);
	}
}, 20000);

test("fixture-planted hooks, fsmonitor, and smudge filters are never executed", async () => {
	const fixture = await fixtureRepo();
	try {
		await Bun.write(
			join(fixture.repoPath, ".gitattributes"),
			"guard.txt filter=guard\n",
		);
		await Bun.write(
			join(fixture.repoPath, "guard.txt"),
			"trusted fixture content\n",
		);
		fixture.seed(["add", "--", ".gitattributes", "guard.txt"]);
		fixture.seed([
			"-c",
			"user.name=Offline Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--no-gpg-sign",
			"-m",
			"Guard fixture",
		]);
		const hooks = join(fixture.repoPath, ".git", "fixture-hooks");
		mkdirSync(hooks);
		for (const name of ["post-checkout", "reference-transaction"]) {
			const path = join(hooks, name);
			await Bun.write(path, "#!/bin/sh\nprintf executed > hook-executed\n");
			chmodSync(path, 0o755);
		}
		fixture.seed(["config", "core.hooksPath", hooks]);
		fixture.seed([
			"config",
			"core.fsmonitor",
			"printf executed > fsmonitor-executed",
		]);
		fixture.seed([
			"config",
			"filter.guard.smudge",
			"printf executed > filter-executed",
		]);
		fixture.seed(["config", "filter.guard.required", "true"]);
		await createBranch(fixture.repo, "hook-safe");
		const worktree = await createWorktree(
			fixture.repo,
			"filter-safe",
			"/workspace/worktrees/filter-safe",
		);
		const worktreePath = fixture.hostPath(worktree.path);
		expect(existsSync(join(worktreePath, "guard.txt"))).toBe(false);
		for (const path of [fixture.repoPath, worktreePath]) {
			for (const marker of [
				"hook-executed",
				"fsmonitor-executed",
				"filter-executed",
			]) {
				expect(existsSync(join(path, marker))).toBe(false);
			}
		}
	} finally {
		await fixture.provider.destroy(fixture.sandbox);
	}
}, 20000);

test("dirty worktree removal refuses to discard files and is retryable", async () => {
	const fixture = await fixtureRepo();
	try {
		const worktree = await createWorktree(
			fixture.repo,
			"dirty",
			"/workspace/worktrees/dirty",
		);
		const file = join(fixture.hostPath(worktree.path), "keep.txt");
		await Bun.write(file, "must not be discarded");
		await expect(removeWorktree(fixture.repo, worktree)).rejects.toMatchObject({
			code: "GIT_FAILED",
		});
		expect(await Bun.file(file).text()).toBe("must not be discarded");
		unlinkSync(file);
		await removeWorktree(fixture.repo, worktree);
	} finally {
		await fixture.provider.destroy(fixture.sandbox);
	}
}, 20000);

test("host fixture is not a public provider and refuses external identities/commands/paths", async () => {
	const fixture = await fixtureRepo();
	try {
		expect("createTrustedFixture" in publicApi).toBe(false);
		expect(() => fixture.hostPath("/workspace-other/repo")).toThrow();
		const request = {
			executable: "git",
			args: ["--version"],
			cwd: "/workspace/repo",
			timeoutMs: 1000,
			maxOutputBytes: 512,
		};
		const command = commandPolicy(
			{
				workspaceRoot: "/workspace",
				allowlist: [
					{
						executable: "git",
						args: [{ kind: "literal", value: "--version" }],
					},
				],
				maxTimeoutMs: 1000,
				maxOutputBytes: 512,
				egress: { mode: "deny" },
			},
			request,
		);
		await expect(
			fixture.provider.execute({ ...fixture.sandbox, id: "external" }, command),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		await expect(
			fixture.provider.execute(fixture.sandbox, command),
		).rejects.toThrow("Fixture requires hardened Git options");
	} finally {
		await fixture.provider.destroy(fixture.sandbox);
	}
}, 20000);
