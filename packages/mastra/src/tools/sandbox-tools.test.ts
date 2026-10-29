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

type BackendCalls = {
	readFile: string[];
	listFiles: string[];
	search: string[];
	exec: (readonly string[])[];
	git: (readonly string[])[];
};

function execResult(stdout = "ok"): SandboxExecResult {
	return {
		exitCode: 0,
		stdout,
		stderr: "",
		durationMs: 5,
		truncated: false,
	};
}

function fakeBackend(): { backend: SandboxToolBackend; calls: BackendCalls } {
	const calls: BackendCalls = {
		readFile: [],
		listFiles: [],
		search: [],
		exec: [],
		git: [],
	};
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
	};
	return { backend, calls };
}

async function callTool(
	registry: ReturnType<typeof wireSandboxTools>,
	name: keyof WiredToolCollection,
	args: Record<string, unknown> = {},
): Promise<WiredToolOutput> {
	const collection = registry.forTask(taskContext);
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

	test("write and approval-band tools stay denied and never reach the backend", async () => {
		const { backend, calls } = fakeBackend();
		const registry = wireSandboxTools(backend);
		expect(await callTool(registry, "git.push_branch")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(await callTool(registry, "github.merge_pull_request")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(await callTool(registry, "db.migrate")).toEqual({
			state: "denied",
			reason: "POLICY_DENIED",
		});
		expect(calls).toEqual({
			readFile: [],
			listFiles: [],
			search: [],
			exec: [],
			git: [],
		});
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

	test("risk table allowlists exactly the five read-only tools", () => {
		expect(SANDBOX_TOOL_RISKS).toEqual({
			"repo.read_file": "read_only",
			"repo.list_files": "read_only",
			"repo.search": "read_only",
			"sandbox.exec": "read_only",
			"git.read": "read_only",
		});
		const implementations = createSandboxToolImplementations(
			fakeBackend().backend,
		);
		expect(Object.keys(implementations).sort()).toEqual([
			"git.read",
			"repo.list_files",
			"repo.read_file",
			"repo.search",
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
		expect(decisions).toEqual([
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
				reason: "POLICY_DENIED",
			},
		]);
	});
});
