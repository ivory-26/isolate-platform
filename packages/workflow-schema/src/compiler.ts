import { newId } from "@isolate/shared";
import type { Result } from "@isolate/shared";
import { nodeAdjacency, tarjanComponents } from "./graph";
import { validateDefinitionParts } from "./validate";
import type {
	CompiledWorkflow,
	CompileOptions,
	WorkflowDefinition,
	WorkflowIssue,
} from "./types";

/**
 * Compiles a validated, version-pinned definition into an execution plan:
 * - refuses any input that has not passed the full validation registry;
 * - optionally refuses mismatched versions (MISSING_VERSION) so a run always
 *   executes exactly the definition version it pinned at start;
 * - orders steps by deterministic topological order over strongly connected
 *   components; a supported validate.loop component is emitted with the loop
 *   node first, followed by its body along the cycle edges;
 * - attaches each node's Zod-validated config, verbatim edges, and entry ids;
 * - performs NO dynamic code generation (no eval, no new Function, no
 *   arbitrary TS) — the plan is plain data the runtime interprets.
 *
 * planId is unique per compile call; the ordered steps and edges are a pure
 * function of the definition, so repeated compiles of the same graph are
 * identical apart from planId.
 */
export function compileWorkflow(
	def: WorkflowDefinition,
	options: CompileOptions = {},
): Result<CompiledWorkflow, WorkflowIssue[]> {
	if (
		options.expectedVersion !== undefined &&
		options.expectedVersion !== def.version
	) {
		return {
			ok: false,
			error: [
				{
					path: "version",
					code: "MISSING_VERSION",
					message: `definition version ${def.version} does not match the pinned version ${options.expectedVersion}`,
				},
			],
		};
	}

	const validated = validateDefinitionParts(def, options);
	if (validated.issues.length > 0) return { ok: false, error: validated.issues };

	const nodes = def.nodes;
	const graphEdges = edgesAsIndices(def);
	const adjacency = nodeAdjacency(nodes.length, graphEdges);
	const components = tarjanComponents(nodes.length, adjacency);

	const componentOfNode = new Int32Array(nodes.length);
	for (let c = 0; c < components.length; c++) {
		for (const nodeIndex of components[c]) componentOfNode[nodeIndex] = c;
	}

	const componentOrder = topologicalComponentOrder(
		components,
		componentOfNode,
		adjacency,
		graphEdges,
		nodes,
	);

	const steps: CompiledWorkflow["steps"] = [];
	let order = 0;
	for (const componentNodes of componentOrder) {
		for (const nodeIndex of componentNodes) {
			const node = nodes[nodeIndex];
			const config = validated.configs.get(node.id);
			if (config === undefined) {
				// Unreachable for accepted definitions; guarded for type safety.
				return {
					ok: false,
					error: [
						{
							path: `nodes[${nodeIndex}].config`,
							code: "INVALID_TYPE",
							message: "internal: validated config missing after successful validation",
						},
					],
				};
			}
			steps.push({
				nodeId: node.id,
				type: node.type,
				order: order++,
				config,
			});
		}
	}

	const entryNodeIds: string[] = [];
	const hasIncoming = new Uint8Array(nodes.length);
	for (const edge of graphEdges) {
		if (edge.to >= 0 && edge.to < nodes.length) hasIncoming[edge.to] = 1;
	}
	for (let i = 0; i < nodes.length; i++) {
		if (hasIncoming[i] === 0) entryNodeIds.push(nodes[i].id);
	}

	return {
		ok: true,
		value: {
			workflowId: def.id,
			versionPinned: def.version,
			planId: newId("plan"),
			entryNodeIds,
			steps,
			edges: def.edges.map((edge) =>
				edge.when === undefined
					? { ...edge }
					: { ...edge, when: { ...edge.when } },
			),
		},
	};
}

function edgesAsIndices(
	def: WorkflowDefinition,
): Array<{ from: number; to: number }> {
	// Validation has already run, so endpoints resolve; map defensively for
	// structurally broken inputs.
	const indexOf = new Map<string, number>();
	def.nodes.forEach((node, i) => indexOf.set(node.id, i));
	return def.edges.map((edge) => ({
		from: indexOf.get(edge.from) ?? -1,
		to: indexOf.get(edge.to) ?? -1,
	}));
}

/** Deterministic Kahn's algorithm over the condensed component DAG. */
function topologicalComponentOrder(
	components: number[][],
	componentOfNode: Int32Array,
	adjacency: number[][],
	graphEdges: Array<{ from: number; to: number }>,
	nodes: WorkflowDefinition["nodes"],
): number[][] {
	const componentCount = components.length;
	const compTargets: Array<Set<number>> = Array.from(
		{ length: componentCount },
		() => new Set<number>(),
	);
	for (const edge of graphEdges) {
		if (edge.from < 0 || edge.to < 0) continue;
		const from = componentOfNode[edge.from];
		const to = componentOfNode[edge.to];
		if (from === to) continue;
		compTargets[from].add(to);
	}
	const compInDegree = new Int32Array(componentCount);
	for (const targeting of compTargets) {
		for (const target of targeting) compInDegree[target]++;
	}

	const ordered: number[][] = [];
	const done = new Uint8Array(componentCount);
	for (;;) {
		// Deterministic tie-break: the ready component containing the earliest
		// declared node wins.
		let best = -1;
		let bestKey = Number.POSITIVE_INFINITY;
		for (let c = 0; c < componentCount; c++) {
			if (done[c] === 1 || compInDegree[c] > 0) continue;
			const key = Math.min(...components[c]);
			if (key < bestKey) {
				bestKey = key;
				best = c;
			}
		}
		if (best === -1) break;
		done[best] = 1;
		for (const target of compTargets[best]) compInDegree[target]--;
		ordered.push(orderedNodesForComponent(components[best], adjacency, nodes));
	}
	return ordered;
}

/**
 * Node order inside one component: a singleton stays as-is; a supported loop
 * component starts at its validate.loop node and follows the cycle edges so
 * the bounded check precedes the body it re-enters.
 */
function orderedNodesForComponent(
	nodeIndexes: number[],
	adjacency: number[][],
	nodes: WorkflowDefinition["nodes"],
): number[] {
	if (nodeIndexes.length <= 1) return [...nodeIndexes].sort((a, b) => a - b);
	const members = new Set(nodeIndexes);
	const loopIndex = nodeIndexes.find((i) => nodes[i].type === "validate.loop");
	if (loopIndex === undefined) {
		// Cannot happen for validated definitions; fall back to definition order.
		return [...nodeIndexes].sort((a, b) => a - b);
	}
	const inComponentSuccessors = (v: number): number[] => {
		return adjacency[v].filter((w) => members.has(w));
	};
	const ordered: number[] = [loopIndex];
	let current = inComponentSuccessors(loopIndex)[0];
	while (current !== undefined && current !== loopIndex) {
		ordered.push(current);
		const next = inComponentSuccessors(current);
		current = next.length > 0 ? next[0] : undefined;
	}
	return ordered;
}
