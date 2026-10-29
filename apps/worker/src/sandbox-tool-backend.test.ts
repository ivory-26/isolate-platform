import { describe, expect, test } from "bun:test";
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
	resolveSandboxPath,
} from "./sandbox-tool-backend";

const ROOT = "/tmp/isolate-task";

function fakeProvider(
	handler: (
		command: AuthorizedCommand,
	) => CommandResult | Promise<CommandResult> = () => ok(),
) {
	const calls: AuthorizedCommand[] = [];
	const provider: SandboxProvider = {
		name: "fake",
		async create(_spec: SandboxSpec): Promise<SandboxHandle> {
			return { id: "sb-1", workspaceRoot: ROOT };
		},
		async execute(_sandbox, command): Promise<CommandResult> {
			calls.push(command);
			return handler(command);
		},
		async destroy() {},
	};
	return { provider, calls };
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

function backend(provider: SandboxProvider, signal?: AbortSignal) {
	return createSandboxToolBackend({
		provider,
		sandbox: { id: "sb-1", workspaceRoot: ROOT },
		policy: createWorkspaceToolPolicy(ROOT),
		signal,
	});
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
