import { err, ok, type Result } from "@isolate/shared";
import { nodeAdjacency, reachableFrom, tarjanComponents } from "./graph";
import { parseNodeConfig } from "./nodes";
import {
	EDGE_OPERATORS,
	NODE_TYPES,
	type NodeConfig,
	type ValidationOptions,
	type ValidatedDefinition,
	type WorkflowDefinition,
	type WorkflowEdge,
	type WorkflowIssue,
	type WorkflowNode,
} from "./types";

/**
 * Full registry-backed structural + per-type validation (architecture §6):
 * - duplicate ids, missing edge endpoints, unknown node types;
 * - per-type strict config validation (undeclared fields → UNSAFE_CONFIG);
 * - tool.call denied unless the tool is in a supplied allowlist;
 * - condition.switch edges restricted to the enumerated branch values;
 * - validate.loop maxAttempts bounded and checked against the task budget;
 * - cycles: only simple cycles bounded by exactly one validate.loop with an
 *   exit edge are supported; anything else (switch back edges, nested or
 *   intersecting cycles) is rejected;
 * - every node reachable from an entry node, and at least one terminal node.
 *
 * Issues are collected (not thrown); the caller decides what to do.
 * @internal Shared by validateDefinition and compileWorkflow.
 */
export function validateDefinitionParts(
	def: WorkflowDefinition,
	options: ValidationOptions = {},
): ValidatedDefinition {
	const issues: WorkflowIssue[] = [];
	const configs = new Map<string, NodeConfig>();

	if (typeof def.id !== "string" || def.id.trim().length === 0) {
		issues.push({
			path: "id",
			code: "INVALID_TYPE",
			message: "definition id must be a non-empty string",
		});
	}
	if (typeof def.name !== "string" || def.name.trim().length === 0) {
		issues.push({
			path: "name",
			code: "INVALID_TYPE",
			message: "definition name must be a non-empty string",
		});
	}
	if (!Number.isInteger(def.version) || def.version < 1) {
		issues.push({
			path: "version",
			code: "INVALID_TYPE",
			message: "definition version must be a positive integer",
		});
	}
	if (!Array.isArray(def.nodes)) {
		issues.push({
			path: "nodes",
			code: "INVALID_TYPE",
			message: "definition nodes must be an array",
		});
	}
	if (!Array.isArray(def.edges)) {
		issues.push({
			path: "edges",
			code: "INVALID_TYPE",
			message: "definition edges must be an array",
		});
	}

	const nodesReadonly: WorkflowNode[] = def.nodes ?? [];
	const edgesReadonly: WorkflowEdge[] = def.edges ?? [];
	if (nodesReadonly.length === 0) {
		issues.push({
			path: "nodes",
			code: "INVALID_TYPE",
			message: "definition must contain at least one node",
		});
	}

	// --- Nodes: registry, duplicates, per-type config ------------------------
	const indexById = new Map<string, number>();
	for (let i = 0; i < nodesReadonly.length; i++) {
		const node = nodesReadonly[i];
		const id = node.id;
		if (typeof id !== "string" || id.length === 0) {
			issues.push({
				path: `nodes[${i}].id`,
				code: "INVALID_TYPE",
				message: "node id must be a non-empty string",
			});
		} else {
			const first = indexById.get(id);
			if (first !== undefined) {
				issues.push({
					path: `nodes[${i}].id`,
					code: "DUPLICATE_ID",
					message: `duplicate node id ${id} (first declared at nodes[${first}])`,
				});
			} else {
				indexById.set(id, i);
			}
		}
		if (typeof node.label !== "string" || node.label.trim().length === 0) {
			issues.push({
				path: `nodes[${i}].label`,
				code: "INVALID_TYPE",
				message: `node ${id} label must be a non-empty string`,
			});
		}
		if (!(NODE_TYPES as readonly string[]).includes(node.type)) {
			issues.push({
				path: `nodes[${i}].type`,
				code: "INVALID_TYPE",
				message: `unknown node type: ${String(node.type)}`,
			});
			continue;
		}
		const parsed = parseNodeConfig(
			node.type,
			node.config,
			issues,
			`nodes[${i}].config`,
		);
		if (parsed === undefined) {
			// Config problems are already reported; structural checks below skip
			// cross-checks that depend on a valid config.
		} else {
			configs.set(id, parsed);
		}
	}

	// --- Edges: endpoints, `when` shape, switch branch coverage --------------
	type IndexedEdge = { from: number; to: number; edge: WorkflowEdge; index: number };
	const indexedEdges: IndexedEdge[] = [];
	for (let i = 0; i < edgesReadonly.length; i++) {
		const edge = edgesReadonly[i];
		const from = indexById.get(edge.from);
		const to = indexById.get(edge.to);
		if (from === undefined) {
			issues.push({
				path: `edges[${i}].from`,
				code: "MISSING_NODE",
				message: `edge references missing node ${edge.from}`,
			});
		}
		if (to === undefined) {
			issues.push({
				path: `edges[${i}].to`,
				code: "MISSING_NODE",
				message: `edge references missing node ${edge.to}`,
			});
		}
		if (from !== undefined && to !== undefined) {
			indexedEdges.push({ from, to, edge, index: i });
		}
		if (edge.when !== undefined) {
			validateWhenShape(edge, i, issues);
		}
	}

	const outgoing: IndexedEdge[][] = Array.from(
		{ length: nodesReadonly.length },
		() => [],
	);
	for (const ie of indexedEdges) outgoing[ie.from].push(ie);

	for (const ie of indexedEdges) {
		const source = nodesReadonly[ie.from];
		if (source.type !== "condition.switch") {
			if (ie.edge.when !== undefined) {
				issues.push({
					path: `edges[${ie.index}].when`,
					code: "INVALID_TYPE",
					message: `"when" is only supported on condition.switch outgoing edges (edge from ${source.id} is a ${source.type})`,
				});
			}
			continue;
		}
		const branches = configs.get(source.id);
		if (branches === undefined || !("branches" in branches)) continue;
		validateSwitchEdges(ie, ie.index, branches.branches, outgoing[ie.from], issues);
	}

	// --- Cycles: only simple, validate.loop-bounded cycles -------------------
	const graphEdges = indexedEdges.map((ie) => ({ from: ie.from, to: ie.to }));
	const adjacency = nodeAdjacency(nodesReadonly.length, graphEdges);
	const components = tarjanComponents(nodesReadonly.length, adjacency);
	for (const component of components) {
		if (component.length === 1) {
			const v = component[0];
			const selfLoop = indexedEdges.some((ie) => ie.from === v && ie.to === v);
			if (!selfLoop) continue;
			if (nodesReadonly[v].type !== "validate.loop") {
				issues.push({
					path: `nodes[${v}].id`,
					code: "CYCLE_NOT_SUPPORTED",
					message: `self-loop on "${nodesReadonly[v].id}" is not supported; every cycle must be bounded by exactly one validate.loop`,
				});
				continue;
			}
			const vId = nodesReadonly[v].id;
			const exit = indexedEdges.some(
				(ie) => ie.from === v && ie.to !== v,
			);
			if (!exit) {
				issues.push({
					path: `nodes[${v}].id`,
					code: "CYCLE_NOT_SUPPORTED",
					message: `validate.loop "${vId}" has no exit edge; the self-loop would be unbounded`,
				});
			}
			continue;
		}
		if (!validateSimpleLoopComponent(component, nodesReadonly, indexedEdges, issues)) {
			continue;
		}
	}

	// --- Per-type cross-checks: tool allowlist, task budget ------------------
	for (let i = 0; i < nodesReadonly.length; i++) {
		const node = nodesReadonly[i];
		const config = configs.get(node.id);
		if (config === undefined) continue; // already reported
		if (node.type === "tool.call") {
			const allowlist = options.toolAllowlist;
			if (allowlist === undefined) {
				issues.push({
					path: `nodes[${i}].config.tool`,
					code: "UNAUTHORIZED_TOOL",
					message: `no tool allowlist was supplied; tool.call "${node.id}" is denied by default`,
				});
			} else if (!allowlist.includes(config.tool)) {
				issues.push({
					path: `nodes[${i}].config.tool`,
					code: "UNAUTHORIZED_TOOL",
					message: `tool "${config.tool}" is not in the supplied allowlist`,
				});
			}
		}
		if (
			node.type === "validate.loop" &&
			"maxAttempts" in config &&
			options.taskBudget !== undefined
		) {
			if (
				!Number.isInteger(options.taskBudget) ||
				options.taskBudget < 1
			) {
				issues.push({
					path: "options.taskBudget",
					code: "INVALID_TYPE",
					message: "task budget must be a positive integer",
				});
			} else if (config.maxAttempts > options.taskBudget) {
				issues.push({
					path: `nodes[${i}].config.maxAttempts`,
					code: "INVALID_TYPE",
					message: `validate.loop "${node.id}" maxAttempts (${config.maxAttempts}) exceeds the task budget (${options.taskBudget})`,
				});
			}
		}
	}

	// --- Reachability: entries, coverage, terminal ---------------------------
	const hasIncoming = new Uint8Array(nodesReadonly.length);
	for (const ie of indexedEdges) hasIncoming[ie.to] = 1;
	const entries: number[] = [];
	for (let i = 0; i < nodesReadonly.length; i++) {
		if (hasIncoming[i] === 0) entries.push(i);
	}
	if (entries.length === 0) {
		issues.push({
			path: "nodes",
			code: "UNREACHABLE_REQUIRED_STEP",
			message:
				"no entry node: every node has an incoming edge, so execution cannot start",
		});
	} else {
		const reachable = reachableFrom(nodesReadonly.length, adjacency, entries);
		for (let i = 0; i < nodesReadonly.length; i++) {
			if (reachable[i] === 0) {
				issues.push({
					path: `nodes[${i}].id`,
					code: "UNREACHABLE_REQUIRED_STEP",
					message: `node "${nodesReadonly[i].id}" is unreachable from any entry node and would never execute`,
				});
			}
		}
	}
	const hasTerminal = nodesReadonly.some((_, i) => outgoing[i].length === 0);
	if (!hasTerminal) {
		issues.push({
			path: "nodes",
			code: "INVALID_TYPE",
			message:
				"no terminal node: every node has an outgoing edge, so execution cannot end",
		});
	}

	return { definition: def, configs, issues };
}

export function validateDefinition(
	def: WorkflowDefinition,
	options: ValidationOptions = {},
): Result<ValidatedDefinition, WorkflowIssue[]> {
	const validated = validateDefinitionParts(def, options);
	if (validated.issues.length > 0) return err(validated.issues);
	return ok(validated);
}

function validateWhenShape(
	edge: WorkflowEdge,
	i: number,
	issues: WorkflowIssue[],
): void {
	const when = edge.when;
	const okWhen =
		typeof when === "object" &&
		when !== null &&
		typeof when.left === "string" &&
		when.left.length > 0 &&
		(EDGE_OPERATORS as readonly string[]).includes(when.operator) &&
		(typeof when.right === "string" ||
			typeof when.right === "boolean" ||
			typeof when.right === "number");
	if (okWhen) return;
	issues.push({
		path: `edges[${i}].when`,
		code: "INVALID_TYPE",
		message:
			"edge condition `when` must be { left: non-empty string, operator: eq|ne|truthy, right: string|boolean|number } (regex-free, enumerated language only)",
	});
}

function validateSwitchEdges(
	firstEdge: { edge: WorkflowEdge; index: number },
	index: number,
	branches: string[],
	outgoingEdges: Array<{ edge: WorkflowEdge; index: number }>,
	issues: WorkflowIssue[],
): void {
	const lefts = new Set<string>();
	const mapped = new Map<string, number>();
	for (const outgoingEdge of outgoingEdges) {
		const when = outgoingEdge.edge.when;
		if (when === undefined) {
			issues.push({
				path: `edges[${outgoingEdge.index}].when`,
				code: "INVALID_TYPE",
				message: `outgoing edges of condition.switch must carry a "when" branch condition (edge from ${firstEdge.edge.from})`,
			});
			continue;
		}
		let invalidValue = false;
		if (when.operator !== "eq") {
			issues.push({
				path: `edges[${outgoingEdge.index}].when.operator`,
				code: "INVALID_TYPE",
				message: "condition.switch branches must use the enumerated \"eq\" operator; no free expressions",
			});
			invalidValue = true;
		}
		if (typeof when.right !== "string" || !branches.includes(when.right)) {
			issues.push({
				path: `edges[${outgoingEdge.index}].when.right`,
				code: "INVALID_TYPE",
				message: `switch edge condition must compare against one of the enumerated branches [${branches.join(", ")}]`,
			});
			invalidValue = true;
		}
		if (!invalidValue && typeof when.right === "string") {
			mapped.set(when.right, (mapped.get(when.right) ?? 0) + 1);
		}
		lefts.add(when.left);
	}
	if (lefts.size > 1) {
		issues.push({
			path: `edges[${index}].when.left`,
			code: "INVALID_TYPE",
			message: "all outgoing edges of a condition.switch must compare the same left variable",
		});
	}
	for (const branch of branches) {
		if (!mapped.has(branch)) {
			issues.push({
				path: `nodes.config.branches`,
				code: "INVALID_TYPE",
				message: `enumerated branch "${branch}" of condition.switch ${firstEdge.edge.from} has no outgoing edge`,
			});
		}
	}
	for (const [branch, count] of mapped) {
		if (count > 1) {
			issues.push({
				path: `edges.config.branches`,
				code: "INVALID_TYPE",
				message: `branch "${branch}" is mapped by ${count} outgoing edges; each branch must map to exactly one edge`,
			});
		}
	}
}

/**
 * A multi-node SCC is supported only if it forms one simple directed cycle
 * (every member has exactly one in-SCC out-edge and one in-SCC in-edge) that
 * contains exactly one validate.loop with an outgoing edge leaving the
 * component, and no condition.switch. Returns true when it qualifies.
 */
function validateSimpleLoopComponent(
	component: number[],
	nodes: WorkflowNode[],
	indexedEdges: Array<{ from: number; to: number }>,
	issues: WorkflowIssue[],
): boolean {
	const members = new Set(component);
	const hasSelfLoop = indexedEdges.some(
		(ie) => ie.from === ie.to && members.has(ie.from),
	);
	if (hasSelfLoop) {
		const label = component.map((i) => nodes[i].id).join(", ");
		issues.push({
			path: "nodes",
			code: "CYCLE_NOT_SUPPORTED",
			message: `cycle [${label}] contains a self-loop nested inside another cycle; only a single simple cycle bounded by one validate.loop is supported`,
		});
		return false;
	}
	const outDegrees = new Map<number, number>();
	const inDegrees = new Map<number, number>();
	for (const ie of indexedEdges) {
		if (!members.has(ie.from) || !members.has(ie.to)) continue;
		if (ie.from === ie.to) continue; // self-loop inside component: counted separately below
		outDegrees.set(ie.from, (outDegrees.get(ie.from) ?? 0) + 1);
		inDegrees.set(ie.to, (inDegrees.get(ie.to) ?? 0) + 1);
	}
	let simple = true;
	for (const nodeId of component) {
		if ((outDegrees.get(nodeId) ?? 0) !== 1 || (inDegrees.get(nodeId) ?? 0) !== 1) {
			simple = false;
			break;
		}
	}
	if (!simple) {
		const label = component.map((i) => nodes[i].id).join(", ");
		issues.push({
			path: "nodes",
			code: "CYCLE_NOT_SUPPORTED",
			message: `cycle [${label}] is nested or intersecting; only a single simple cycle bounded by one validate.loop is supported`,
		});
		return false;
	}
	const loopMembers = component.filter((i) => nodes[i].type === "validate.loop");
	if (loopMembers.length !== 1) {
		const label = component.map((i) => nodes[i].id).join(", ");
		issues.push({
			path: "nodes",
			code: "CYCLE_NOT_SUPPORTED",
			message: `cycle [${label}] must be bounded by exactly one validate.loop (found ${loopMembers.length})`,
		});
		return false;
	}
	const switchMember = component.find((i) => nodes[i].type === "condition.switch");
	if (switchMember !== undefined) {
		issues.push({
			path: `nodes[${switchMember}].id`,
			code: "CYCLE_NOT_SUPPORTED",
			message: `condition.switch "${nodes[switchMember].id}" participates in a cycle; branch back edges into an executed set are unsupported`,
		});
		return false;
	}
	const loopNode = nodes[loopMembers[0]];
	const hasExit = indexedEdges.some(
		(ie) => ie.from === loopMembers[0] && !members.has(ie.to),
	);
	if (!hasExit) {
		issues.push({
			path: `nodes[${loopMembers[0]}].id`,
			code: "CYCLE_NOT_SUPPORTED",
			message: `validate.loop "${loopNode.id}" has no exit edge; the cycle would be unbounded`,
		});
		return false;
	}
	return true;
}
