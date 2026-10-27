/**
 * Branded identifier types.
 *
 * Every platform entity has a stable, string-backed id. Brands keep distinct
 * id types interchangeable at runtime but not in type space.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type OrganizationId = Brand<string, "OrganizationId">;
export type UserId = Brand<string, "UserId">;
export type RepositoryId = Brand<string, "RepositoryId">;
export type IntegrationId = Brand<string, "IntegrationId">;
export type WorkflowDefinitionId = Brand<string, "WorkflowDefinitionId">;
export type WorkflowVersionId = Brand<string, "WorkflowVersionId">;
export type TaskId = Brand<string, "TaskId">;
export type TaskAttemptId = Brand<string, "TaskAttemptId">;
export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type JobId = Brand<string, "JobId">;

/** Generates a prefixed UUID id, e.g. `task_9f1c…`. */
export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export function asOrganizationId(value: string): OrganizationId {
	return value as OrganizationId;
}
export function asUserId(value: string): UserId {
	return value as UserId;
}
export function asRepositoryId(value: string): RepositoryId {
	return value as RepositoryId;
}
export function asWorkflowDefinitionId(value: string): WorkflowDefinitionId {
	return value as WorkflowDefinitionId;
}
export function asWorkflowVersionId(value: string): WorkflowVersionId {
	return value as WorkflowVersionId;
}
export function asTaskId(value: string): TaskId {
	return value as TaskId;
}
export function asTaskAttemptId(value: string): TaskAttemptId {
	return value as TaskAttemptId;
}
export function asWorkflowRunId(value: string): WorkflowRunId {
	return value as WorkflowRunId;
}
export function asApprovalId(value: string): ApprovalId {
	return value as ApprovalId;
}
export function asJobId(value: string): JobId {
	return value as JobId;
}
