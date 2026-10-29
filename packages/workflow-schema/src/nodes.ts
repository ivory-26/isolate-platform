import { z } from "zod";
import {
	APPROVAL_RISK_LEVELS,
	NODE_TYPES,
	type NodeConfigMap,
	type NodeType,
	type WorkflowIssue,
} from "./types";

/** Hard cap for validate.loop attempts when no task budget is supplied. */
export const MAX_LOOP_ATTEMPTS = 10;

/**
 * Finite node registry: exactly one strict Zod schema per node type. Strict
 * objects reject undeclared fields, which the validator maps to UNSAFE_CONFIG
 * at the config boundary without echoing authored keys.
 */
export const NODE_CONFIG_SCHEMAS = {
	"task.agent": z.strictObject({
		agentId: z.string().min(1),
		// Reference to a stored prompt template — never an inline prompt.
		promptTemplateId: z.string().min(1),
	}),
	"tool.call": z.strictObject({
		tool: z.string().min(1),
	}),
	"approval.gate": z.strictObject({
		action: z.string().min(1),
		risk: z.enum(APPROVAL_RISK_LEVELS),
	}),
	"condition.switch": z.strictObject({
		// Enumerated branch names only. There is no free-expression field.
		branches: z
			.array(z.string().min(1))
			.min(2, "condition.switch must enumerate at least two branches")
			.refine((branches) => new Set(branches).size === branches.length, {
				message: "branches must be distinct",
			}),
	}),
	"validate.loop": z.strictObject({
		// Bounded attempts; also cross-checked against the supplied task budget.
		maxAttempts: z.number().int().min(1).max(MAX_LOOP_ATTEMPTS),
	}),
} as const satisfies Record<NodeType, z.ZodType>;

export type AnyNodeConfigSchema = (typeof NODE_CONFIG_SCHEMAS)[NodeType];

/**
 * Parses a node config against its registry schema, appending structured
 * issues on failure:
 * - unknown keys of the strict object → UNSAFE_CONFIG at the config path
 * - anything else (wrong type/value) → INVALID_TYPE
 */
export function parseNodeConfig(
	type: NodeType,
	config: unknown,
	issues: WorkflowIssue[],
	path: string,
): NodeConfigMap[NodeType] | undefined {
	if (!NODE_TYPES.includes(type)) {
		issues.push({
			path: `${path}.type`,
			code: "INVALID_TYPE",
			message: "node type must be a registered node type",
		});
		return undefined;
	}
	const schema = NODE_CONFIG_SCHEMAS[type];
	if (
		typeof config === "object" &&
		config !== null &&
		!Array.isArray(config) &&
		Object.keys(config).some((key) => !Object.hasOwn(schema.shape, key))
	) {
		issues.push({
			path,
			code: "UNSAFE_CONFIG",
			message: "config contains undeclared fields",
		});
		return undefined;
	}
	const parsed = schema.safeParse(config);
	if (parsed.success) return parsed.data;
	for (const issue of parsed.error.issues) {
		if (issue.code === "unrecognized_keys") {
			issues.push({
				path,
				code: "UNSAFE_CONFIG",
				message: "config contains undeclared fields",
			});
			continue;
		}
		const subPath =
			issue.path.length > 0
				? `${path}.${issue.path.map(String).join(".")}`
				: path;
		issues.push({
			path: subPath,
			code: "INVALID_TYPE",
			message: issue.message,
		});
	}
	return undefined;
}
