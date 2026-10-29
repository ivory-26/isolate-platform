import type { Result } from "@isolate/shared";

/**
 * Visual workflow definition graph types (architecture §6).
 *
 * Definitions are stored as versioned JSON, validated against a finite node
 * registry, and kept independent of Mastra implementation details. Each run
 * pins the definition version it was compiled from: later edits can never
 * silently change an active execution.
 *
 * WorkflowDefinition describes parsed graph data, not proof that an authored
 * value is valid. Public validation/compilation accept unknown; callers pass
 * JSON directly without asserting this type. Success provides typed values,
 * while malformed/unsupported JSON returns WorkflowIssue[] without throwing.
 */

export const NODE_TYPES = [
	"task.agent",
	"tool.call",
	"approval.gate",
	"condition.switch",
	"validate.loop",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const APPROVAL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

export const EDGE_OPERATORS = ["eq", "ne", "truthy"] as const;
export type EdgeOperator = (typeof EDGE_OPERATORS)[number];

/**
 * Suggested slug grammar for authoring node ids (kebab/snake slugs).
 *
 * This is not the validator acceptance grammar: to preserve existing graph
 * support, validation only requires non-empty, dot-free node ids. Mastra treats
 * dots as resume path separators, so dotted ids are rejected without rewriting
 * ids or edge references; other dot-free characters remain supported.
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export type WorkflowNode = {
	id: string; // stable, unique within the graph; non-empty and dot-free
	type: NodeType;
	label: string;
	// Declared input/output schemas are Zod-JSON drafts; node registry validates.
	config: Record<string, unknown>;
};

export type WorkflowEdge = {
	from: string;
	to: string;
	// Reserved for condition.switch branch selection; regex-free, enumerated.
	// Only the "eq" operator against an enumerated branch value is compiled;
	// "ne"/"truthy" remain part of the declared type for future, tightly
	// enumerated uses and are rejected for switch edges by validation.
	when?: {
		left: string;
		operator: "eq" | "ne" | "truthy";
		right: string | boolean | number;
	};
};

/** Parsed graph shape; semantic/config checks still gate public success. */
export type WorkflowDefinition = {
	id: string;
	name: string;
	version: number;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
};

/** Per-node-type validated configurations (finite, enumerated registry). */
export type NodeConfigMap = {
	"task.agent": {
		agentId: string;
		promptTemplateId: string;
	};
	"tool.call": {
		tool: string;
	};
	"approval.gate": {
		action: string;
		risk: ApprovalRiskLevel;
	};
	"condition.switch": {
		branches: string[];
	};
	"validate.loop": {
		maxAttempts: number;
	};
};

export type NodeConfig = NodeConfigMap[NodeType];

/** Named aliases for the two most cross-checked node configs. */
export type AgentTaskConfig = NodeConfigMap["task.agent"];
export type ValidateLoopConfig = NodeConfigMap["validate.loop"];

export type ValidationOptions = {
	/**
	 * Allowed tool names for tool.call nodes. When omitted, tool.call is
	 * denied by default (UNAUTHORIZED_TOOL) — the platform fails closed.
	 */
	toolAllowlist?: readonly string[];
	/**
	 * Total attempt budget for the workflow run. When supplied, every
	 * validate.loop maxAttempts must not exceed it.
	 */
	taskBudget?: number;
};

/**
 * Validation failures are structured issues, never thrown.
 *
 * Codes beyond the original six (UNAUTHORIZED_TOOL, MISSING_VERSION) were
 * added by Sprint B-3; the original codes keep their meaning. INVALID_NODE_ID
 * separately classifies dotted node ids that break Mastra resume routing.
 */
export type WorkflowIssueCode =
	| "MISSING_NODE"
	| "DUPLICATE_ID"
	| "INVALID_NODE_ID"
	| "UNREACHABLE_REQUIRED_STEP"
	| "INVALID_TYPE"
	| "UNSAFE_CONFIG"
	| "CYCLE_NOT_SUPPORTED"
	| "UNAUTHORIZED_TOOL"
	| "MISSING_VERSION";

export type WorkflowIssue = {
	/** "$" for the root; otherwise declared fields/indices, e.g. edges[2].to.
	 * Unknown-field issues point at their container, never the authored key. */
	path: string;
	code: WorkflowIssueCode;
	/** Diagnostic text does not reflect authored keys or values. */
	message: string;
};

export type ValidatedDefinition = {
	/** Parsed graph; normalized registry configs are available in configs. */
	definition: WorkflowDefinition;
	/** Zod-parsed, per-node validated config keyed by node id. */
	configs: Map<string, NodeConfig>;
	issues: WorkflowIssue[];
};

export type ValidationIssueResult = Result<
	ValidatedDefinition,
	WorkflowIssue[]
>;

export type CompiledStep = {
	nodeId: string;
	type: NodeType;
	order: number;
	/** Validated, zod-normalized config for this node. */
	config: NodeConfig;
};

/**
 * Compiled, version-pinned plan that the worker can hand to the Mastra runtime.
 * Steps are in deterministic topological order; simple validate.loop cycles are
 * lowered with the loop node ordered ahead of its body. Edges are carried
 * verbatim (definition order) so the runtime does not re-derive routing.
 * Plan entries reference node registry entries by id — arbitrary user
 * expressions/TS are never compiled here (no eval, no dynamic codegen).
 */
export type CompiledWorkflow = {
	workflowId: string;
	versionPinned: number;
	planId: string;
	/** Nodes with no incoming edges, in definition order. */
	entryNodeIds: string[];
	steps: Array<CompiledStep>;
	edges: Array<WorkflowEdge>;
};

export type CompileOptions = ValidationOptions & {
	/**
	 * When supplied, the definition version must equal it exactly; a mismatch
	 * is reported as MISSING_VERSION after shape checks, before registry/policy
	 * checks, and compilation is refused. Callers pass
	 * the version stored when the run was created.
	 */
	expectedVersion?: number;
};
