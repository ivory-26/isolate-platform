import type { Result } from "@isolate/shared";
import { newId, PlatformError } from "@isolate/shared";

/**
 * Visual workflow definition graph (architecture §6).
 *
 * Sprint B-3 grows the node registry, validation, and compiler. Stored JSON
 * must be versioned, validated, and independent of Mastra implementation
 * details; each run pins the version it started with.
 */
export const NODE_TYPES = [
	"task.agent",
	"tool.call",
	"approval.gate",
	"condition.switch",
	"validate.loop",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export type WorkflowNode = {
	id: string; // stable, unique within the graph
	type: NodeType;
	label: string;
	// Declared input/output schemas are Zod-JSON drafts; node registry validates.
	config: Record<string, unknown>;
};

export type WorkflowEdge = {
	from: string;
	to: string;
	// Reserved for condition.switch branches; regex-free, enumerated.
	when?: {
		left: string;
		operator: "eq" | "ne" | "truthy";
		right: string | boolean | number;
	};
};

export type WorkflowDefinition = {
	id: string;
	name: string;
	version: number;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
};

/** Validation failures are structured issues, never thrown. */
export type WorkflowIssue = {
	path: string; // e.g. "edges[2].to"
	code:
		| "MISSING_NODE"
		| "DUPLICATE_ID"
		| "UNREACHABLE_REQUIRED_STEP"
		| "INVALID_TYPE"
		| "UNSAFE_CONFIG"
		| "CYCLE_NOT_SUPPORTED";
	message: string;
};

/**
 * Baseline structural validator (this stub intentionally implements the two
 * checks that are safe without a node registry: unique ids and edge endpoint
 * resolution). Sprint B-3 replaces it with the full registry-backed version.
 */
export function validateDefinition(
	def: WorkflowDefinition,
): Result<WorkflowDefinition, WorkflowIssue[]> {
	const issues: WorkflowIssue[] = [];
	const ids = new Set<string>();
	for (let i = 0; i < def.nodes.length; i++) {
		const n = def.nodes[i];
		if (ids.has(n.id)) {
			issues.push({
				path: `nodes[${i}].id`,
				code: "DUPLICATE_ID",
				message: `duplicate node id ${n.id}`,
			});
		}
		ids.add(n.id);
	}
	for (let i = 0; i < def.edges.length; i++) {
		const e = def.edges[i];
		if (!ids.has(e.from)) {
			issues.push({
				path: `edges[${i}].from`,
				code: "MISSING_NODE",
				message: `edge references missing node ${e.from}`,
			});
		}
		if (!ids.has(e.to)) {
			issues.push({
				path: `edges[${i}].to`,
				code: "MISSING_NODE",
				message: `edge references missing node ${e.to}`,
			});
		}
	}
	if (issues.length > 0) return { ok: false, error: issues };
	return { ok: true, value: def };
}

/**
 * Compiled, version-pinned plan that the worker can hand to the Mastra runtime.
 * Plan entries reference node registry entries by id — arbitrary user
 * expressions/TS are never compiled here (no eval, no dynamic codegen).
 */
export type CompiledWorkflow = {
	workflowId: string;
	versionPinned: number;
	planId: string;
	steps: Array<{ nodeId: string; type: NodeType; order: number }>;
};

export function compileWorkflow(
	def: WorkflowDefinition,
): Result<CompiledWorkflow, WorkflowIssue[]> {
	const validated = validateDefinition(def);
	if (!validated.ok) return validated;
	return {
		ok: true,
		value: {
			workflowId: def.id,
			versionPinned: def.version,
			planId: newId("plan"),
			steps: def.nodes.map((n, i) => ({
				nodeId: n.id,
				type: n.type,
				order: i,
			})),
		},
	};
}

export function workflowNotSupported(detail: string): PlatformError {
	return new PlatformError(
		"VALIDATION_FAILED",
		`workflow define rejected: ${detail}`,
	);
}
