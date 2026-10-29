import "@tanstack/react-start/server-only";
import type { WorkflowDefinitionId } from "@isolate/shared";
import { WORKER_CONFIG_DEFAULTS } from "@isolate/shared";
import { z } from "zod";
import type { CallerScope } from "./task-service.server";
import {
	createWorkflowCompilationService,
	type WorkflowCompilationPolicy,
	type WorkflowCompilationRepositories,
	type WorkflowCompilationResult,
} from "./workflow-compilation.server";

export type SubmissionPin = {
	workflowDefinitionId: WorkflowDefinitionId;
	workflowVersion: number;
};
export type CompileSubmission = (
	scope: CallerScope,
	pin: SubmissionPin,
) => Promise<WorkflowCompilationResult>;

/**
 * Conservative server-side compilation policy. Tool nodes are denied unless a
 * future wave adds an explicit, trusted allowlist; loop attempts are bounded by
 * the worker's agent-turn ceiling.
 */
export const SUBMISSION_COMPILATION_POLICY: WorkflowCompilationPolicy = {
	toolAllowlist: [],
	taskBudget: WORKER_CONFIG_DEFAULTS.maxAgentTurns,
};

function reusablePlanId(
	plan: Awaited<
		ReturnType<WorkflowCompilationRepositories["compiledPlans"]["get"]>
	>,
	scope: CallerScope,
	pin: SubmissionPin,
): string | null {
	if (!plan) return null;
	if (
		plan.organization_id !== scope.organizationId ||
		plan.workflow_definition_id !== pin.workflowDefinitionId ||
		plan.workflow_version !== pin.workflowVersion ||
		plan.plan.workflowId !== pin.workflowDefinitionId ||
		plan.plan.versionPinned !== pin.workflowVersion ||
		!z.uuid().safeParse(plan.id).success
	)
		return null;
	return plan.id;
}

/**
 * Adapts `createWorkflowCompilationService` to the submit pipeline. The caller
 * scope has already passed `resolveCallerScope`, so the service's own scope and
 * membership gates are satisfied by the same trusted values.
 *
 * Compiled plans are immutable per (org, definition, version), so an existing
 * plan is reused instead of resubmitting it to the insert-only save. This keeps
 * idempotent retries and multiple tasks on one pinned version working while the
 * service still owns all compilation and persistence. A conflict that leaves no
 * retrievable plan is propagated and surfaces as CONFLICT.
 */
export function createSubmissionCompiler(deps: {
	getRepositories(scope: CallerScope): Promise<WorkflowCompilationRepositories>;
	policy?: WorkflowCompilationPolicy;
}): CompileSubmission {
	const policy = deps.policy ?? SUBMISSION_COMPILATION_POLICY;
	return async (scope, pin) => {
		const repositories = await deps.getRepositories(scope);
		const compiledPin = {
			organizationId: scope.organizationId,
			workflowDefinitionId: pin.workflowDefinitionId,
			workflowVersion: pin.workflowVersion,
		};
		async function reusable(): Promise<string | null> {
			try {
				return reusablePlanId(
					await repositories.compiledPlans.get(
						scope.organizationId,
						pin.workflowDefinitionId,
						pin.workflowVersion,
					),
					scope,
					pin,
				);
			} catch {
				// A failed read falls through to the compiler, which reports a
				// bounded storage failure instead of inventing a plan.
				return null;
			}
		}
		const existing = await reusable();
		if (existing !== null)
			return {
				outcome: "compiled",
				pin: compiledPin,
				compiledPlanId: existing,
			};
		const service = createWorkflowCompilationService({
			resolveScope: async () => scope,
			// resolveCallerScope proved an active membership for this scope.
			authorizeMembership: async () => true,
			resolvePolicy: async () => policy,
			getRepositories: async () => repositories,
		});
		const result = await service.compileAndPersist({
			workflowDefinitionId: pin.workflowDefinitionId,
			workflowVersion: pin.workflowVersion,
		});
		if (result.outcome === "conflict") {
			// A concurrent submit may have saved the same immutable plan between
			// our read and save; reuse it when it is retrievable.
			const raced = await reusable();
			if (raced !== null)
				return { outcome: "compiled", pin: compiledPin, compiledPlanId: raced };
		}
		return result;
	};
}
