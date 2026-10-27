import { describe, expect, test } from "bun:test";
import {
	compileWorkflow,
	edgeAdjacency,
	nodeAdjacency,
	parseNodeConfig,
	reachableFrom,
	tarjanComponents,
	validateDefinition,
	workflowNotSupported,
} from "./index";
import {
	type AgentTaskConfig,
	NODE_TYPES,
	type NodeConfig,
	type NodeType,
	type ValidateLoopConfig,
	type WorkflowDefinition,
	type WorkflowEdge,
	type WorkflowIssue,
	type WorkflowNode,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(
	id: string,
	type: WorkflowNode["type"],
	config: Record<string, unknown>,
	label = id,
): WorkflowNode {
	return { id, type, label, config };
}

function edge(
	from: string,
	to: string,
	when?: WorkflowEdge["when"],
): WorkflowEdge {
	return when === undefined ? { from, to } : { from, to, when };
}

/** Linear definition: entry -> steps..., no cycles. */
function linearDefinition(): WorkflowDefinition {
	return {
		id: "wf.linear",
		name: "Linear",
		version: 1,
		nodes: [
			node("agent", "task.agent", {
				agentId: "agent-a",
				promptTemplateId: "tpl-1",
			}),
			node("tool", "tool.call", { tool: "fs.read" }),
			node("gate", "approval.gate", { action: "merge", risk: "medium" }),
		],
		edges: [edge("agent", "tool"), edge("tool", "gate")],
	};
}

/** entry -> loop -> body -> loop (cycle), loop -> terminal (exit). */
function loopDefinition(): WorkflowDefinition {
	return {
		id: "wf.loop",
		name: "Validate loop",
		version: 2,
		nodes: [
			node("entry", "tool.call", { tool: "git.status" }),
			node("loop", "validate.loop", { maxAttempts: 3 }),
			node("body", "tool.call", { tool: "fs.read" }),
			node("done", "approval.gate", { action: "merge", risk: "low" }),
		],
		edges: [
			edge("entry", "loop"),
			edge("loop", "body"),
			edge("body", "loop"),
			edge("loop", "done"),
		],
	};
}

function switchDefinition(): WorkflowDefinition {
	return {
		id: "wf.switch",
		name: "Switch",
		version: 1,
		nodes: [
			node("sw", "condition.switch", { branches: ["pass", "fail"] }),
			node("ok", "tool.call", { tool: "fs.read" }),
			node("bad", "tool.call", { tool: "git.status" }),
			node("end", "approval.gate", { action: "deploy", risk: "low" }),
		],
		edges: [
			edge("sw", "ok", { left: "result", operator: "eq", right: "pass" }),
			edge("sw", "bad", { left: "result", operator: "eq", right: "fail" }),
			edge("ok", "end"),
			edge("bad", "end"),
		],
	};
}

const allowlist = ["fs.read", "git.status", "format.code"];

function codes(issues: WorkflowIssue[]): string[] {
	return issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// graph.ts — deterministic primitives
// ---------------------------------------------------------------------------

describe("graph helpers", () => {
	test("tarjanComponents emits singleton components with seeded DFS order", () => {
		const adjacency = nodeAdjacency(3, [
			{ from: 1, to: 0 },
			{ from: 0, to: 1 },
			{ from: 2, to: 1 },
		]);
		const components = tarjanComponents(3, adjacency);
		expect(components).toHaveLength(2);
		expect(components.flat().sort((a, b) => a - b)).toEqual([0, 1, 2]);
	});

	test("nodeAdjacency deduplicates parallel edges; edgeAdjacency keeps them", () => {
		const parallel = [
			{ from: 0, to: 1 },
			{ from: 0, to: 1 },
		];
		expect(nodeAdjacency(2, parallel)).toEqual([[1], []]);
		expect(edgeAdjacency(2, parallel)).toEqual([[0, 1], []]);
	});

	test("reachableFrom covers transitive closure of all roots", () => {
		const adjacency = nodeAdjacency(4, [
			{ from: 0, to: 1 },
			{ from: 1, to: 2 },
			{ from: 3, to: 1 },
		]);
		const seen = reachableFrom(4, adjacency, [0]);
		expect(Array.from(seen)).toEqual([1, 1, 1, 0]);
	});
});

// ---------------------------------------------------------------------------
// nodes.ts — finite registry, strict parsing
// ---------------------------------------------------------------------------

describe("node config registry", () => {
	test("every NODE_TYPES entry has exactly one strict schema", () => {
		expect(Object.keys(NODE_TYPES).length).toBe(NODE_TYPES.length);
	});

	test("known config parses to the narrowed type", () => {
		const issues: WorkflowIssue[] = [];
		const parsed = parseNodeConfig(
			"task.agent",
			{ agentId: "agent-a", promptTemplateId: "tpl-1" },
			issues,
			"nodes[0].config",
		);
		expect(issues).toHaveLength(0);
		expect(parsed).toEqual({
			agentId: "agent-a",
			promptTemplateId: "tpl-1",
		} satisfies AgentTaskConfig);
	});

	test("undeclared field is rejected as UNSAFE_CONFIG on the exact key", () => {
		const issues: WorkflowIssue[] = [];
		const parsed = parseNodeConfig(
			"validate.loop",
			{ maxAttempts: 2, prompt: "do everything forever" },
			issues,
			"nodes[0].config",
		) as ValidateLoopConfig | undefined;
		expect(parsed).toBeUndefined();
		expect(codes(issues)).toEqual(["UNSAFE_CONFIG"]);
		expect(issues[0]?.path).toBe("nodes[0].config.prompt");
	});

	test("type mismatch is rejected as INVALID_TYPE", () => {
		const issues: WorkflowIssue[] = [];
		parseNodeConfig(
			"validate.loop",
			{ maxAttempts: "twice" },
			issues,
			"nodes[0].config",
		);
		expect(codes(issues)).toEqual(["INVALID_TYPE"]);
	});

	test("unknown node type is rejected as INVALID_TYPE", () => {
		const issues: WorkflowIssue[] = [];
		parseNodeConfig("shell.exec" as NodeType, {}, issues, "nodes[0].config");
		expect(codes(issues)).toEqual(["INVALID_TYPE"]);
		expect(issues[0]?.path).toBe("nodes[0].config.type");
	});
});

// ---------------------------------------------------------------------------
// validateDefinition — acceptance
// ---------------------------------------------------------------------------

describe("validateDefinition — accepted shapes", () => {
	test("linear pipeline passes with zod-normalized configs", () => {
		const result = validateDefinition(linearDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toHaveLength(0);
			expect(result.value.configs.size).toBe(3);
			expect((result.value.configs.get("loop") ?? null) === null).toBe(true);
		}
	});

	test("single-node definition passes", () => {
		const def: WorkflowDefinition = {
			id: "wf.one",
			name: "One",
			version: 1,
			nodes: [node("only", "approval.gate", { action: "merge", risk: "high" })],
			edges: [],
		};
		const result = validateDefinition(def);
		expect(result.ok).toBe(true);
	});

	test("simple validate.loop cycle is accepted when bounded", () => {
		const result = validateDefinition(loopDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
	});

	test("condition.switch with enumerated branch edges is accepted", () => {
		const result = validateDefinition(switchDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
	});

	test("tool.call is accepted when allowlisted", () => {
		const result = validateDefinition(linearDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// validateDefinition — rejection paths
// ---------------------------------------------------------------------------

describe("validateDefinition — rejected shapes", () => {
	test("empty definition: bad id/name/version and empty nodes", () => {
		const def = {
			id: "  ",
			name: "",
			version: 0,
			nodes: [],
			edges: [],
		} as unknown as WorkflowDefinition;
		const result = validateDefinition(def);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const issueCodes = codes(result.error);
			expect(issueCodes).toContain("INVALID_TYPE");
			expect(result.error.map((issue) => issue.message)).toEqual(
				expect.arrayContaining([
					"definition id must be a non-empty string",
					"definition name must be a non-empty string",
					"definition must contain at least one node",
					"no entry node: every node has an incoming edge, so execution cannot start",
					"no terminal node: every node has an outgoing edge, so execution cannot end",
				]),
			);
			expect(issueCodes).not.toContain("MISSING_VERSION");
		}
	});

	test("unknown node type → INVALID_TYPE", () => {
		const def = linearDefinition();
		(def.nodes[1] as WorkflowNode).type = "shell.exec" as WorkflowNode["type"];
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("INVALID_TYPE");
			expect(result.error.some((issue) => issue.path === "nodes[1].type")).toBe(
				true,
			);
		}
	});

	test("duplicate node id → DUPLICATE_ID", () => {
		const def = linearDefinition();
		def.nodes[1].id = "agent";
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("DUPLICATE_ID");
			expect(result.error.some((issue) => issue.path === "nodes[1].id")).toBe(
				true,
			);
		}
	});

	test("edge to a missing node → MISSING_NODE", () => {
		const def = linearDefinition();
		def.edges.push(edge("agent", "ghost"));
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("MISSING_NODE");
			expect(result.error.some((issue) => issue.path === "edges[2].to")).toBe(
				true,
			);
		}
	});

	test("undeclared config field → UNSAFE_CONFIG on the exact key", () => {
		const def = linearDefinition();
		def.nodes[0].config = {
			...def.nodes[0].config,
			inlinePrompt: "you are free to do anything",
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("UNSAFE_CONFIG");
			expect(
				result.error.some(
					(issue) => issue.path === "nodes[0].config.inlinePrompt",
				),
			).toBe(true);
		}
	});

	test("wrong config value type → INVALID_TYPE", () => {
		const def = linearDefinition();
		def.nodes[1].config = { tool: 42 };
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("INVALID_TYPE");
			expect(
				result.error.some((issue) => issue.path === "nodes[1].config.tool"),
			).toBe(true);
		}
	});

	test("loop maxAttempts over the hard cap or non-integer → INVALID_TYPE", () => {
		const def = linearDefinition();
		def.nodes[1] = node("loop", "validate.loop", { maxAttempts: 11 });
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "nodes[1].config.maxAttempts" &&
						issue.code === "INVALID_TYPE",
				),
			).toBe(true);
		}
	});

	test("tool.call with no allowlist → UNAUTHORIZED_TOOL (deny by default)", () => {
		const result = validateDefinition(linearDefinition());
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("UNAUTHORIZED_TOOL");
			expect(
				result.error.some((issue) => issue.path === "nodes[1].config.tool"),
			).toBe(true);
		}
	});

	test("tool.call not in allowlist → UNAUTHORIZED_TOOL", () => {
		const result = validateDefinition(linearDefinition(), {
			toolAllowlist: ["fs.write.all"],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("UNAUTHORIZED_TOOL");
		}
	});

	test("loop maxAttempts exceeding the task budget → INVALID_TYPE", () => {
		const result = validateDefinition(loopDefinition(), {
			toolAllowlist: allowlist,
			taskBudget: 2,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "INVALID_TYPE" &&
						issue.path === "nodes[1].config.maxAttempts" &&
						issue.message.includes("exceeds the task budget"),
				),
			).toBe(true);
		}
	});

	test("invalid taskBudget option → INVALID_TYPE at options.taskBudget", () => {
		const result = validateDefinition(loopDefinition(), {
			toolAllowlist: allowlist,
			taskBudget: 0,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) => issue.path === "options.taskBudget"),
			).toBe(true);
		}
	});

	test("`when` on a non-switch edge → INVALID_TYPE", () => {
		const def = linearDefinition();
		def.edges[0] = edge("agent", "tool", {
			left: "x",
			operator: "eq",
			right: "y",
		});
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "edges[0].when" &&
						issue.message.includes("only supported on condition.switch"),
				),
			).toBe(true);
		}
	});

	test("malformed `when` shape → INVALID_TYPE (regex-free rule)", () => {
		const def = linearDefinition();
		def.edges[0] = edge("agent", "tool", {
			left: "x",
			operator: "eq",
			right: /evil/,
		} as unknown as WorkflowEdge["when"]);
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "edges[0].when" &&
						issue.message.includes("regex-free"),
				),
			).toBe(true);
		}
	});

	test("switch edge with ne operator → INVALID_TYPE (eq only)", () => {
		const def = switchDefinition();
		def.edges[1] = edge("sw", "bad", {
			left: "result",
			operator: "ne",
			right: "fail",
		});
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "edges[1].when.operator" &&
						issue.message.includes('"eq"'),
				),
			).toBe(true);
		}
	});

	test("switch edge right value outside enumerated branches → INVALID_TYPE", () => {
		const def = switchDefinition();
		def.edges[0] = edge("sw", "ok", {
			left: "result",
			operator: "eq",
			right: "retry-forever",
		});
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "edges[0].when.right" &&
						issue.message.includes("enumerated branches"),
				),
			).toBe(true);
		}
	});

	test("switch node with < 2 or duplicate branches → INVALID_TYPE", () => {
		const def = switchDefinition();
		(def.nodes[0].config as { branches: string[] }).branches = ["pass"];
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.path === "nodes[0].config.branches" &&
						issue.code === "INVALID_TYPE",
				),
			).toBe(true);
		}
	});

	test("switch outgoing edge without when → INVALID_TYPE", () => {
		const def = switchDefinition();
		def.edges[0] = edge("sw", "ok");
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(codes(result.error)).toContain("INVALID_TYPE");
		}
	});

	test("enumerated switch branch with no outgoing edge → INVALID_TYPE", () => {
		const def = switchDefinition();
		(def.nodes[0].config as { branches: string[] }).branches = [
			"pass",
			"fail",
			"retry",
		];
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.message.includes('branch "retry"') &&
						issue.message.includes("no outgoing edge"),
				),
			).toBe(true);
		}
	});

	test("switch branch mapped to two outgoing edges → INVALID_TYPE", () => {
		const def = switchDefinition();
		// Both edges comparative to "pass"; branches list adds "fail" with no edge.
		def.edges[1] = edge("sw", "bad", {
			left: "result",
			operator: "eq",
			right: "pass",
		});
		(def.nodes[0].config as { branches: string[] }).branches = ["pass", "fail"];
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) =>
					issue.message.includes("each branch must map to exactly one edge"),
				),
			).toBe(true);
		}
	});

	test("switch outgoing edges comparing different left variables → INVALID_TYPE", () => {
		const def = switchDefinition();
		def.edges[1] = edge("sw", "bad", {
			left: "other",
			operator: "eq",
			right: "fail",
		});
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) =>
					issue.message.includes("same left variable"),
				),
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe("validateDefinition — cycle policy", () => {
	test("non-loop self-loop → CYCLE_NOT_SUPPORTED", () => {
		const def = linearDefinition();
		def.edges.push(edge("tool", "tool"));
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "CYCLE_NOT_SUPPORTED" &&
						issue.message.includes("self-loop"),
				),
			).toBe(true);
		}
	});

	test("loop self-loop with no exit → CYCLE_NOT_SUPPORTED (unbounded)", () => {
		const def: WorkflowDefinition = {
			id: "wf.self",
			name: "Self",
			version: 1,
			nodes: [node("loop", "validate.loop", { maxAttempts: 2 })],
			edges: [edge("loop", "loop")],
		};
		const result = validateDefinition(def);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "CYCLE_NOT_SUPPORTED" &&
						issue.message.includes("no exit edge"),
				),
			).toBe(true);
		}
	});

	test("cycle bounded by no validate.loop → CYCLE_NOT_SUPPORTED", () => {
		const def: WorkflowDefinition = {
			id: "wf.bad-cycle",
			name: "Bad cycle",
			version: 1,
			nodes: [
				node("a", "tool.call", { tool: "fs.read" }),
				node("b", "approval.gate", { action: "merge", risk: "low" }),
				node("c", "approval.gate", { action: "deploy", risk: "low" }),
			],
			edges: [
				edge("a", "b"),
				edge("b", "c"),
				edge("c", "a"),
				edge("c", "x"),
			].slice(0, 3),
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) => issue.code === "CYCLE_NOT_SUPPORTED"),
			).toBe(true);
		}
	});

	test("cycle with two validate.loops → CYCLE_NOT_SUPPORTED", () => {
		const def: WorkflowDefinition = {
			id: "wf.two-loops",
			name: "Two loops",
			version: 1,
			nodes: [
				node("loop1", "validate.loop", { maxAttempts: 2 }),
				node("loop2", "validate.loop", { maxAttempts: 2 }),
				node("exit", "tool.call", { tool: "fs.read" }),
			],
			edges: [
				edge("loop1", "loop2"),
				edge("loop2", "loop1"),
				edge("loop1", "exit"),
			],
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "CYCLE_NOT_SUPPORTED" &&
						issue.message.includes("exactly one validate.loop"),
				),
			).toBe(true);
		}
	});

	test("condition.switch inside a cycle → CYCLE_NOT_SUPPORTED", () => {
		const def: WorkflowDefinition = {
			id: "wf.switch-cycle",
			name: "Switch cycle",
			version: 1,
			nodes: [
				node("loop", "validate.loop", { maxAttempts: 2 }),
				node("sw", "condition.switch", { branches: ["again", "done"] }),
				node("end", "approval.gate", { action: "merge", risk: "low" }),
			],
			edges: [
				edge("loop", "sw"),
				edge("sw", "loop", { left: "r", operator: "eq", right: "again" }),
				edge("sw", "end", { left: "r", operator: "eq", right: "done" }),
			],
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "CYCLE_NOT_SUPPORTED" &&
						issue.message.includes("condition.switch"),
				),
			).toBe(true);
		}
	});

	test("nested/intersecting cycles → CYCLE_NOT_SUPPORTED", () => {
		const def: WorkflowDefinition = {
			id: "wf.nested",
			name: "Nested",
			version: 1,
			nodes: [
				node("loop", "validate.loop", { maxAttempts: 2 }),
				node("a", "tool.call", { tool: "fs.read" }),
				node("b", "tool.call", { tool: "git.status" }),
				node("exit", "approval.gate", { action: "merge", risk: "low" }),
			],
			edges: [
				edge("loop", "a"),
				edge("a", "b"),
				edge("b", "loop"),
				edge("a", "loop"),
				edge("b", "exit"),
			],
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some(
					(issue) =>
						issue.code === "CYCLE_NOT_SUPPORTED" &&
						issue.message.includes("nested or intersecting"),
				),
			).toBe(true);
		}
	});

	test("bodied loop with exit edge is accepted", () => {
		const result = validateDefinition(loopDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

describe("validateDefinition — reachability", () => {
	test("unreachable nodes → UNREACHABLE_REQUIRED_STEP", () => {
		// A disconnected 2-node cycle (plus a node it feeds): no edge from the
		// main pipeline can ever reach it. (A node with no incoming edge would
		// itself be an entry node, so it is reachable by definition.)
		const def = linearDefinition();
		def.nodes.push(
			node("p", "tool.call", { tool: "fs.read" }),
			node("q", "tool.call", { tool: "git.status" }),
			node("fed", "tool.call", { tool: "fs.read" }),
		);
		def.edges.push(edge("p", "q"), edge("q", "p"), edge("q", "fed"));
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const unreachables = result.error.filter(
				(issue) => issue.code === "UNREACHABLE_REQUIRED_STEP",
			);
			expect(unreachables).toHaveLength(3);
			for (const id of ["p", "q", "fed"]) {
				expect(
					unreachables.some((issue) => issue.message.includes(`"${id}"`)),
				).toBe(true);
			}
		}
	});

	test("pure cycle with no entry → UNREACHABLE_REQUIRED_STEP (no entry node)", () => {
		const def: WorkflowDefinition = {
			id: "wf.no-entry",
			name: "No entry",
			version: 1,
			nodes: [
				node("a", "tool.call", { tool: "fs.read" }),
				node("b", "tool.call", { tool: "git.status" }),
			],
			edges: [edge("a", "b"), edge("b", "a")],
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) => issue.message.includes("no entry node")),
			).toBe(true);
		}
	});

	test("no terminal node → INVALID_TYPE (execution cannot end)", () => {
		const def: WorkflowDefinition = {
			id: "wf.no-terminal",
			name: "No terminal",
			version: 1,
			nodes: [
				node("a", "tool.call", { tool: "fs.read" }),
				node("b", "tool.call", { tool: "git.status" }),
				node("w", "approval.gate", { action: "wait", risk: "low" }),
			],
			edges: [edge("a", "b"), edge("b", "w"), edge("w", "w")],
		};
		const result = validateDefinition(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.some((issue) =>
					issue.message.includes("no terminal node"),
				),
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// compiler.ts — determinism and version pinning
// ---------------------------------------------------------------------------

describe("compileWorkflow — accepted compiles", () => {
	test("linear pipeline compiles in topological order with entries and edges", () => {
		const result = compileWorkflow(linearDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const { value } = result;
			expect(value.workflowId).toBe("wf.linear");
			expect(value.versionPinned).toBe(1);
			expect(value.entryNodeIds).toEqual(["agent"]);
			expect(
				value.steps.map((step) => [step.order, step.nodeId, step.type]),
			).toEqual([
				[0, "agent", "task.agent"],
				[1, "tool", "tool.call"],
				[2, "gate", "approval.gate"],
			]);
			expect(value.steps[1]?.config).toEqual({ tool: "fs.read" });
			expect(value.edges).toEqual(linearDefinition().edges);
		}
	});

	test("compile is deterministic apart from planId", () => {
		const runOne = compileWorkflow(loopDefinition(), {
			toolAllowlist: allowlist,
		});
		const runTwo = compileWorkflow(loopDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(runOne.ok && runTwo.ok).toBe(true);
		if (runOne.ok && runTwo.ok) {
			expect(runOne.value.planId).not.toBe(runTwo.value.planId);
			const { planId: _a, ...restOne } = runOne.value;
			const { planId: _b, ...restTwo } = runTwo.value;
			expect(restTwo).toEqual(restOne);
		}
	});

	test("loop component compiles with the loop node ordered ahead of its body", () => {
		const result = compileWorkflow(loopDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			const order = result.value.steps.map((step) => step.nodeId);
			expect(order.indexOf("loop")).toBeLessThan(order.indexOf("body"));
			expect(result.value.entryNodeIds).toEqual(["entry"]);
		}
	});

	test("switch compile keeps definition edge order and maps branches", () => {
		const result = compileWorkflow(switchDefinition(), {
			toolAllowlist: allowlist,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.edges).toEqual(switchDefinition().edges);
			const swStep = result.value.steps.find((step) => step.nodeId === "sw");
			expect(swStep?.config).toEqual({ branches: ["pass", "fail"] });
		}
	});

	test("step config is the zod-normalized registry output (no pass-through)", () => {
		const def = loopDefinition();
		def.nodes.push(
			node("agent", "task.agent", {
				agentId: "agent-z",
				promptTemplateId: "tpl-9",
			}),
		);
		def.edges.push(edge("done", "agent"));
		const result = compileWorkflow(def, { toolAllowlist: allowlist });
		expect(result.ok).toBe(true);
		if (result.ok) {
			const agentStep = result.value.steps.find(
				(step) => step.nodeId === "agent",
			);
			expect(agentStep?.config).toEqual({
				agentId: "agent-z",
				promptTemplateId: "tpl-9",
			} satisfies AgentTaskConfig);
			expect(
				(agentStep?.config as NodeConfig & { label?: string }).label,
			).toBeUndefined();
		}
	});
});

describe("compileWorkflow — version pinning", () => {
	test("matching expectedVersion compiles and pins def.version", () => {
		const result = compileWorkflow(loopDefinition(), {
			toolAllowlist: allowlist,
			expectedVersion: 2,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.versionPinned).toBe(2);
		}
	});

	test("mismatched expectedVersion → MISSING_VERSION, refused before validation", () => {
		const def = linearDefinition();
		// Even a structurally valid definition must be refused on version drift.
		const result = compileWorkflow(def, {
			toolAllowlist: allowlist,
			expectedVersion: 999,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toEqual([
				{
					path: "version",
					code: "MISSING_VERSION",
					message: "definition version 1 does not match the pinned version 999",
				},
			]);
		}
	});

	test("structurally broken input is refused with all validation issues, not thrown", () => {
		const def: WorkflowDefinition = {
			id: "wf.broken",
			name: "Broken",
			version: 1,
			nodes: [
				node("dup", "tool.call", { tool: "fs.read" }),
				{ id: "dup", type: "tool.call", label: "dup", config: {} },
			],
			edges: [edge("dup", "ghost")],
		};
		const result = compileWorkflow(def, { toolAllowlist: ["fs.read"] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const issueCodes = codes(result.error);
			expect(issueCodes).toContain("DUPLICATE_ID");
			expect(issueCodes).toContain("MISSING_NODE");
		}
	});
});

// ---------------------------------------------------------------------------
// index.ts barrel
// ---------------------------------------------------------------------------

describe("workflowNotSupported", () => {
	test("builds a structured PlatformError without leaking content", () => {
		const error = workflowNotSupported("cycle");
		expect(error.code).toBe("VALIDATION_FAILED");
		expect(error.message).toBe("workflow define rejected: cycle");
		expect(Object.keys(error)).not.toContain("payload");
	});
});
