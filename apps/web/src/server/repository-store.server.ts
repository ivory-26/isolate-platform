import "@tanstack/react-start/server-only";
import type { QueueRepository, TaskRepository, TaskRow } from "@isolate/db";
import { WORKER_CONFIG_DEFAULTS } from "@isolate/shared";
import {
	type TaskSummary,
	taskSummarySchema,
} from "../features/tasks/contracts";
import { ControlPlaneError, type TaskStore } from "./task-service.server";

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
export function createRepositoryStore(deps: {
	tasks: TaskRepository;
	queue: QueueRepository;
	repositoryBelongsToOrganization: (
		organizationId: string,
		repositoryId: string,
	) => Promise<boolean>;
	listLatest: TaskStore["listLatest"];
}): TaskStore {
	return {
		async submit(scope, input) {
			if (
				!(await deps.repositoryBelongsToOrganization(
					scope.organizationId,
					input.repositoryId,
				))
			)
				throw new ControlPlaneError("FORBIDDEN");
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
			return { task: summarizeTask(task), jobId: job.id };
		},
		listLatest: deps.listLatest,
	};
}
