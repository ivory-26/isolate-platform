import {
	acceptanceCheckSchema,
	taskStatusSchema,
	workerConfigSchema,
} from "@isolate/shared";
import { z } from "zod";

/** PostgreSQL integer bound used by the compiler/persistence contracts. */
export const workflowVersionSchema = z.number().int().min(1).max(2147483647);
/**
 * Machine-checkable criteria bound. Mirrors `MAX_ACCEPTANCE_CHECKS` in
 * `@isolate/db` (which also enforces the 0007 jsonb CHECK). The value is
 * restated here because this module is reachable from the client bundle and
 * must not import the database package; both sides enforce the same cap.
 */
export const MAX_SUBMITTED_ACCEPTANCE_CHECKS = 32;
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
	/** Authored task intent; the worker receives exactly this text. */
	goal: z.string().trim().min(1).max(4000),
	/** What "done" means; persisted with the task for the agent context. */
	acceptanceCriteria: z
		.array(z.string().trim().min(1).max(500))
		.max(20)
		.default([]),
	/**
	 * Machine-checkable completion criteria (wave 9). Each entry is a strict,
	 * path-confined check validated by the shared schema; the list is bounded
	 * and never accepted as free-form shell text.
	 */
	acceptanceChecks: z
		.array(acceptanceCheckSchema)
		.max(MAX_SUBMITTED_ACCEPTANCE_CHECKS)
		.default([]),
	/** Paths the agent may modify; everything else stays out of bounds. */
	fileOwnership: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
	// Compile-at-submit: the caller pins one immutable authored version.
	workflowDefinitionId: z.uuid(),
	workflowVersion: workflowVersionSchema,
	budget: workerConfigSchema.pick({
		maxAgentTurns: true,
		repairBudget: true,
		jobTimeoutMs: true,
	}),
});
/**
 * Incident provenance (wave 13). Server-internal only: the intake sets both
 * fields after normalizing a verified delivery. They are deliberately absent
 * from `submitTaskSchema`, so the browser-facing validators (`submitTask` server
 * function, task form) reject a client that tries to claim to be an incident
 * (which would consume the per-organization cap).
 */
const incidentProvenanceShape = {
	incidentSource: z.string().trim().min(1).max(32).optional(),
	incidentFingerprint: z.string().trim().min(1).max(128).optional(),
};
function hasPairedProvenance(value: {
	incidentSource?: string;
	incidentFingerprint?: string;
}): boolean {
	return (
		(value.incidentSource === undefined) ===
		(value.incidentFingerprint === undefined)
	);
}
export const incidentProvenanceSchema = z
	.strictObject(incidentProvenanceShape)
	.refine(hasPairedProvenance, {
		message: "incidentSource and incidentFingerprint must be provided together",
	});
export type IncidentProvenance = z.output<typeof incidentProvenanceSchema>;
/** The ordinary submission plus optional provenance, used server-side only. */
export const incidentSubmissionSchema = z
	.strictObject({
		...submitTaskSchema.shape,
		...incidentProvenanceShape,
	})
	.refine(hasPairedProvenance, {
		message: "incidentSource and incidentFingerprint must be provided together",
	});
export const listTasksSchema = z.strictObject({
	limit: z.number().int().min(1).max(100).default(25),
});
/**
 * A rerun is a NEW task in the same boundary. The caller supplies a bounded
 * request key; the retry is derived from it + the source id, so a replay
 * returns the same task instead of a second one.
 */
export const retryTaskSchema = z.strictObject({
	failedTaskId: z.uuid(),
	idempotencyKey: z.string().trim().min(1).max(200),
});
export const decideApprovalSchema = z.strictObject({
	taskId: z.uuid(),
	approvalId: z.uuid(),
	decision: z.enum(["approved", "rejected"]),
});
/** Approval actions with a server-side follow-up job (wave 8 vocabulary). */
export const approvalActionPushBranch = "git.push_branch";
export const approvalActionCreatePullRequest = "github.create_pull_request";
/**
 * Bounded operator-facing messages for the decision actions. They never echo
 * an approval payload, a branch, a repository or a driver error.
 */
export const decisionMessages = {
	retryNotFailed: "Only a task that failed can be rerun.",
	retryDepthExhausted:
		"This task has reached the maximum retry depth (3). Start a new task instead.",
	approvalNotPending: "This approval has already been decided or has expired.",
	approvalActionUnsupported:
		"This approval action has no server-side follow-up.",
	approvalTransitionFailed:
		"This approval can no longer change the task state.",
} as const;
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
/**
 * A validated submission. Incident provenance is optional and is only ever set
 * by the server-side incident intake; the browser-facing schema stays strict
 * and unknown keys are rejected before reaching the service.
 */
export type ValidatedSubmission = z.output<typeof incidentSubmissionSchema>;
export type RetryTaskInput = z.input<typeof retryTaskSchema>;
export type ValidatedRetry = z.output<typeof retryTaskSchema>;
export type DecideApprovalInput = z.input<typeof decideApprovalSchema>;
export type ValidatedApprovalDecision = z.output<typeof decideApprovalSchema>;
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
/** A rerun is a new task; `created: false` means the same request key replayed. */
export type RetryReceipt = {
	taskId: string;
	branch: string;
	created: boolean;
};
/** `jobId` is null only for a rejection, which fails the task instead. */
export type ApprovalDecisionReceipt = {
	taskId: string;
	approvalId: string;
	decision: "approved" | "rejected";
	jobId: string | null;
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
