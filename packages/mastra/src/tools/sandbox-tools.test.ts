import { describe, expect, test } from "bun:test";
import type {
	ToolCallContext,
	ToolDecisionRecord,
	WiredToolCollection,
	WiredToolOutput,
} from "./registry";
import type {
	SandboxExecResult,
	SandboxSearchMatch,
	SandboxToolBackend,
} from "./sandbox-backend";
import {
	createSandboxToolImplementations,
	SANDBOX_TOOL_RISKS,
	wireSandboxTools,
} from "./sandbox-tools";

const taskContext: ToolCallContext = {
	organizationId: "org-1",
	taskId: "task-1",
	scopes: ["repo:read"],
};

const ownedContext: ToolCallContext = {
	...taskContext,
	fileOwnership: ["src/**"],
};

type DiffSummary = {
	filesChanged: number;
	insertions: number;
	deletions: number;
	files: string[];
};

type BackendCalls = {
	readFile: string[];
	listFiles: string[];
	search: string[];
	exec: (readonly string[])[];
	git: (readonly string[])[];
	writeFile: { path: string; content: string }[];
	commitAll: string[];
	diffSummary: number;
};

function emptyCalls(): BackendCalls {
	return {
		readFile: [],
		listFiles: [],
		search: [],
		exec: [],
		git: [],
		writeFile: [],
		commitAll: [],
		diffSummary: 0,
	};
}

function execResult(stdout = "ok"): SandboxExecResult {
	return {
		exitCode: 0,
		stdout,
		stderr: "",
		durationMs: 5,
		truncated: false,
	};
}

function fakeBackend(diff?: DiffSummary): {
	backend: SandboxToolBackend;
	calls: BackendCalls;
} {
	const calls = emptyCalls();
	const backend: SandboxToolBackend = {
		async readFile(path) {
			calls.readFile.push(path);
			return { content: `content:${path}`, truncated: false };
		},
		async listFiles(path) {
			calls.listFiles.push(path);
			return [`${path}/a.ts`, `${path}/b.ts`];
		},
		async search(query) {
			calls.search.push(query);
			return [
				{ path: "src/a.ts", line: 3, preview: `${query} preview` },
			] satisfies SandboxSearchMatch[];
		},
		async exec(argv) {
			calls.exec.push(argv);
			return execResult("exec-ok");
		},
		async git(args) {
			calls.git.push(args);
			return execResult("git-ok");
		},
		async writeFile(path, content) {
			calls.writeFile.push({ path, content });
			return {
				bytesWritten: Buffer.byteLength(content, "utf8"),
				sha256: `sha:${path}`,
			};
		},
		async commitAll(message) {
			calls.commitAll.push(message);
			return { commitSha: "0123456789abcdef" };
		},
		async diffSummary() {
			calls.diffSummary += 1;
			return (
				diff ?? {
					filesChanged: 1,
					insertions: 2,
					deletions: 1,
					files: ["src/a.ts"],
				}
			);
		},
	};
	return { backend, calls };
}

/** Read-only backend: the optional wave-7 write surface is absent. */
function readOnlyBackend(): SandboxToolBackend {
	return {
		async readFile() {
			return { content: "", truncated: false };
		},
		async listFiles() {
			return [];
		},
		async search() {
			return [];
		},
		async exec() {
			return execResult();
		},
		async git() {
			return execResult();
		},
	};
}

async function callTool(
	registry: ReturnType<typeof wireSandboxTools>,
	name: keyof WiredToolCollection,
	args: Record<string, unknown> = {},
	context: ToolCallContext = taskContext,
): Promise<WiredToolOutput> {
	const collection = registry.forTask(context);
	const tool = collection[name];
	const execute = tool.execute;
	if (!execute) throw new Error(`tool ${String(name)} has no execute`);
	return (await execute(args, {} as never)) as WiredToolOutput;
}

describe("sandbox tools behind the policy gate", () => {
	test("read-only tools execute through the injected backend", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);

		expect(
			await callTool(registry, "repo.read_file", { path: "src/a.ts" }),
		).toEqual({
			state: "executed",
			audited: true,
			value: {
				path: "src/a.ts",
				content: "content:src/a.ts",
				truncated: false,
			},
		});
		expect(
			await callTool(registry, "repo.list_files", {
				path: "src",
				maxEntries: 10,
			}),
		).toEqual({
			state: "executed",
			audited: true,
			value: { path: "src", entries: ["src/a.ts", "src/b.ts"] },
		});
		expect(
			await callTool(registry, "repo.search", { query: "needle", path: "src" }),
		).toEqual({
			state: "executed",
			audited: true,
			value: {
				matches: [{ path: "src/a.ts", line: 3, preview: "needle preview" }],
			},
		});
		expect(
			await callTool(registry, "sandbox.exec", {
				argv: ["bun", "test"],
				timeoutMs: 1000,
			}),
		).toEqual({
			state: "executed",
			audited: true,
			value: {
				exitCode: 0,
				stdout: "exec-ok",
				stderr: "",
				durationMs: 5,
				truncated: false,
			},
		});

		expect(calls.readFile).toEqual(["src/a.ts"]);
		expect(calls.listFiles).toEqual(["src"]);
		expect(calls.search).toEqual(["needle"]);
		expect(calls.exec).toEqual([["bun", "test"]]);
	});

	test("git.read executes read-only subcommands", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		const output = await callTool(registry, "git.read", {
			args: ["status", "--porcelain"],
		});
		expect(output).toEqual({
			state: "executed",
			audited: true,
			value: {
				exitCode: 0,
				stdout: "git-ok",
				stderr: "",
				durationMs: 5,
				truncated: false,
			},
		});
		expect(calls.git).toEqual([["status", "--porcelain"]]);
	});

	test("git.read rejects write subcommands before touching the backend", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(registry, "git.read", {
				args: ["push", "origin", "main"],
			}),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(
			await callTool(registry, "git.read", {
				args: ["log", "--output=leak.txt"],
			}),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.git).toEqual([]);
	});

	test("sensitive tools require approval and destructive tools stay denied", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(await callTool(registry, "git.push_branch")).toEqual({
			state: "denied",
			reason: "APPROVAL_REQUIRED",
		});
		expect(await callTool(registry, "github.create_pull_request")).toEqual({
			state: "denied",
			reason: "APPROVAL_REQUIRED",
		});
		expect(await callTool(registry, "github.merge_pull_request")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(await callTool(registry, "db.migrate")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(await callTool(registry, "deploy.request")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(calls).toEqual(emptyCalls());
	});

	test("invalid arguments fail VALIDATION_FAILED without a backend call", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(await callTool(registry, "repo.read_file", {})).toEqual({
			state: "failed",
			code: "VALIDATION_FAILED",
		});
		expect(await callTool(registry, "repo.read_file", { path: 42 })).toEqual({
			state: "failed",
			code: "VALIDATION_FAILED",
		});
		expect(
			await callTool(registry, "repo.read_file", {
				path: "a",
				code: "import('os')",
			}),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(await callTool(registry, "sandbox.exec", { argv: [] })).toEqual({
			state: "failed",
			code: "VALIDATION_FAILED",
		});
		expect(
			await callTool(registry, "repo.search", { query: "x", maxMatches: 0 }),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.readFile).toEqual([]);
		expect(calls.exec).toEqual([]);
		expect(calls.search).toEqual([]);
	});

	test("risk table maps reads, writes, sensitive and destructive bands", () => {
		expect(SANDBOX_TOOL_RISKS).toEqual({
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
		});
		const implementations = createSandboxToolImplementations(
			fakeBackend().backend,
		);
		expect(Object.keys(implementations).sort()).toEqual([
			"git.commit_local",
			"git.diff_summary",
			"git.read",
			"repo.list_files",
			"repo.read_file",
			"repo.search",
			"repo.write_file",
			"sandbox.exec",
		]);
	});

	test("audit decisions are emitted without approval bypass", async () => {
		const { backend } = fakeBackend();
		const decisions: ToolDecisionRecord[] = [];
		const registry = wireSandboxTools(backend, {
			onDecision: (record) => {
				decisions.push(record);
			},
		});
		await callTool(registry, "repo.read_file", { path: "src/a.ts" });
		await callTool(registry, "git.push_branch");
		await callTool(registry, "db.migrate");
		expect(decisions).toMatchObject([
			{
				tool: "repo.read_file",
				taskId: "task-1",
				organizationId: "org-1",
				outcome: "executed",
				reason: null,
			},
			{
				tool: "git.push_branch",
				taskId: "task-1",
				organizationId: "org-1",
				outcome: "denied",
				reason: "APPROVAL_REQUIRED",
			},
			{
				tool: "db.migrate",
				taskId: "task-1",
				organizationId: "org-1",
				outcome: "denied",
				reason: "POLICY_DENIED",
			},
		]);
		// Every call, executed or denied, carries a digest and a duration.
		expect(decisions).toHaveLength(3);
		for (const decision of decisions) {
			expect(decision.argumentsSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(decision.durationMs).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("repo.write_file", () => {
	test("writes inside ownership and returns bounded metadata", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		const output = await callTool(
			registry,
			"repo.write_file",
			{ path: "src/a.ts", content: "export const a = 1;\n" },
			ownedContext,
		);
		expect(output).toEqual({
			state: "executed",
			audited: true,
			value: {
				path: "src/a.ts",
				bytesWritten: 20,
				sha256: "sha:src/a.ts",
			},
		});
		expect(calls.writeFile).toEqual([
			{ path: "src/a.ts", content: "export const a = 1;\n" },
		]);
	});

	test("unowned writes are denied before the backend is called", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "docs/readme.md", content: "hi" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "POLICY_DENIED" });
		expect(calls.writeFile).toEqual([]);
	});

	test("empty or absent ownership means no write", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "hi" },
				{ ...taskContext, fileOwnership: [] },
			),
		).toEqual({ state: "failed", code: "POLICY_DENIED" });
		expect(
			await callTool(registry, "repo.write_file", {
				path: "src/a.ts",
				content: "hi",
			}),
		).toEqual({ state: "failed", code: "POLICY_DENIED" });
		expect(calls.writeFile).toEqual([]);
	});

	test("traversal and absolute paths fail before the backend", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		for (const path of [
			"../src/a.ts",
			"src/../../etc/passwd",
			"/etc/passwd",
			"C:\\Windows\\a.ts",
		]) {
			expect(
				await callTool(
					registry,
					"repo.write_file",
					{ path, content: "hi" },
					{ ...taskContext, fileOwnership: ["**"] },
				),
			).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		}
		expect(calls.writeFile).toEqual([]);
	});

	test("oversize UTF-8 content fails validation", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "x".repeat(262_145) },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.writeFile).toEqual([]);
	});

	test("multi-byte content is measured in UTF-8 bytes", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		// 100_000 three-byte characters = 300_000 bytes, under the char cap.
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "€".repeat(100_000) },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.writeFile).toEqual([]);
	});

	test("extra arguments fail strict validation", async () => {
		const { backend } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "hi", mode: "0777" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
	});

	test("a malformed ownership pattern in the task row fails closed", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "hi" },
				{ ...taskContext, fileOwnership: ["../**"] },
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.writeFile).toEqual([]);
	});
});

describe("git.commit_local", () => {
	test("commits when every changed file is owned", async () => {
		const { backend, calls } = fakeBackend({
			filesChanged: 2,
			insertions: 5,
			deletions: 1,
			files: ["src/a.ts", "src/nested/b.ts"],
		});
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "feat: add widget" },
				ownedContext,
			),
		).toEqual({
			state: "executed",
			audited: true,
			value: { commitSha: "0123456789abcdef" },
		});
		expect(calls.diffSummary).toBe(1);
		expect(calls.commitAll).toEqual(["feat: add widget"]);
	});

	test("rejects the commit when any changed file is unowned", async () => {
		const { backend, calls } = fakeBackend({
			filesChanged: 2,
			insertions: 3,
			deletions: 0,
			files: ["src/a.ts", "docs/readme.md"],
		});
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "feat: add widget" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "POLICY_DENIED" });
		expect(calls.diffSummary).toBe(1);
		expect(calls.commitAll).toEqual([]);
	});

	test("rejects when there is nothing to commit", async () => {
		const { backend, calls } = fakeBackend({
			filesChanged: 0,
			insertions: 0,
			deletions: 0,
			files: [],
		});
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "empty" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.commitAll).toEqual([]);
	});

	test("bounds the message and the changed-file count", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "m".repeat(201) },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });

		const many = fakeBackend({
			filesChanged: 201,
			insertions: 0,
			deletions: 0,
			files: ["src/a.ts"],
		});
		const manyRegistry = wireSandboxTools(many.backend);
		expect(
			await callTool(
				manyRegistry,
				"git.commit_local",
				{ message: "big" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.diffSummary).toBe(0);
		expect(many.calls.commitAll).toEqual([]);
	});

	test("rejects an incomplete diff summary instead of committing unverified paths", async () => {
		const { backend, calls } = fakeBackend({
			filesChanged: 2,
			insertions: 1,
			deletions: 0,
			files: ["src/a.ts"],
		});
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "msg" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.commitAll).toEqual([]);
	});

	test("uses pending paths so an untracked file can be committed", async () => {
		const { backend, calls } = fakeBackend();
		backend.pendingPaths = async () => ["LIVE_ACCEPTANCE.md"];
		const registry = wireSandboxTools(backend);
		const output = await callTool(
			registry,
			"git.commit_local",
			{ message: "chore: live" },
			{ ...taskContext, fileOwnership: ["LIVE_ACCEPTANCE.md"] },
		);
		expect(output).toEqual({
			state: "executed",
			audited: true,
			value: { commitSha: "0123456789abcdef" },
		});
		expect(calls.commitAll).toEqual(["chore: live"]);
	});

	test("unowned commit with empty ownership fails closed", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(registry, "git.commit_local", { message: "msg" }),
		).toEqual({ state: "failed", code: "POLICY_DENIED" });
		expect(calls.commitAll).toEqual([]);
	});
});

describe("git.diff_summary", () => {
	test("returns the bounded summary without arguments", async () => {
		const { backend, calls } = fakeBackend({
			filesChanged: 3,
			insertions: 10,
			deletions: 4,
			files: ["src/a.ts", "src/b.ts", "src/c.ts"],
		});
		const registry = wireSandboxTools(backend);
		expect(await callTool(registry, "git.diff_summary")).toEqual({
			state: "executed",
			audited: true,
			value: {
				filesChanged: 3,
				insertions: 10,
				deletions: 4,
				files: ["src/a.ts", "src/b.ts", "src/c.ts"],
			},
		});
		expect(calls.diffSummary).toBe(1);
	});

	test("rejects unexpected arguments", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(
			await callTool(registry, "git.diff_summary", { base: "main" }),
		).toEqual({ state: "failed", code: "VALIDATION_FAILED" });
		expect(calls.diffSummary).toBe(0);
	});
});

describe("read-only backends refuse write tools", () => {
	test("missing optional methods resolve to MISSING_CONFIG", async () => {
		const registry = wireSandboxTools(readOnlyBackend());
		expect(
			await callTool(
				registry,
				"repo.write_file",
				{ path: "src/a.ts", content: "hi" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "MISSING_CONFIG" });
		expect(
			await callTool(
				registry,
				"git.commit_local",
				{ message: "msg" },
				ownedContext,
			),
		).toEqual({ state: "failed", code: "MISSING_CONFIG" });
		expect(await callTool(registry, "git.diff_summary")).toEqual({
			state: "failed",
			code: "MISSING_CONFIG",
		});
	});

	test("read tools still work on a read-only backend", async () => {
		const registry = wireSandboxTools(readOnlyBackend());
		expect(
			await callTool(registry, "repo.list_files", { path: "src" }),
		).toEqual({
			state: "executed",
			audited: true,
			value: { path: "src", entries: [] },
		});
	});
});
