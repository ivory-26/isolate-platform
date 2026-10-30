import { describe, expect, test } from "bun:test";
import type { SandboxToolBackend } from "@isolate/mastra";
import type {
	AuthorizedCommand,
	CommandResult,
	SandboxHandle,
	SandboxProvider,
	SandboxSpec,
} from "@isolate/sandbox";
import {
	createSandboxToolBackend,
	createWorkspaceToolPolicy,
	MAX_WRITE_BYTES,
	resolveSandboxPath,
	WRITE_FILE_SCRIPT,
} from "./sandbox-tool-backend";

const ROOT = "/tmp/isolate-task";

function fakeProvider(
	handler: (
		command: AuthorizedCommand,
	) => CommandResult | Promise<CommandResult> = () => ok(),
) {
	const calls: AuthorizedCommand[] = [];
	const stdins: Array<string | undefined> = [];
	const provider: SandboxProvider = {
		name: "fake",
		async create(_spec: SandboxSpec): Promise<SandboxHandle> {
			return { id: "sb-1", workspaceRoot: ROOT };
		},
		async execute(
			_sandbox,
			command,
			_signal,
			stdinText,
		): Promise<CommandResult> {
			calls.push(command);
			stdins.push(stdinText);
			return handler(command);
		},
		async destroy() {},
	};
	return { provider, calls, stdins };
}

function ok(stdout = "", exitCode = 0): CommandResult {
	return {
		exitCode,
		stdout,
		stderr: "",
		durationMs: 1,
		timedOut: false,
		outputLimitExceeded: false,
	};
}

function backend(
	provider: SandboxProvider,
	signal?: AbortSignal,
	options: { baseBranch?: string; repoPath?: string } = {},
) {
	return createSandboxToolBackend({
		provider,
		sandbox: { id: "sb-1", workspaceRoot: ROOT },
		policy: createWorkspaceToolPolicy(ROOT),
		signal,
		...options,
	});
}

type WriteBackend = SandboxToolBackend &
	Required<
		Pick<
			SandboxToolBackend,
			"writeFile" | "commitAll" | "diffSummary" | "diffPatch"
		>
	>;

/** The worker always implements the write surface; tests assert it does. */
function writeBackend(
	provider: SandboxProvider,
	options: { baseBranch?: string; repoPath?: string } = {},
): WriteBackend {
	return backend(provider, undefined, options) as WriteBackend;
}

describe("resolveSandboxPath", () => {
	test("resolves relative paths under the workspace and keeps absolute ones", () => {
		expect(resolveSandboxPath(ROOT, "src/index.ts")).toBe(
			`${ROOT}/src/index.ts`,
		);
		expect(resolveSandboxPath(ROOT, `${ROOT}/a/b`)).toBe(`${ROOT}/a/b`);
	});

	test("rejects traversal, NUL and host paths", () => {
		expect(() => resolveSandboxPath(ROOT, "../etc/passwd")).toThrow(
			/Invalid sandbox path/i,
		);
		expect(() => resolveSandboxPath(ROOT, "/etc/passwd")).toThrow(
			/Invalid sandbox path/i,
		);
		expect(() => resolveSandboxPath(ROOT, "a\0b")).toThrow(
			/Invalid sandbox path/i,
		);
	});
});

describe("sandbox tool backend", () => {
	test("reads a file through the policy and resolves the path", async () => {
		const { provider, calls } = fakeProvider(() => ok("hello"));
		const result = await backend(provider).readFile("src/index.ts");
		expect(result).toEqual({ content: "hello", truncated: false });
		expect(calls[0].executable).toBe("cat");
		expect(calls[0].args).toEqual([`${ROOT}/src/index.ts`]);
		expect(calls[0].cwd).toBe(ROOT);
	});

	test("lists files, applies the entry cap and maps failures", async () => {
		const { provider } = fakeProvider(() => ok("a.ts\nb.ts\nc.ts\n"));
		const files = await backend(provider).listFiles(".", { maxEntries: 2 });
		expect(files).toEqual(["a.ts", "b.ts"]);

		const { provider: failing } = fakeProvider(() => ok("", 2));
		await expect(backend(failing).listFiles(".")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("parses grep matches and treats exit 1 as no matches", async () => {
		const { provider } = fakeProvider(() =>
			ok(`${ROOT}/src/a.ts:4:const x = 1;\n`),
		);
		expect(await backend(provider).search("const")).toEqual([
			{ path: `${ROOT}/src/a.ts`, line: 4, preview: "const x = 1;" },
		]);

		const { provider: noMatch } = fakeProvider(() => ok("", 1));
		expect(await backend(noMatch).search("absent")).toEqual([]);
	});

	test("denies a non-allowlisted command before the provider runs", async () => {
		const { provider, calls } = fakeProvider();
		await expect(
			backend(provider).exec(["npm", "install"]),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
		expect(calls).toHaveLength(0);
	});

	test("runs an allowlisted command and read-only git", async () => {
		const { provider, calls } = fakeProvider(() => ok("ok"));
		const result = await backend(provider).exec(["bun", "test"]);
		expect(result.exitCode).toBe(0);
		expect(calls[0].executable).toBe("bun");
		expect(calls[0].args).toEqual(["test"]);

		await backend(provider).git(["status", "--porcelain"]);
		expect(calls[1].executable).toBe("git");
		expect(calls[1].args).toEqual(["status", "--porcelain"]);
		await expect(
			backend(provider).git(["push", "origin", "main"]),
		).rejects.toMatchObject({ code: "POLICY_DENIED" });
	});

	test("rejects a path escape before any provider call", async () => {
		const { provider, calls } = fakeProvider();
		await expect(
			backend(provider).readFile("../../etc/passwd"),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});

	test("honours an aborted signal before execution", async () => {
		const { provider, calls } = fakeProvider();
		const controller = new AbortController();
		controller.abort();
		await expect(
			backend(provider, controller.signal).readFile("README.md"),
		).rejects.toMatchObject({ code: "LEASE_LOST" });
		expect(calls).toHaveLength(0);
	});

	test("refuses a policy that belongs to another sandbox", () => {
		const { provider } = fakeProvider();
		expect(() =>
			createSandboxToolBackend({
				provider,
				sandbox: { id: "sb-1", workspaceRoot: ROOT },
				policy: createWorkspaceToolPolicy("/tmp/other"),
			}),
		).toThrow(/does not belong/);
	});
});

describe("sandbox tool backend — wave 7 write surface", () => {
	const COMMIT_SHA = "a".repeat(40);

	test("writes file content through stdin at an absolute workspace path", async () => {
		const { provider, calls, stdins } = fakeProvider(() => ok(""));
		const result = await writeBackend(provider).writeFile(
			"src/index.ts",
			"hello",
		);
		expect(calls[0]).toMatchObject({
			executable: "bun",
			args: ["-e", WRITE_FILE_SCRIPT, `${ROOT}/src/index.ts`],
			cwd: ROOT,
			egress: { mode: "deny" },
		});
		// Content never enters argv.
		expect(calls[0]?.args).not.toContain("hello");
		expect(stdins[0]).toBe("hello");
		expect(result).toEqual({
			bytesWritten: 5,
			sha256: new Bun.CryptoHasher("sha256").update("hello").digest("hex"),
		});
	});

	test("rejects oversize content before the provider runs", async () => {
		const { provider, calls } = fakeProvider();
		await expect(
			writeBackend(provider).writeFile("src/a.ts", "hello", { maxBytes: 4 }),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);

		const huge = "x".repeat(MAX_WRITE_BYTES + 1);
		await expect(
			writeBackend(provider).writeFile("src/a.ts", huge),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});

	test("rejects a traversal path before the provider runs", async () => {
		const { provider, calls } = fakeProvider();
		await expect(
			writeBackend(provider).writeFile("../../etc/passwd", "root"),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});

	test("stages, commits and reads HEAD with the exact argv shapes", async () => {
		const { provider, calls } = fakeProvider((command) =>
			command.args.includes("rev-parse") ? ok(`${COMMIT_SHA}\n`) : ok(""),
		);
		const result = await writeBackend(provider).commitAll("fix widget", {
			authorName: "Agent",
			authorEmail: "agent@example.com",
		});
		expect(result).toEqual({ commitSha: COMMIT_SHA });
		expect(calls).toHaveLength(3);
		expect(calls[0]).toMatchObject({
			executable: "git",
			args: ["add", "-A", "--", "."],
			cwd: `${ROOT}/repo`,
		});
		expect(calls[1]).toMatchObject({
			executable: "git",
			args: [
				"-c",
				"user.name=Agent",
				"-c",
				"user.email=agent@example.com",
				"commit",
				"-m",
				"fix widget",
			],
		});
		expect(calls[2]).toMatchObject({
			executable: "git",
			args: ["rev-parse", "HEAD"],
		});
	});

	test("defaults the commit identity and rejects an invalid message", async () => {
		const { provider, calls } = fakeProvider(() => ok(`${COMMIT_SHA}\n`));
		await writeBackend(provider).commitAll("message");
		expect(calls[1]?.args).toEqual([
			"-c",
			"user.name=Isolate Worker",
			"-c",
			"user.email=worker@isolate.local",
			"commit",
			"-m",
			"message",
		]);
		await expect(
			writeBackend(provider).commitAll("line one\nline two"),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	});

	test("summarises numstat against origin/<base>...HEAD", async () => {
		const { provider, calls } = fakeProvider(() =>
			ok("2\t1\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\timage.png\n"),
		);
		const summary = await writeBackend(provider, {
			baseBranch: "main",
		}).diffSummary();
		expect(summary).toEqual({
			filesChanged: 3,
			insertions: 2,
			deletions: 6,
			files: ["src/a.ts", "src/b.ts", "image.png"],
		});
		expect(calls[0]).toMatchObject({
			executable: "git",
			args: ["diff", "--numstat", "origin/main...HEAD"],
			cwd: `${ROOT}/repo`,
		});
	});

	test("returns a bounded patch and maps an output limit to truncated", async () => {
		const { provider, calls } = fakeProvider(() => ok("diff --git a b\n"));
		const patch = await writeBackend(provider, {
			baseBranch: "main",
		}).diffPatch({ maxBytes: 128 });
		expect(patch).toEqual({ patch: "diff --git a b\n", truncated: false });
		expect(calls[0]).toMatchObject({
			executable: "git",
			args: ["diff", "--no-ext-diff", "--unified=3", "origin/main...HEAD"],
			maxOutputBytes: 128,
		});

		const { provider: limited } = fakeProvider(() => ({
			...ok("x"),
			outputLimitExceeded: true,
		}));
		const truncated = await writeBackend(limited, {
			baseBranch: "main",
		}).diffPatch({ maxBytes: 128 });
		expect(truncated).toEqual({ patch: "", truncated: true });
	});

	test("requires a valid base branch for diff commands", async () => {
		const { provider, calls } = fakeProvider();
		await expect(writeBackend(provider).diffSummary()).rejects.toMatchObject({
			code: "MISSING_CONFIG",
		});
		await expect(
			writeBackend(provider, { baseBranch: "../main" }).diffPatch(),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
		expect(calls).toHaveLength(0);
	});

	test("never puts content into logs or errors", async () => {
		const { provider } = fakeProvider(() => ok("", 1));
		let message = "";
		try {
			await writeBackend(provider).writeFile("src/a.ts", "SECRET_CONTENT");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toContain("SECRET_CONTENT");
		expect(message).not.toContain("src/a.ts");
	});
});
