import { taskStatusSchema, workerConfigSchema } from "@isolate/shared";
import { z } from "zod";

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
export type SubmitTaskInput = z.input<typeof submitTaskSchema>;
export type ValidatedSubmission = z.output<typeof submitTaskSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type FailureCode =
	| "INVALID_INPUT"
	| "AUTH_REQUIRED"
	| "FORBIDDEN"
	| "CONFLICT"
	| "UNAVAILABLE";
export type ServiceResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: FailureCode; message: string } };
export type SubmissionReceipt = { task: TaskSummary; jobId: string };
export const failureMessages: Record<FailureCode, string> = {
	INVALID_INPUT: "Check the request fields and execution budget.",
	AUTH_REQUIRED:
		"Task access is disabled until trusted authentication is configured. Local demo requires explicit development/test mode.",
	FORBIDDEN: "The repository is not available in this organization.",
	CONFLICT:
		"This request key was already used for a different task. Start a new request.",
	UNAVAILABLE:
		"Task storage is unavailable. Retry with the same request key; do not create a new one.",
};
