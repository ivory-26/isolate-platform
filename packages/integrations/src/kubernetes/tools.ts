import { PlatformError } from "@isolate/shared";
import { z } from "zod";
import {
	KUBERNETES_CONTEXT_LOG_TAIL_LINES,
	type KubernetesContextDependencies,
	readKubernetesDeployment,
	readKubernetesLogTail,
	readKubernetesPod,
	readKubernetesWarningEvents,
} from "./context";
import { KUBERNETES_NAME_PATTERN, KUBERNETES_NAMESPACE_PATTERN } from "./types";

/**
 * Read-only Kubernetes tool surface.
 *
 * All four tools are `read_only` and execute server-side in the worker, never
 * in the sandbox. Inputs are strict: an unknown key (for example
 * `follow=true`), an uppercase or path-like name, a foreign namespace or an
 * out-of-range tail is rejected before any API call. Results are composed from
 * allowlisted fields, redacted, hashed and capped exactly like context items;
 * they are untrusted data, never instructions.
 *
 * Destructive/sensitive actions are deliberately absent from this module:
 * `k8s.delete`, `k8s.scale`, `k8s.exec`, `k8s.rollout_restart` and
 * `k8s.apply` have no implementation here and cannot be enabled by a table
 * entry. `createRiskTablePolicy` denies `destructive` outright; a future write
 * surface needs its own approval-bound module.
 */

export const KUBERNETES_READ_TOOLS = [
	"k8s.list_events",
	"k8s.get_pod",
	"k8s.get_deployment",
	"k8s.logs_tail",
] as const;
export type KubernetesToolName = (typeof KUBERNETES_READ_TOOLS)[number];

export const KUBERNETES_READ_TOOL_RISK = "read_only" as const;
export type KubernetesReadToolRisk = typeof KUBERNETES_READ_TOOL_RISK;

/** Documented bands for actions that are intentionally not implemented. */
export const KUBERNETES_OUT_OF_SCOPE_TOOLS = [
	{
		name: "k8s.rollout_restart",
		risk: "sensitive",
		reason: "Deployment mutation; approval bound to namespace/name.",
	},
	{
		name: "k8s.rollback",
		risk: "sensitive",
		reason: "Revision mutation; approval bound to the exact revision.",
	},
	{
		name: "k8s.apply",
		risk: "sensitive",
		reason: "Manifest write; needs a separate write credential and review.",
	},
	{
		name: "k8s.scale",
		risk: "sensitive",
		reason: "Replica mutation; approval bound to namespace/name/replicas.",
	},
	{
		name: "k8s.exec",
		risk: "destructive",
		reason: "Arbitrary command execution inside a container; never a tool.",
	},
	{
		name: "k8s.delete",
		risk: "destructive",
		reason: "Workload deletion; human approval even for cluster admins.",
	},
] as const;

export type KubernetesOutOfScopeTool =
	(typeof KUBERNETES_OUT_OF_SCOPE_TOOLS)[number];

const namespaceSchema = z
	.string()
	.min(1)
	.max(63)
	.regex(KUBERNETES_NAMESPACE_PATTERN);
const resourceNameSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(KUBERNETES_NAME_PATTERN);
const containerNameSchema = z
	.string()
	.min(1)
	.max(63)
	.regex(KUBERNETES_NAMESPACE_PATTERN);

export const k8sListEventsInputSchema = z.strictObject({
	namespace: namespaceSchema,
	/** Involved object name (pod or Deployment), never a selector or URL. */
	name: resourceNameSchema,
	limit: z.number().int().min(1).max(50).optional(),
});

export const k8sGetPodInputSchema = z.strictObject({
	namespace: namespaceSchema,
	name: resourceNameSchema,
});

export const k8sGetDeploymentInputSchema = z.strictObject({
	namespace: namespaceSchema,
	name: resourceNameSchema,
});

export const k8sLogsTailInputSchema = z.strictObject({
	namespace: namespaceSchema,
	podName: resourceNameSchema,
	container: containerNameSchema.optional(),
	/** Hard maximum from docs §5; `follow` is not a field, so it is rejected. */
	tailLines: z
		.number()
		.int()
		.min(1)
		.max(KUBERNETES_CONTEXT_LOG_TAIL_LINES)
		.optional(),
	sinceSeconds: z.number().int().min(60).max(3600).optional(),
});

export type KubernetesToolDefinition = {
	readonly name: KubernetesToolName;
	readonly risk: KubernetesReadToolRisk;
	readonly description: string;
	readonly inputSchema: z.ZodType<unknown>;
	execute(args: unknown): Promise<Record<string, unknown>>;
};

function parseToolInput<T>(schema: z.ZodType<T>, args: unknown): T {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		// Never echo argument values: they may contain a name the caller mistyped.
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes tool arguments are invalid",
		);
	}
	return parsed.data;
}

function resultRecord(result: {
	items: readonly unknown[];
	truncated: boolean;
}): Record<string, unknown> {
	return {
		items: result.items,
		truncated: result.truncated,
		trustLevel: "untrusted",
	};
}

/**
 * Builds the four read-only descriptors. `dependencies.namespace` is the
 * single allowlist; a call naming any other namespace fails `NOT_FOUND`
 * without an API request.
 */
export function createKubernetesReadTools(
	dependencies: KubernetesContextDependencies,
): readonly KubernetesToolDefinition[] {
	const toolOptions = { core: true, failOnMissing: true } as const;
	return [
		{
			name: "k8s.list_events",
			risk: KUBERNETES_READ_TOOL_RISK,
			description:
				"Read-only: up to 50 Warning events for one object in the allowlisted namespace. No all-namespace or cluster-wide reads.",
			inputSchema: k8sListEventsInputSchema,
			execute: async (args) => {
				const input = parseToolInput(k8sListEventsInputSchema, args);
				const result = await readKubernetesWarningEvents(
					dependencies,
					{
						namespace: input.namespace,
						objectName: input.name,
						...(input.limit === undefined ? {} : { limit: input.limit }),
					},
					toolOptions,
				);
				return resultRecord(result);
			},
		},
		{
			name: "k8s.get_pod",
			risk: KUBERNETES_READ_TOOL_RISK,
			description:
				"Read-only: pod phase, conditions, container states, restart counts and last termination. No spec dump, IPs or node names.",
			inputSchema: k8sGetPodInputSchema,
			execute: async (args) => {
				const input = parseToolInput(k8sGetPodInputSchema, args);
				const result = await readKubernetesPod(
					dependencies,
					{ namespace: input.namespace, name: input.name },
					toolOptions,
				);
				return resultRecord(result);
			},
		},
		{
			name: "k8s.get_deployment",
			risk: KUBERNETES_READ_TOOL_RISK,
			description:
				"Read-only: desired/ready/available replicas and rollout conditions for one Deployment.",
			inputSchema: k8sGetDeploymentInputSchema,
			execute: async (args) => {
				const input = parseToolInput(k8sGetDeploymentInputSchema, args);
				const result = await readKubernetesDeployment(
					dependencies,
					{ namespace: input.namespace, name: input.name },
					toolOptions,
				);
				return resultRecord(result);
			},
		},
		{
			name: "k8s.logs_tail",
			risk: KUBERNETES_READ_TOOL_RISK,
			description:
				"Read-only: last <=200 lines / <=2,000 chars of one container's logs, redacted. No follow, no full logs.",
			inputSchema: k8sLogsTailInputSchema,
			execute: async (args) => {
				const input = parseToolInput(k8sLogsTailInputSchema, args);
				const result = await readKubernetesLogTail(
					dependencies,
					{
						namespace: input.namespace,
						podName: input.podName,
						...(input.container === undefined
							? {}
							: { container: input.container }),
						...(input.tailLines === undefined
							? {}
							: { tailLines: input.tailLines }),
						...(input.sinceSeconds === undefined
							? {}
							: { sinceSeconds: input.sinceSeconds }),
					},
					toolOptions,
				);
				return resultRecord(result);
			},
		},
	];
}
