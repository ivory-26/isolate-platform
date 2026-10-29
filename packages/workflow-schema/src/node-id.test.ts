import { describe, expect, test } from "bun:test";
import {
	compileWorkflow,
	NODE_TYPES,
	validateDefinition,
	type WorkflowDefinition,
} from "./index";

const options = { toolAllowlist: ["fs.read"] };
const dottedIdIssue = {
	code: "INVALID_NODE_ID",
	message:
		'node id must not contain "." because Mastra treats it as a resume path separator',
} as const;

/** All registered node types, a switch, and a bounded loop with an exit. */
function definition(): WorkflowDefinition {
	return {
		id: "wf.node-ids",
		name: "Node ids",
		version: 1,
		nodes: [
			{
				id: "plan",
				type: "task.agent",
				label: "Plan",
				config: { agentId: "agent.v1", promptTemplateId: "template.plan" },
			},
			{
				id: "read",
				type: "tool.call",
				label: "Read",
				config: { tool: "fs.read" },
			},
			{
				id: "review",
				type: "approval.gate",
				label: "Review",
				config: { action: "pull.request", risk: "high" },
			},
			{
				id: "route",
				type: "condition.switch",
				label: "Route",
				config: { branches: ["result.retry", "result.done"] },
			},
			{
				id: "repair",
				type: "validate.loop",
				label: "Repair",
				config: { maxAttempts: 2 },
			},
			{
				id: "done",
				type: "approval.gate",
				label: "Done",
				config: { action: "merge", risk: "low" },
			},
		],
		edges: [
			{ from: "plan", to: "read" },
			{ from: "read", to: "review" },
			{ from: "review", to: "route" },
			{
				from: "route",
				to: "repair",
				when: {
					left: "validation.result",
					operator: "eq",
					right: "result.retry",
				},
			},
			{
				from: "route",
				to: "done",
				when: {
					left: "validation.result",
					operator: "eq",
					right: "result.done",
				},
			},
			{ from: "repair", to: "repair" },
			{ from: "repair", to: "done" },
		],
	};
}

function renameNode(def: WorkflowDefinition, index: number, id: string): void {
	const previous = def.nodes[index].id;
	def.nodes[index].id = id;
	for (const edge of def.edges) {
		if (edge.from === previous) edge.from = id;
		if (edge.to === previous) edge.to = id;
	}
}

describe("INVALID_NODE_ID — dotted Mastra step ids", () => {
	test.each([
		".",
		"..",
		".review",
		"review.",
		"review.ready",
		"review..ready",
	])("rejects %s with a dedicated issue at the node id path", (id) => {
		const def = definition();
		renameNode(def, 2, id);
		const before = structuredClone(def);
		for (const result of [
			validateDefinition(def, options),
			compileWorkflow(def, options),
		]) {
			expect(result).toEqual({
				ok: false,
				error: [{ path: "nodes[2].id", ...dottedIdIssue }],
			});
		}
		expect(def).toEqual(before);
	});

	test.each(NODE_TYPES)("rejects dotted ids for %s nodes", (type) => {
		const def = definition();
		const index = def.nodes.findIndex((node) => node.type === type);
		renameNode(def, index, "stage.dotted");
		for (const result of [
			validateDefinition(def, options),
			compileWorkflow(def, options),
		]) {
			expect(result).toEqual({
				ok: false,
				error: [{ path: `nodes[${index}].id`, ...dottedIdIssue }],
			});
		}
	});

	test("collects dotted-id issues alongside duplicate and missing-node issues", () => {
		const def = definition();
		renameNode(def, 0, "plan.start");
		renameNode(def, 2, "review.ready");
		def.nodes.push({ ...def.nodes[2] });
		def.edges.push({ from: "plan.start", to: "missing" });
		const result = validateDefinition(def, options);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.error.filter((issue) => issue.code === "INVALID_NODE_ID"),
			).toEqual([
				{ path: "nodes[0].id", ...dottedIdIssue },
				{ path: "nodes[2].id", ...dottedIdIssue },
				{ path: "nodes[6].id", ...dottedIdIssue },
			]);
			expect(result.error.map((issue) => issue.code)).toContain("DUPLICATE_ID");
			expect(result.error.map((issue) => issue.code)).toContain("MISSING_NODE");
		}
	});

	test("a dotted dangling edge reference remains MISSING_NODE", () => {
		const def = definition();
		def.edges.push({ from: "missing.source", to: "missing.target" });
		expect(validateDefinition(def, options)).toMatchObject({
			ok: false,
			error: [
				{ path: "edges[7].from", code: "MISSING_NODE" },
				{ path: "edges[7].to", code: "MISSING_NODE" },
			],
		});
	});
});

describe("node ids — supported subset is unchanged apart from dots", () => {
	test.each([
		"step-1",
		"step_1",
		"123",
		"Stage 1",
		"étape",
		"phase:review",
		"path/review",
		"__proto__",
	])("preserves dot-free id %s and verbatim edge routing", (id) => {
		const def = definition();
		renameNode(def, 0, id);
		const before = structuredClone(def);
		const validated = validateDefinition(def, options);
		expect(validated.ok).toBe(true);
		if (validated.ok) expect(validated.value.configs.has(id)).toBe(true);
		const compiled = compileWorkflow(def, options);
		expect(compiled.ok).toBe(true);
		if (compiled.ok) {
			expect(compiled.value.workflowId).toBe("wf.node-ids");
			expect(compiled.value.entryNodeIds).toEqual([id]);
			expect(compiled.value.steps[0].nodeId).toBe(id);
			expect(compiled.value.edges).toEqual(def.edges);
		}
		expect(def).toEqual(before);
	});

	test.each([
		"",
		null,
		42,
	])("invalid id %j remains INVALID_TYPE, not INVALID_NODE_ID", (id) => {
		const def = definition();
		def.nodes = [{ ...def.nodes[2], id: id as unknown as string }];
		def.edges = [];
		expect(validateDefinition(def, options)).toEqual({
			ok: false,
			error: [
				{
					path: "nodes[0].id",
					code: "INVALID_TYPE",
					message: "node id must be a non-empty string",
				},
			],
		});
	});
});
