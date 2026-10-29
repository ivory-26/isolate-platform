import { taskStatusSchema, workerConfigSchema } from "@isolate/shared";
import { z } from "zod";

/** PostgreSQL integer bound used by the compiler/persistence contracts. */
export const workflowVersionSchema = z.number().int().min(1).max(2147483647);
export const submitTaskSchema = z.strictObject({
	repositoryId: z.uuid(),
	branch: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/)
		.refine((branch) => !branch.includes("//") && !branch.endsWith("/")),
	idempotencyKey: z.uuid(),
	// Compile-at-submit: the caller pins one immutable authored version.
	workflowDefinitionId: z.uuid(),
	workflowVersion: workflowVersionSchema,
	budget: workerConfigSchema.pick({
		maxAgentTurns: true,
		repairBudget: true,
		jobTimeoutMs: true,
	}),
});
export const listTasksSchema = z.strictObject({
	limit: z.number().int().min(1).max(100).default(25),
});
export const taskSummarySchema = z.strictObject({
	id: z.uuid(),
	repositoryId: z.uuid(),
	branch: z.string(),
	status: taskStatusSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	latestRun: z
		.strictObject({
			id: z.uuid(),
			status: z.enum(["running", "suspended", "succeeded", "failed"]),
			startedAt: z.iso.datetime(),
			finishedAt: z.iso.datetime().nullable(),
		})
		.nullable(),
});
/**
 * Bounded, already-sanitized compiler diagnostics. Messages come from the
 * server-side issue table and never echo authored values.
 */
export const workflowRejectionIssueSchema = z.strictObject({
	code: z.string().min(1).max(64),
	path: z.string().min(1).max(160),
	message: z.string().min(1).max(240),
});
export const workflowRejectionIssuesSchema = z
	.array(workflowRejectionIssueSchema)
	.max(100);
export const submissionCompilationSchema = z.strictObject({
	outcome: z.literal("compiled"),
	compiledPlanId: z.uuid(),
});
export type SubmitTaskInput = z.input<typeof submitTaskSchema>;
export type ValidatedSubmission = z.output<typeof submitTaskSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type WorkflowRejectionIssue = z.infer<
	typeof workflowRejectionIssueSchema
>;
export type SubmissionCompilation = z.infer<typeof submissionCompilationSchema>;
export type FailureCode =
	| "INVALID_INPUT"
	| "AUTH_REQUIRED"
	| "FORBIDDEN"
	| "CONFLICT"
	| "WORKFLOW_REJECTED"
	| "UNAVAILABLE";
export type ServiceError = {
	code: FailureCode;
	message: string;
	/** Present only for WORKFLOW_REJECTED; bounded and sanitized. */
	issues?: WorkflowRejectionIssue[];
};
export type ServiceResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ServiceError };
export type SubmissionReceipt = {
	task: TaskSummary;
	jobId: string;
	compilation: SubmissionCompilation;
};
export const failureMessages: Record<FailureCode, string> = {
	INVALID_INPUT: "Check the request fields and execution budget.",
	AUTH_REQUIRED:
		"Sign in to access this organization. Task access stays disabled until trusted authentication is configured.",
	FORBIDDEN: "This action is not available in your role for this organization.",
	CONFLICT:
		"This request key was already used for a different task, or the pinned workflow version is already compiled. Start a new request or publish a new version.",
	WORKFLOW_REJECTED:
		"The pinned workflow version failed compilation. Review the reported issues and publish a corrected version.",
	UNAVAILABLE:
		"Task storage is unavailable. Retry with the same request key; do not create a new one.",
};
