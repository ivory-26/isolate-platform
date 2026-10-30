import {
	BASE_ERROR_CODES,
	type ErrorCode,
	errorCodeOf,
	isPlatformError,
	PLATFORM_ERROR_CODES,
} from "@isolate/shared";
import type { ToolAction } from "@mastra/core/tools";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type {
	PolicyDecision,
	ToolName,
	ToolPolicy,
	ToolPolicyInput,
} from "./policy";

/** Bounded error-code enum mirroring `@isolate/shared` ErrorCode. */
const ErrorCodeSchema = z.enum([...BASE_ERROR_CODES, ...PLATFORM_ERROR_CODES]);

/**
 * Platform tool wiring (architecture §3/§8): every tool is a real Mastra
 * `createTool` whose `execute` is gated by the trusted `PolicyDecision` from
 * `tools/policy.ts`. The gate is deny-by-default: a tool call only reaches its
 * implementation when the policy resolves `{ allowed: true, risk: "read_only",
 * audited: true }` (or a caller-supplied policy explicitly approves a scoped or
 * sensitive action that carries a persisted approval). Denials surface as
 * structured results; they are never silently allowed and never throw raw
 * infrastructure errors into model context.
 */

export type ToolDenialReason =
	| "POLICY_DENIED"
	| "APPROVAL_REQUIRED"
	| "SCOPE_MISSING";

/** Structured outcome of a wired tool call. Never contains payloads/stacks. */
export type WiredToolOutput =
	| { state: "executed"; audited: true; value: Record<string, unknown> }
	| { state: "denied"; reason: ToolDenialReason }
	| { state: "failed"; code: ErrorCode };

export const WiredToolOutputSchema = z.discriminatedUnion("state", [
	z.object({
		state: z.literal("executed"),
		audited: z.literal(true),
		value: z.record(z.string(), z.unknown()),
	}),
	z.object({
		state: z.literal("denied"),
		reason: z.enum(["POLICY_DENIED", "APPROVAL_REQUIRED", "SCOPE_MISSING"]),
	}),
	z.object({ state: z.literal("failed"), code: ErrorCodeSchema }),
]);

/** Per-task binding supplied by trusted code; the model never provides it. */
export type ToolCallContext = {
	organizationId: string;
	taskId: string;
	scopes: readonly string[];
	/**
	 * Wave 7: authored paths this task may modify (globs allowed). Absent or
	 * empty means "no write tool may run". Supplied by the worker from the
	 * persisted task row, never by the model.
	 */
	fileOwnership?: readonly string[];
};

/**
 * Audit record for one resolved policy decision. Ids + reason only — safe for
 * append-only audit stores.
 */
export type ToolDecisionRecord = {
	tool: ToolName;
	taskId: string;
	organizationId: string;
	outcome: "executed" | "denied";
	reason: ToolDenialReason | null;
};

/**
 * Trusted implementation of one tool. Runs only after an "allowed" decision.
 * Returns JSON-safe values; thrown errors are collapsed to a bounded
 * `ErrorCode` before leaving the gate.
 */
export type ToolImplementation = (
	args: Record<string, unknown>,
	context: ToolCallContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type ToolWiringOptions = {
	/** Trusted, server-only policy resolver (deny-by-default). */
	policy: ToolPolicy;
	/**
	 * Trusted implementations keyed by tool name. A name without an entry stays
	 * deny-by-default even if policy would allow it.
	 */
	implementations: Partial<Record<ToolName, ToolImplementation>>;
	/** Optional audit sink; ignored failures must not allow side effects. */
	onDecision?: (record: ToolDecisionRecord) => Promise<void> | void;
};

const DENIAL_REASONS: ReadonlySet<string> = new Set([
	"POLICY_DENIED",
	"APPROVAL_REQUIRED",
	"SCOPE_MISSING",
]);

/**
 * A wired tool: a Mastra tool with `WiredToolOutput` as its validated output
 * schema and the policy gate baked into `execute`.
 */
export type WiredTool = ToolAction<
	// biome-ignore lint/suspicious/noExplicitAny: matches Mastra registry erasure (Record<name, ToolAction<any,…>>) so per-tool input schemas can vary
	any,
	WiredToolOutput,
	unknown,
	unknown,
	// biome-ignore lint/suspicious/noExplicitAny: matches Mastra registry erasure of the tool execution context
	any,
	ToolName,
	unknown
>;

export type WiredToolCollection = Record<ToolName, WiredTool>;

export type WiredToolRegistry = {
	/**
	 * Binds the registry to one task context. Each call returns fresh tool
	 * objects so mutating shared instances across tasks is impossible.
	 */
	forTask(context: ToolCallContext): WiredToolCollection;
};

function describeTool(name: ToolName): string {
	return `Platform tool ${name}. Execution is gated by the trusted policy resolver; denied or approval-required calls return a structured denial instead of executing.`;
}

function mapDenial(error: unknown): ToolDenialReason {
	if (isPlatformError(error)) {
		return DENIAL_REASONS.has(error.code)
			? (error.code as ToolDenialReason)
			: "POLICY_DENIED";
	}
	return "POLICY_DENIED";
}

export function wirePlatformTools(
	options: ToolWiringOptions,
): WiredToolRegistry {
	const toolNames: ToolName[] = [
		"repo.read_file",
		"repo.write_file",
		"repo.list_files",
		"repo.search",
		"git.read",
		"git.diff_summary",
		"git.commit_local",
		"git.push_branch",
		"github.create_pull_request",
		"github.merge_pull_request",
		"db.migrate",
		"deploy.request",
		"sandbox.exec",
	];

	return {
		forTask(context: ToolCallContext): WiredToolCollection {
			const collection = {} as WiredToolCollection;
			for (const name of toolNames) {
				collection[name] = createTool({
					id: name,
					title: name,
					description: describeTool(name),
					inputSchema: z.record(z.string(), z.unknown()),
					outputSchema: WiredToolOutputSchema,
					/**
					 * Never rely on Mastra's `requireApproval` here: approval
					 * routing is the policy decision's `APPROVAL_REQUIRED` band,
					 * surfaced to trusted callers for a persisted approval. It is
					 * never silently allowed and never parked on model judgement.
					 */
					execute: async (inputData) => {
						const args =
							typeof inputData === "object" && inputData !== null
								? (inputData as Record<string, unknown>)
								: {};
						const policyInput: ToolPolicyInput = {
							tool: name,
							organizationId: context.organizationId,
							taskId: context.taskId,
							arguments: args,
							scopes: [...context.scopes],
						};

						let resolved: PolicyDecision;
						try {
							const result = await options.policy(policyInput);
							resolved = result.ok
								? result.value
								: {
										allowed: false,
										reason: mapDenial(result.error),
									};
						} catch {
							resolved = {
								allowed: false,
								reason: "POLICY_DENIED" as const,
							};
						}

						if (!resolved.allowed) {
							const denial: WiredToolOutput = {
								state: "denied",
								reason: resolved.reason,
							};
							await options.onDecision?.({
								tool: name,
								taskId: context.taskId,
								organizationId: context.organizationId,
								outcome: "denied",
								reason: resolved.reason,
							});
							return denial;
						}

						const implementation = options.implementations[name];
						if (!implementation) {
							// Allowlisted but unimplemented stays deny-by-default.
							await options.onDecision?.({
								tool: name,
								taskId: context.taskId,
								organizationId: context.organizationId,
								outcome: "denied",
								reason: "POLICY_DENIED" as const,
							});
							return {
								state: "denied",
								reason: "POLICY_DENIED" as const,
							} satisfies WiredToolOutput;
						}

						await options.onDecision?.({
							tool: name,
							taskId: context.taskId,
							organizationId: context.organizationId,
							outcome: "executed",
							reason: null,
						});

						try {
							const value = await implementation(args, context);
							return {
								state: "executed" as const,
								audited: true,
								value,
							} satisfies WiredToolOutput;
						} catch (error) {
							return {
								state: "failed" as const,
								code: errorCodeOf(error),
							} satisfies WiredToolOutput;
						}
					},
				});
			}
			return collection;
		},
	};
}
