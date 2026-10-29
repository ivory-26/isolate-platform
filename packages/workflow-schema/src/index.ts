/**
 * Versioned workflow graphs, finite node registry, validation, and compilation.
 *
 * Supports task.agent, allowlisted tool.call, approval.gate, enumerated
 * condition.switch branches, and simple cycles bounded by one validate.loop
 * with an exit. Definitions and compiled plans remain plain data, never code.
 *
 * Node ids must be non-empty, unique, and dot-free: Mastra interprets a dot as
 * a path separator when resuming suspended steps. Dotted ids fail validation
 * and compilation with an INVALID_NODE_ID issue at nodes[index].id. They are
 * never sanitized or rewritten. Other dot-free ids remain supported; dots in
 * workflow ids, node type names, config references, and branch values are not
 * subject to this restriction.
 *
 * validateDefinition(input: unknown) and compileWorkflow(input: unknown) accept
 * authored JSON directly. An outer object/array guard runs before inspecting
 * graph members; a strict shape guard then checks nodes, edges, and conditions
 * before registry/policy checks or compilation. Unknown fields are rejected,
 * never stripped. No coercion, expression evaluation, or authored code runs.
 *
 * Failures are structured issues, not throws. Root issues use "$"; unknown
 * fields use the containing object/config path so authored keys and values
 * are not echoed in diagnostics. Condition shape errors identify the field.
 * Success returns typed definitions/plans; options remain caller-typed policy
 * inputs. The boundary covers JSON data, not programmatic proxies/getters.
 * Canonical stored graph identity/version consistency is a service concern.
 */
import { PlatformError } from "@isolate/shared";

export * from "./compiler";
export * from "./graph";
export * from "./nodes";
export * from "./types";
export * from "./validate";

/**
 * Error construction for the control plane: structured code, no payloads or
 * stack traces, never leaking definition content into the message.
 */
export function workflowNotSupported(detail: string): PlatformError {
	return new PlatformError(
		"VALIDATION_FAILED",
		`workflow define rejected: ${detail}`,
	);
}
