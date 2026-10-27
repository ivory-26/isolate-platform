import { describe, expect, test } from "bun:test";
import type { Result } from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import { denyByDefault, type PolicyDecision, type ToolPolicy } from "./policy";
import {
	type ToolCallContext,
	type ToolDecisionRecord,
	type WiredToolOutput,
	wirePlatformTools,
} from "./registry";

const taskContext: ToolCallContext = {
	organizationId: "org-1",
	taskId: "task-1",
	scopes: ["repo:read"],
};

/** Real Mastra tool execution context (all fields optional in practice). */
const execContext = {} as never;

/** Invokes one wired tool and normalises the (possibly undefined) execute. */
async function callTool(
	collection: ReturnType<ReturnType<typeof wirePlatformTools>["forTask"]>,
	name: keyof typeof collection,
	args: Record<string, unknown> = {},
): Promise<WiredToolOutput> {
	const tool = collection[name];
	const execute = tool.execute;
	if (!execute) {
		throw new Error(`tool ${name} has no execute`);
	}
	return (await execute(args, execContext)) as WiredToolOutput;
}

function allowEverything(): ToolPolicy {
	return async () =>
		({
			ok: true,
			value: { allowed: true, risk: "read_only", audited: true },
		}) as Result<PolicyDecision>;
}

describe("platform tool registry (policy gate wired over createTool)", () => {
	test("allowed read_only tool executes its implementation and is audited", async () => {
		const decisions: ToolDecisionRecord[] = [];
		const registry = wirePlatformTools({
			policy: denyByDefault({ "repo.read_file": "read_only" }),
			implementations: {
				"repo.read_file": async (args) => ({
					content: JSON.stringify(args),
				}),
			},
			onDecision: (record) => {
				decisions.push(record);
				return Promise.resolve();
			},
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"repo.read_file",
			{ path: "src/a.ts" },
		);
		expect(output).toEqual({
			state: "executed",
			audited: true,
			value: { content: '{"path":"src/a.ts"}' },
		});
		expect(decisions).toEqual([
			{
				tool: "repo.read_file",
				taskId: "task-1",
				organizationId: "org-1",
				outcome: "executed",
				reason: null,
			},
		]);
	});

	test("deny-by-default denies allowlisted tools that missed the risk table", async () => {
		let implementationCalls = 0;
		const registry = wirePlatformTools({
			policy: denyByDefault({}),
			implementations: {
				"repo.read_file": async () => {
					implementationCalls += 1;
					return {};
				},
			},
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"repo.read_file",
			{
				path: "x",
			},
		);
		expect(output).toEqual({ state: "denied", reason: "POLICY_DENIED" });
		expect(implementationCalls).toBe(0);
	});

	test("sensitive actions route to approval and never silently execute", async () => {
		let implementationCalls = 0;
		const registry = wirePlatformTools({
			policy: denyByDefault({ "github.create_pull_request": "sensitive" }),
			implementations: {
				"github.create_pull_request": async () => {
					implementationCalls += 1;
					return {};
				},
			},
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"github.create_pull_request",
		);
		expect(output).toEqual({ state: "denied", reason: "APPROVAL_REQUIRED" });
		expect(implementationCalls).toBe(0);
	});

	test("explicit policy denies propagate the denial reason", async () => {
		const denied: ToolPolicy = async () => ({
			ok: false,
			error: new PlatformError("POLICY_DENIED", "scoped off"),
		});
		const registry = wirePlatformTools({
			policy: denied,
			implementations: { "repo.search": async () => ({}) },
		});
		const outDenied = await callTool(
			registry.forTask(taskContext),
			"repo.search",
		);
		expect(outDenied).toEqual({ state: "denied", reason: "POLICY_DENIED" });

		const scopeMissing: ToolPolicy = async () => ({
			ok: true,
			value: { allowed: false, reason: "SCOPE_MISSING" },
		});
		const registry2 = wirePlatformTools({
			policy: scopeMissing,
			implementations: { "repo.search": async () => ({}) },
		});
		const outScope = await callTool(
			registry2.forTask(taskContext),
			"repo.search",
		);
		expect(outScope).toEqual({ state: "denied", reason: "SCOPE_MISSING" });
	});

	test("a policy resolver crash stays deny-by-default", async () => {
		const broken: ToolPolicy = async () => {
			throw new Error("policy store down");
		};
		const registry = wirePlatformTools({
			policy: broken,
			implementations: { "repo.list_files": async () => ({}) },
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"repo.list_files",
		);
		expect(output).toEqual({ state: "denied", reason: "POLICY_DENIED" });
	});

	test("allow-but-unimplemented names stay denied (deny-by-default for missing impl)", async () => {
		const registry = wirePlatformTools({
			policy: allowEverything(),
			implementations: {},
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"repo.list_files",
		);
		expect(output).toEqual({ state: "denied", reason: "POLICY_DENIED" });
	});

	test("implementation failures collapse to a bounded error code", async () => {
		const registry = wirePlatformTools({
			policy: allowEverything(),
			implementations: {
				"sandbox.exec": async () => {
					throw new Error("raw secret leak attempt");
				},
			},
		});
		const output = await callTool(
			registry.forTask(taskContext),
			"sandbox.exec",
		);
		expect(output).toEqual({ state: "failed", code: "INTERNAL" });
	});
});
