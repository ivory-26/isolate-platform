import "@tanstack/react-start/server-only";
import type {
	CompiledPlanRepository,
	WorkflowRejectionIssue,
	WorkflowRejectionRepository,
	WorkflowVersionPin,
	WorkflowVersionRow,
} from "@isolate/db";
import {
	asOrganizationId,
	asUserId,
	asWorkflowDefinitionId,
	type OrganizationId,
	type WorkflowDefinitionId,
} from "@isolate/shared";
import { compileWorkflow } from "@isolate/workflow-schema";
import { z } from "zod";
import type { CallerScope } from "./task-service.server";
import {
	compilationPolicySchema,
	compileVersionRequestSchema,
	readGuardedGraph,
	safeCompilationIssue,
	sanitizeCompilationIssues,
} from "./workflow-compilation-guard.server";

/** W4-D supplies this org-scoped reader; no concrete DB/runtime auth is wired here. */
export interface AuthoredWorkflowVersionReader {
	getAuthoredVersion(
		organizationId: OrganizationId,
		definitionId: WorkflowDefinitionId,
		version: number,
	): Promise<WorkflowVersionRow | null>;
}
export interface WorkflowCompilationRepositories {
	authoredVersions: AuthoredWorkflowVersionReader;
	compiledPlans: CompiledPlanRepository;
	rejections: WorkflowRejectionRepository;
}
export type WorkflowCompilationPolicy = {
	toolAllowlist: readonly string[];
	taskBudget: number;
};
export interface WorkflowCompilationDependencies {
	resolveScope(): Promise<CallerScope | null>;
	/** Must authorize active organization membership and compilation permission. */
	authorizeMembership(scope: CallerScope): Promise<boolean>;
	/** Null denies access; policy can only come from trusted server configuration. */
	resolvePolicy(
		scope: CallerScope,
		pin: WorkflowVersionPin,
	): Promise<WorkflowCompilationPolicy | null>;
	/** Lazy: never called until scope, membership and policy pass. */
	getRepositories(scope: CallerScope): Promise<WorkflowCompilationRepositories>;
}
const errorMessages = {
	INVALID_INPUT:
		"Provide a definition UUID and positive PostgreSQL-integer version only.",
	AUTH_REQUIRED:
		"Trusted authenticated scope is required to compile workflows.",
	FORBIDDEN: "Workflow compilation is not permitted for this organization.",
	POLICY_UNAVAILABLE: "Workflow compilation policy is unavailable.",
	NOT_FOUND:
		"The authored workflow version was not found in this organization.",
	STORAGE_FAILURE:
		"Workflow compilation could not be persisted. Check storage before retrying.",
	COMPILATION_FAILED: "Workflow compilation could not be completed.",
} as const;
export type WorkflowCompilationErrorCode = keyof typeof errorMessages;
export type WorkflowCompilationResult =
	| { outcome: "compiled"; pin: WorkflowVersionPin; compiledPlanId: string }
	| {
			outcome: "rejected";
			pin: WorkflowVersionPin;
			rejectionId: string;
			issues: WorkflowRejectionIssue[];
	  }
	| { outcome: "conflict"; pin: WorkflowVersionPin }
	| {
			outcome: "error";
			error: { code: WorkflowCompilationErrorCode; message: string };
	  };
function failure(
	code: WorkflowCompilationErrorCode,
): WorkflowCompilationResult {
	return { outcome: "error", error: { code, message: errorMessages[code] } };
}
const scopeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
});
function matchesPersistedPin(
	row: {
		id: string;
		organization_id: OrganizationId;
		workflow_definition_id: WorkflowDefinitionId;
		workflow_version: number;
	},
	pin: WorkflowVersionPin,
): boolean {
	return (
		z.uuid().safeParse(row.id).success &&
		row.organization_id === pin.organizationId &&
		row.workflow_definition_id === pin.workflowDefinitionId &&
		row.workflow_version === pin.workflowVersion
	);
}

export function createWorkflowCompilationService(
	deps: WorkflowCompilationDependencies,
) {
	return {
		async compileAndPersist(
			input: unknown,
		): Promise<WorkflowCompilationResult> {
			let request: ReturnType<typeof compileVersionRequestSchema.safeParse>;
			try {
				request = compileVersionRequestSchema.safeParse(input);
			} catch {
				return failure("INVALID_INPUT");
			}
			if (!request.success) return failure("INVALID_INPUT");
			let scope: CallerScope;
			try {
				const resolved = scopeSchema.safeParse(await deps.resolveScope());
				if (!resolved.success) return failure("AUTH_REQUIRED");
				scope = {
					organizationId: asOrganizationId(
						resolved.data.organizationId.toLowerCase(),
					),
					userId: asUserId(resolved.data.userId.toLowerCase()),
				};
			} catch {
				return failure("AUTH_REQUIRED");
			}
			try {
				if ((await deps.authorizeMembership(scope)) !== true)
					return failure("FORBIDDEN");
			} catch {
				return failure("FORBIDDEN");
			}
			const pin: WorkflowVersionPin = {
				organizationId: scope.organizationId,
				workflowDefinitionId: asWorkflowDefinitionId(
					request.data.workflowDefinitionId,
				),
				workflowVersion: request.data.workflowVersion,
			};
			let policy: ReturnType<typeof compilationPolicySchema.safeParse>;
			try {
				const resolved = await deps.resolvePolicy(scope, pin);
				if (resolved === null) return failure("FORBIDDEN");
				policy = compilationPolicySchema.safeParse(resolved);
				if (!policy.success) return failure("POLICY_UNAVAILABLE");
			} catch {
				return failure("POLICY_UNAVAILABLE");
			}
			try {
				const repositories = await deps.getRepositories(scope);
				const authored = await repositories.authoredVersions.getAuthoredVersion(
					pin.organizationId,
					pin.workflowDefinitionId,
					pin.workflowVersion,
				);
				// A bad/mis-scoped reader must not redirect compilation to another pin.
				if (
					!authored ||
					authored.definition_id !== pin.workflowDefinitionId ||
					authored.version !== pin.workflowVersion
				)
					return failure("NOT_FOUND");
				async function reject(
					issues: WorkflowRejectionIssue[],
				): Promise<WorkflowCompilationResult> {
					const saved = await repositories.rejections.record({
						...pin,
						issues,
					});
					if (!saved.ok) return failure("NOT_FOUND");
					if (!matchesPersistedPin(saved.rejection, pin))
						return failure("STORAGE_FAILURE");
					return {
						outcome: "rejected",
						pin,
						rejectionId: saved.rejection.id,
						issues,
					};
				}
				const graph = readGuardedGraph(authored.graph);
				if (!graph)
					return await reject([safeCompilationIssue("MALFORMED_GRAPH")]);
				if (
					graph.id !== authored.definition_id ||
					graph.version !== authored.version
				)
					return await reject([safeCompilationIssue("PIN_MISMATCH")]);
				let compilation: ReturnType<typeof compileWorkflow>;
				try {
					compilation = compileWorkflow(graph, {
						expectedVersion: authored.version,
						toolAllowlist: policy.data.toolAllowlist,
						taskBudget: policy.data.taskBudget,
					});
				} catch {
					return failure("COMPILATION_FAILED");
				}
				if (!compilation.ok)
					return await reject(sanitizeCompilationIssues(compilation.error));
				if (
					compilation.value.workflowId !== pin.workflowDefinitionId ||
					compilation.value.versionPinned !== pin.workflowVersion
				)
					return failure("COMPILATION_FAILED");
				const saved = await repositories.compiledPlans.save({
					...pin,
					plan: compilation.value,
				});
				if (!saved.ok)
					return saved.code === "CONFLICT"
						? { outcome: "conflict", pin }
						: failure("NOT_FOUND");
				if (!matchesPersistedPin(saved.plan, pin))
					return failure("STORAGE_FAILURE");
				return { outcome: "compiled", pin, compiledPlanId: saved.plan.id };
			} catch {
				return failure("STORAGE_FAILURE");
			}
		},
	};
}
