import "@tanstack/react-start/server-only";
import type { QueueRepository, TaskRepository, TaskRow } from "@isolate/db";
import {
	asWorkflowDefinitionId,
	WORKER_CONFIG_DEFAULTS,
} from "@isolate/shared";
import {
	type SubmissionReceipt,
	submissionCompilationSchema,
	type TaskSummary,
	taskSummarySchema,
} from "../features/tasks/contracts";
import type { CompileSubmission } from "./submission-compilation.server";
import { ControlPlaneError, type TaskStore } from "./task-service.server";
import type {
	WorkflowCompilationErrorCode,
	WorkflowCompilationResult,
} from "./workflow-compilation.server";

export function summarizeTask(task: TaskRow): TaskSummary {
	return taskSummarySchema.parse({
		id: task.id,
		repositoryId: task.repository_id,
		branch: task.branch,
		status: task.status,
		createdAt: task.created_at.toISOString(),
		updatedAt: task.updated_at.toISOString(),
		latestRun: null,
	});
}

/** Bounded mapping from compiler/storage codes; internal messages never escape. */
function compilationFailure(
	code: WorkflowCompilationErrorCode,
): ControlPlaneError {
	switch (code) {
		case "INVALID_INPUT":
			return new ControlPlaneError("INVALID_INPUT");
		case "AUTH_REQUIRED":
			return new ControlPlaneError("AUTH_REQUIRED");
		case "FORBIDDEN":
		case "NOT_FOUND":
			// Do not reveal whether a foreign or absent version exists.
			return new ControlPlaneError("FORBIDDEN");
		default:
			return new ControlPlaneError("UNAVAILABLE");
	}
}
function settleCompilation(result: WorkflowCompilationResult): {
	compiledPlanId: string;
} {
	switch (result.outcome) {
		case "compiled":
			return { compiledPlanId: result.compiledPlanId };
		case "rejected":
			// Sanitized by the compilation boundary; still bounded by the service.
			throw new ControlPlaneError("WORKFLOW_REJECTED", result.issues);
		case "conflict":
			throw new ControlPlaneError("CONFLICT");
		case "error":
			throw compilationFailure(result.error.code);
	}
}

export function createRepositoryStore(deps: {
	tasks: TaskRepository;
	queue: QueueRepository;
	repositoryBelongsToOrganization: (
		organizationId: string,
		repositoryId: string,
	) => Promise<boolean>;
	listLatest: TaskStore["listLatest"];
	compileSubmission: CompileSubmission;
}): TaskStore {
	return {
		async submit(scope, input): Promise<SubmissionReceipt> {
			if (
				!(await deps.repositoryBelongsToOrganization(
					scope.organizationId,
					input.repositoryId,
				))
			)
				throw new ControlPlaneError("FORBIDDEN");
			// W4-C: compile the pinned authored version before any task or job
			// write. A rejected/conflicting compilation stops the pipeline here.
			const compilation = submissionCompilationSchema.parse({
				outcome: "compiled",
				...settleCompilation(
					await deps.compileSubmission(scope, {
						workflowDefinitionId: asWorkflowDefinitionId(
							input.workflowDefinitionId.toLowerCase(),
						),
						workflowVersion: input.workflowVersion,
					}),
				),
			});
			const budgetLimits = {
				maxAgentTurns: input.budget.maxAgentTurns,
				maxRepairAttempts: input.budget.repairBudget,
				maxDurationMs: input.budget.jobTimeoutMs,
			};
			const task = await deps.tasks.create({
				organizationId: scope.organizationId,
				repositoryId: input.repositoryId,
				branch: input.branch,
				idempotencyKey: input.idempotencyKey,
				budgetLimits,
				createdBy: scope.userId,
			});
			// create returns the existing row on races/idempotency hits. Validate
			// ownership and payload equality before enqueueing that row.
			if (task.organization_id !== scope.organizationId)
				throw new ControlPlaneError("FORBIDDEN");
			if (
				task.repository_id !== input.repositoryId ||
				task.branch !== input.branch ||
				task.budget_limits.max_agent_turns !== budgetLimits.maxAgentTurns ||
				task.budget_limits.max_repair_attempts !==
					budgetLimits.maxRepairAttempts ||
				task.budget_limits.max_duration_ms !== budgetLimits.maxDurationMs
			)
				throw new ControlPlaneError("CONFLICT");
			const job = await deps.queue.enqueue({
				organizationId: scope.organizationId,
				taskId: task.id,
				type: "run_task",
				payload: { taskId: task.id },
				idempotencyKey: `run_task:${task.id}`,
				maxAttempts: WORKER_CONFIG_DEFAULTS.maxJobAttempts,
			});
			if (
				job.organizationId !== scope.organizationId ||
				job.taskId !== task.id ||
				job.type !== "run_task"
			)
				throw new ControlPlaneError("FORBIDDEN");
			return {
				task: summarizeTask(task),
				jobId: job.id,
				compilation,
			};
		},
		listLatest: deps.listLatest,
	};
}
