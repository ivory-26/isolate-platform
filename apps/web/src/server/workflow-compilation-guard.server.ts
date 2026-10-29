import "@tanstack/react-start/server-only";
import {
	serializeWorkflowJson,
	type WorkflowRejectionIssue,
} from "@isolate/db";
import {
	EDGE_OPERATORS,
	NODE_TYPES,
	type WorkflowDefinition,
	type WorkflowIssue,
} from "@isolate/workflow-schema";
import { z } from "zod";

export const pgVersionSchema = z.number().int().min(1).max(2147483647);
export const compileVersionRequestSchema = z.strictObject({
	workflowDefinitionId: z.uuid().transform((id) => id.toLowerCase()),
	workflowVersion: pgVersionSchema,
});
export const compilationPolicySchema = z.strictObject({
	toolAllowlist: z.array(z.string().min(1)),
	taskBudget: pgVersionSchema,
});

// This guards the legacy compiler's structural assumptions; its registry still
// validates configs, references, graph semantics, tool access and loop budgets.
const graphSchema = z.object({
	id: z.string(),
	name: z.string(),
	version: z.number(),
	nodes: z.array(
		z.object({
			id: z.string(),
			type: z.enum(NODE_TYPES),
			label: z.string(),
			config: z.record(z.string(), z.unknown()),
		}),
	),
	edges: z.array(
		z.object({
			from: z.string(),
			to: z.string(),
			when: z
				.object({
					left: z.string(),
					operator: z.enum(EDGE_OPERATORS),
					right: z.union([z.string(), z.boolean(), z.number()]),
				})
				.optional(),
		}),
	),
});

const issueMessages = {
	MISSING_NODE: "An edge references a missing workflow node.",
	DUPLICATE_ID: "Workflow node IDs must be unique.",
	INVALID_NODE_ID: "Workflow node IDs must not contain dots.",
	UNREACHABLE_REQUIRED_STEP:
		"The workflow contains an unreachable required step.",
	INVALID_TYPE: "A workflow field has an invalid type or value.",
	UNSAFE_CONFIG:
		"The workflow contains unsupported or unbounded configuration.",
	CYCLE_NOT_SUPPORTED: "The workflow contains an unsupported cycle.",
	UNAUTHORIZED_TOOL: "A workflow tool is not permitted by server policy.",
	MISSING_VERSION: "The workflow version does not match its stored pin.",
	MALFORMED_GRAPH: "The stored workflow graph has an invalid structure.",
	PIN_MISMATCH:
		"The stored graph does not match its authored definition/version pin.",
} as const;
export function safeCompilationIssue(
	code: keyof typeof issueMessages,
	path = "graph",
): WorkflowRejectionIssue {
	return { code, path, message: issueMessages[code] };
}
export function readGuardedGraph(input: unknown): WorkflowDefinition | null {
	try {
		// Reuse the DB's hook-free JSON snapshot: never invoke getters, proxies,
		// iterators or toJSON on a malformed/compromised stored value.
		const snapshot: unknown = JSON.parse(serializeWorkflowJson(input));
		const parsed = graphSchema.safeParse(snapshot);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function safeIssuePath(path: string): string {
	if (path.length > 160) return "graph";
	// Never preserve arbitrary config-key suffixes or node IDs as locations.
	if (/^(id|name|version|nodes|edges)$/.test(path)) return path;
	if (
		/^(nodes|edges)\[(0|[1-9][0-9]{0,5})\](\.(id|type|label|config|from|to|when|left|operator|right|agentId|promptTemplateId|tool|action|risk|branches|maxAttempts))*$/.test(
			path,
		)
	)
		return path;
	const config = /^(nodes\[(0|[1-9][0-9]{0,5})\]\.config)(\.|$)/.exec(path);
	return config?.[1] ?? "graph";
}
export function sanitizeCompilationIssues(
	issues: readonly WorkflowIssue[],
): WorkflowRejectionIssue[] {
	if (issues.length === 0) return [safeCompilationIssue("INVALID_TYPE")];
	return issues.slice(0, 100).map((issue) => {
		const code = Object.hasOwn(issueMessages, issue.code)
			? issue.code
			: "INVALID_TYPE";
		return safeCompilationIssue(code, safeIssuePath(issue.path));
	});
}
