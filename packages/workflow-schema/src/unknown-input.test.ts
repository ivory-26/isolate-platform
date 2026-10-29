import { describe, expect, test } from "bun:test";
import {
	compileWorkflow,
	NODE_TYPES,
	validateDefinition,
	type WorkflowIssueCode,
} from "./index";

const hostile = "<script>PRIVATE_SOURCE_TOKEN</script>";
const gate = {
	id: "review",
	type: "approval.gate",
	label: "Review",
	config: { action: "merge", risk: "high" },
};
function graph(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "wf.authored",
		name: "Authored",
		version: 1,
		nodes: [gate],
		edges: [],
		...fields,
	};
}
function withNode(fields: Record<string, unknown>): Record<string, unknown> {
	return graph({ nodes: [{ ...gate, ...fields }] });
}
function withEdge(fields: Record<string, unknown>): Record<string, unknown> {
	return graph({ edges: [{ from: "review", to: "review", ...fields }] });
}
type ShapeCase = [string, unknown, string, WorkflowIssueCode];
const cases: ShapeCase[] = [];
for (const value of [null, false, 12, hostile, []]) {
	cases.push([`root ${JSON.stringify(value)}`, value, "$", "INVALID_TYPE"]);
	for (const field of ["nodes", "edges"]) {
		if (!Array.isArray(value))
			cases.push([
				`${field} container ${JSON.stringify(value)}`,
				graph({ [field]: value }),
				field,
				"INVALID_TYPE",
			]);
		cases.push([
			`${field} member ${JSON.stringify(value)}`,
			graph({ [field]: [value] }),
			`${field}[0]`,
			"INVALID_TYPE",
		]);
	}
}
for (const field of ["nodes", "edges"])
	cases.push([
		`${field} object`,
		graph({ [field]: {} }),
		field,
		"INVALID_TYPE",
	]);
cases.push(
	["missing fields", {}, "nodes", "INVALID_TYPE"],
	[
		"missing node fields",
		graph({ nodes: [{}] }),
		"nodes[0].id",
		"INVALID_TYPE",
	],
	[
		"missing edge fields",
		graph({ edges: [{}] }),
		"edges[0].from",
		"INVALID_TYPE",
	],
	["null definition id", graph({ id: null }), "id", "INVALID_TYPE"],
	["object definition name", graph({ name: {} }), "name", "INVALID_TYPE"],
	["string version", graph({ version: hostile }), "version", "INVALID_TYPE"],
	["null node id", withNode({ id: null }), "nodes[0].id", "INVALID_TYPE"],
	[
		"object node id",
		withNode({ id: { toString: hostile } }),
		"nodes[0].id",
		"INVALID_TYPE",
	],
	["empty node id", withNode({ id: "" }), "nodes[0].id", "INVALID_TYPE"],
	[
		"dotted node id",
		withNode({ id: "review.ready" }),
		"nodes[0].id",
		"INVALID_NODE_ID",
	],
	[
		"unknown node type",
		withNode({ type: hostile }),
		"nodes[0].type",
		"INVALID_TYPE",
	],
	[
		"prototype node type",
		withNode({ type: "__proto__" }),
		"nodes[0].type",
		"INVALID_TYPE",
	],
	["null node type", withNode({ type: null }), "nodes[0].type", "INVALID_TYPE"],
	[
		"object node type",
		withNode({ type: { toString: hostile } }),
		"nodes[0].type",
		"INVALID_TYPE",
	],
	["null label", withNode({ label: null }), "nodes[0].label", "INVALID_TYPE"],
	["empty label", withNode({ label: " " }), "nodes[0].label", "INVALID_TYPE"],
	["null edge from", withEdge({ from: null }), "edges[0].from", "INVALID_TYPE"],
	["object edge to", withEdge({ to: {} }), "edges[0].to", "INVALID_TYPE"],
	["empty edge from", withEdge({ from: "" }), "edges[0].from", "INVALID_TYPE"],
);
for (const when of [
	null,
	[],
	hostile,
	{},
	{ left: {}, operator: "eq", right: "ok" },
	{ left: "result", operator: hostile, right: "ok" },
	{ left: "result", operator: "eq", right: {} },
]) {
	cases.push([
		`condition ${JSON.stringify(when)}`,
		withEdge({ when }),
		"edges[0].when",
		"INVALID_TYPE",
	]);
}
for (const [name, input, path] of [
	["outer", graph({ [hostile]: hostile }), "$"],
	["node", withNode({ [hostile]: hostile }), "nodes[0]"],
	["edge", withEdge({ [hostile]: hostile }), "edges[0]"],
	[
		"condition",
		withEdge({
			when: { left: "result", operator: "eq", right: "ok", [hostile]: hostile },
		}),
		"edges[0].when",
	],
	[
		"config",
		withNode({ config: { ...gate.config, [hostile]: hostile } }),
		"nodes[0].config",
	],
] satisfies [string, unknown, string][])
	cases.push([`unknown ${name} field`, input, path, "UNSAFE_CONFIG"]);

describe("unknown authored JSON boundary", () => {
	test.each(cases)("rejects %s safely", (_name, input, path, code) => {
		const before = structuredClone(input);
		for (const result of [validateDefinition(input), compileWorkflow(input)]) {
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(
					result.error.some(
						(issue) => issue.code === code && issue.path.startsWith(path),
					),
				).toBe(true);
				expect(
					result.error.every((issue) => typeof issue.message === "string"),
				).toBe(true);
				expect(JSON.stringify(result.error)).not.toContain(hostile);
			}
		}
		expect(input).toEqual(before);
	});
});

describe("unknown input contract and source-safe policy errors", () => {
	test("outer arrays fail before child traversal or version pin", () => {
		const input: unknown = graph({ nodes: [null], edges: {} });
		for (const result of [
			validateDefinition(input),
			compileWorkflow(input, { expectedVersion: 2 }),
		]) {
			expect(result).toEqual({
				ok: false,
				error: [
					{
						path: "edges",
						code: "INVALID_TYPE",
						message: "definition edges must be an array",
					},
				],
			});
		}
	});
	test("unknown JSON compiles without casts and is deterministic except planId", () => {
		const input: unknown = JSON.parse(JSON.stringify(graph()));
		const before = structuredClone(input);
		expect(validateDefinition(input).ok).toBe(true);
		const first = compileWorkflow(input, { expectedVersion: 1 });
		const second = compileWorkflow(input, { expectedVersion: 1 });
		expect(first.ok && second.ok).toBe(true);
		if (first.ok && second.ok) {
			const { planId: firstId, ...firstPlan } = first.value;
			const { planId: secondId, ...secondPlan } = second.value;
			expect(firstId).not.toBe(secondId);
			expect(firstPlan).toEqual(secondPlan);
			expect(firstPlan.workflowId).toBe("wf.authored");
			expect(firstPlan.versionPinned).toBe(1);
		}
		expect(input).toEqual(before);
	});
	test.each(NODE_TYPES)("malformed config of %s returns issues", (type) => {
		for (const config of [null, false, 1, hostile, [], {}]) {
			const input: unknown = withNode({ type, config });
			for (const result of [
				validateDefinition(input),
				compileWorkflow(input),
			]) {
				expect(result.ok).toBe(false);
				if (!result.ok)
					expect(JSON.stringify(result.error)).not.toContain(hostile);
			}
		}
	});
	test.each([
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("non-JSON primitive %j is also safe", (input) => {
		expect(validateDefinition(input).ok).toBe(false);
		expect(compileWorkflow(input, { expectedVersion: 1 }).ok).toBe(false);
	});
	test("hostile ids do not leak via missing endpoints, duplicates, labels, or cycles", () => {
		const input: unknown = graph({
			nodes: [
				{ ...gate, id: hostile, label: "" },
				{ ...gate, id: hostile },
			],
			edges: [
				{ from: hostile, to: hostile },
				{ from: hostile, to: `${hostile}missing` },
			],
		});
		for (const result of [validateDefinition(input), compileWorkflow(input)]) {
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(JSON.stringify(result.error)).not.toContain(hostile);
		}
	});
	test("tool and budget errors enforce policy without reflecting authored values", () => {
		const input: unknown = graph({
			nodes: [
				{
					id: hostile,
					type: "tool.call",
					label: "Tool",
					config: { tool: hostile },
				},
				{
					id: "loop",
					type: "validate.loop",
					label: "Loop",
					config: { maxAttempts: 3 },
				},
			],
		});
		for (const options of [
			{ taskBudget: 2 },
			{ taskBudget: 2, toolAllowlist: [] },
		]) {
			for (const result of [
				validateDefinition(input, options),
				compileWorkflow(input, options),
			]) {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.map((issue) => issue.code)).toContain(
						"UNAUTHORIZED_TOOL",
					);
					expect(result.error.map((issue) => issue.path)).toContain(
						"nodes[1].config.maxAttempts",
					);
					expect(JSON.stringify(result.error)).not.toContain(hostile);
				}
			}
		}
	});
	test("switch errors do not echo enumerated branch values", () => {
		const input: unknown = graph({
			nodes: [
				{
					id: "switch",
					type: "condition.switch",
					label: "Switch",
					config: { branches: [hostile, "ok"] },
				},
				gate,
			],
			edges: [
				{
					from: "switch",
					to: "review",
					when: { left: "result", operator: "eq", right: "ok" },
				},
			],
		});
		const result = compileWorkflow(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(hostile);
	});
	test("prototype config fields are rejected instead of silently stripped", () => {
		const input: unknown = withNode({
			config: JSON.parse(
				'{"action":"merge","risk":"high","__proto__":{"polluted":true}}',
			),
		});
		for (const result of [validateDefinition(input), compileWorkflow(input)]) {
			expect(result).toMatchObject({
				ok: false,
				error: [{ path: "nodes[0].config", code: "UNSAFE_CONFIG" }],
			});
		}
	});
});

describe("strict boundary and version precedence", () => {
	test.each([
		"outer",
		"node",
		"edge",
		"condition",
	])("prototype-named extras in %s remain unknown fields", (scope) => {
		const extra: Record<string, unknown> = JSON.parse(
			'{"__proto__":{"polluted":true}}',
		);
		const input: unknown =
			scope === "outer"
				? graph(extra)
				: scope === "node"
					? withNode(extra)
					: scope === "edge"
						? withEdge(extra)
						: withEdge({
								when: { left: "result", operator: "eq", right: "ok", ...extra },
							});
		for (const result of [validateDefinition(input), compileWorkflow(input)]) {
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.error.map((issue) => issue.code)).toContain(
					"UNSAFE_CONFIG",
				);
		}
	});
	test("pin mismatch still wins over registry/policy validation for a shape-valid graph", () => {
		const input: unknown = withNode({ config: {} });
		const result = compileWorkflow(input, { expectedVersion: 2 });
		expect(result).toMatchObject({
			ok: false,
			error: [{ path: "version", code: "MISSING_VERSION" }],
		});
	});
	test("untrusted version text is rejected before pin diagnostics", () => {
		const input: unknown = graph({ version: hostile });
		const result = compileWorkflow(input, { expectedVersion: 2 });
		expect(result).toMatchObject({
			ok: false,
			error: [{ path: "version", code: "INVALID_TYPE" }],
		});
		if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(hostile);
	});
	test.each([
		{ type: "condition.switch", config: { branches: [null, hostile] } },
		{ type: "condition.switch", config: { branches: [hostile, hostile] } },
		{ type: "validate.loop", config: { maxAttempts: hostile } },
		{ type: "task.agent", config: { agentId: {}, promptTemplateId: hostile } },
		{ type: "tool.call", config: { tool: [] } },
	])("nested invalid registry config %j stays source-safe", (fields) => {
		const input: unknown = withNode(fields);
		for (const result of [validateDefinition(input), compileWorkflow(input)]) {
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(JSON.stringify(result.error)).not.toContain(hostile);
		}
	});
});
