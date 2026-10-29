import { err, ok, type Result } from "@isolate/shared";
import { z } from "zod";
import {
	EDGE_OPERATORS,
	NODE_TYPES,
	type WorkflowDefinition,
	type WorkflowIssue,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Check the envelope before inspecting any node, edge, or condition.
const envelopeSchema = z.strictObject(
	{
		id: z.string({ error: "definition id must be a non-empty string" }),
		name: z.string({ error: "definition name must be a non-empty string" }),
		version: z.number({
			error: "definition version must be a positive integer",
		}),
		nodes: z.custom<unknown[]>(Array.isArray, {
			error: "definition nodes must be an array",
		}),
		edges: z.custom<unknown[]>(Array.isArray, {
			error: "definition edges must be an array",
		}),
	},
	{ error: "workflow definition must be an object" },
);

const conditionMessage =
	"edge condition `when` must be { left: non-empty string, operator: eq|ne|truthy, right: string|boolean|number } (regex-free, enumerated language only)";
const conditionSchema = z.strictObject({
	left: z.string().min(1),
	operator: z.enum(EDGE_OPERATORS),
	right: z.union([z.string(), z.boolean(), z.number()]),
});
const nodeSchema = z.strictObject(
	{
		id: z.string({ error: "node id must be a non-empty string" }),
		type: z.enum(NODE_TYPES, {
			error: "node type must be a registered node type",
		}),
		label: z.string({ error: "node label must be a non-empty string" }),
		// Keep the original config for strict registry validation, including all keys.
		config: z.custom<Record<string, unknown>>(isRecord, {
			error: "node config must be an object",
		}),
	},
	{ error: "node must be an object" },
);
const edgeSchema = z.strictObject(
	{
		from: z
			.string({ error: "edge source must be a non-empty node id" })
			.min(1, { error: "edge source must be a non-empty node id" }),
		to: z
			.string({ error: "edge target must be a non-empty node id" })
			.min(1, { error: "edge target must be a non-empty node id" }),
		when: conditionSchema.optional(),
	},
	{ error: "edge must be an object" },
);
const definitionSchema = envelopeSchema.extend({
	nodes: z.array(nodeSchema),
	edges: z.array(edgeSchema),
}) satisfies z.ZodType<WorkflowDefinition>;

function shapeIssues(error: z.ZodError): WorkflowIssue[] {
	return error.issues.map((issue) => {
		// Schema paths contain only declared field names and numeric indices.
		// Never use unrecognized_keys or union details in diagnostics.
		let path = "";
		for (const part of issue.path) {
			path +=
				typeof part === "number"
					? `[${part}]`
					: (path ? "." : "") + String(part);
		}
		return {
			path: path || "$",
			code:
				issue.code === "unrecognized_keys" ? "UNSAFE_CONFIG" : "INVALID_TYPE",
			message:
				issue.code === "unrecognized_keys"
					? "undeclared fields are not allowed"
					: issue.path.includes("when")
						? conditionMessage
						: issue.message,
		};
	});
}

/** Runtime proof of the graph shape; no authored code is evaluated or coerced. */
export function parseDefinitionShape(
	input: unknown,
): Result<WorkflowDefinition, WorkflowIssue[]> {
	const envelope = envelopeSchema.safeParse(input);
	if (!envelope.success) return err(shapeIssues(envelope.error));
	const definition = definitionSchema.safeParse(envelope.data);
	if (!definition.success) return err(shapeIssues(definition.error));
	return ok(definition.data);
}
