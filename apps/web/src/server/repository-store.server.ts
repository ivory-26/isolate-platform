import "@tanstack/react-start/server-only";
import {
	type ApprovalRepository,
	isLifecycleError,
	type QueueRepository,
	type TaskRepository,
	type TaskRetryFailureCode,
	type TaskRow,
} from "@isolate/db";
import {
	type ApprovalId,
	asApprovalId,
	asTaskId,
	asWorkflowDefinitionId,
	type ExecutionLifecycle,
	type TaskId,
	WORKER_CONFIG_DEFAULTS,
} from "@isolate/shared";
import {
	type ApprovalDecisionReceipt,
	approvalActionCreatePullRequest,
	approvalActionPushBranch,
	decisionMessages,
	type RetryReceipt,
	type SubmissionReceipt,
	submissionCompilationSchema,
	type TaskSummary,
	taskSummarySchema,
	type ValidatedApprovalDecision,
	type ValidatedRetry,
} from "../features/tasks/contracts";
import type { CompileSubmission } from "./submission-compilation.server";
import {
	type CallerScope,
	ControlPlaneError,
	type TaskStore,
} from "./task-service.server";
import type {
	WorkflowCompilationErrorCode,
	WorkflowCompilationResult,
} from "./workflow-compilation.server";

/** Idempotent replays must match the original payload exactly, including lists. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

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

/**
 * Storage seams the two decision actions need. Both the repository-backed
 * store and the Postgres store call the SAME exported helpers below, so the
 * follow-up job type, the events and the failure mapping cannot drift.
 */
export type StoreActionDependencies = {
	tasks: TaskRepository;
	queue: QueueRepository;
	approvals: ApprovalRepository;
	lifecycle: ExecutionLifecycle;
	/** Clock seam; production uses wall clock, tests may advance a fake. */
	now?: () => Date;
};

/** Retry refusals: never reveal a foreign/absent source, never echo the row. */
export function retryFailure(code: TaskRetryFailureCode): ControlPlaneError {
	switch (code) {
		case "NOT_FOUND":
			return new ControlPlaneError("FORBIDDEN");
		case "CONFLICT":
			return new ControlPlaneError(
				"CONFLICT",
				undefined,
				decisionMessages.retryNotFailed,
			);
		case "POLICY_DENIED":
			return new ControlPlaneError(
				"CONFLICT",
				undefined,
				decisionMessages.retryDepthExhausted,
			);
	}
}

type ApprovalFollowUp = {
	readonly type: "resume_task" | "create_pull_request";
	readonly payload: Record<string, unknown>;
	readonly idempotencyKey: string;
};

/**
 * The approval action decides the follow-up job, never the caller. An unknown
 * action has no server-side effect and is refused before the decision lands.
 */
export function approvalFollowUp(
	action: string,
	taskId: TaskId,
	approvalId: ApprovalId,
): ApprovalFollowUp | null {
	if (action === approvalActionPushBranch) {
		return {
			type: "resume_task",
			payload: { taskId, approvalId, action },
			idempotencyKey: `resume_task:${taskId}:${approvalId}`,
		};
	}
	if (action === approvalActionCreatePullRequest) {
		return {
			type: "create_pull_request",
			payload: { taskId, approvalId },
			idempotencyKey: `create_pull_request:${taskId}:${approvalId}`,
		};
	}
	return null;
}

function actionFailure(error: unknown): unknown {
	if (!isLifecycleError(error)) return error;
	switch (error.code) {
		case "NOT_FOUND":
			return new ControlPlaneError("FORBIDDEN");
		case "CONFLICT":
		case "INVALID_TRANSITION":
			return new ControlPlaneError(
				"CONFLICT",
				undefined,
				decisionMessages.approvalTransitionFailed,
			);
		default:
			return new ControlPlaneError("UNAVAILABLE");
	}
}

/**
 * Creates the rerun task (a NEW row; `failed` stays terminal), records the
 * link on the source, enqueues exactly one `run_task` job and records it on
 * the new task. The repository is called with the source id + bounded key
 * only: the boundary (repository, goal, acceptance, ownership, budget) is
 * copied server-side, never accepted from the caller.
 */
export async function retryTaskWithDependencies(
	deps: StoreActionDependencies,
	scope: CallerScope,
	input: ValidatedRetry,
): Promise<RetryReceipt> {
	const result = await deps.tasks.createRetry({
		organizationId: scope.organizationId,
		failedTaskId: asTaskId(input.failedTaskId),
		idempotencyKey: input.idempotencyKey,
	});
	if (!result.ok) throw retryFailure(result.code);
	const task = result.task;
	// Defense in depth: a driver row outside the caller's tenant or not linked
	// to the requested source is treated as absent.
	if (
		task.organization_id !== scope.organizationId ||
		`${task.retry_of}` !== input.failedTaskId
	)
		throw new ControlPlaneError("FORBIDDEN");
	if (!result.created) {
		// Replay of the same request key: same task, no new event and no new job.
		return { taskId: task.id, branch: task.branch, created: false };
	}
	await deps.lifecycle.event({
		organizationId: scope.organizationId,
		taskId: asTaskId(input.failedTaskId),
		workflowRunId: null,
		type: "task.retried",
		actor: "user",
		data: { retryTaskId: task.id, retryDepth: task.retry_depth },
	});
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
	await deps.lifecycle.event({
		organizationId: scope.organizationId,
		taskId: task.id,
		workflowRunId: null,
		type: "task.enqueued",
		actor: "user",
		data: { jobId: job.id, jobType: "run_task" },
	});
	return { taskId: task.id, branch: task.branch, created: true };
}

/**
 * Reads the approval tenant-scoped, refuses anything but a pending, unexpired
 * row with a known follow-up action, then decides through the repository
 * (which re-checks pending + expiry and writes the audit row). Approval
 * enqueues exactly one follow-up job; rejection fails the task instead.
 */
export async function decideApprovalWithDependencies(
	deps: StoreActionDependencies,
	scope: CallerScope,
	input: ValidatedApprovalDecision,
): Promise<ApprovalDecisionReceipt> {
	const taskId = asTaskId(input.taskId);
	const approvalId = asApprovalId(input.approvalId);
	const approvals = await deps.approvals.listByTask({
		organizationId: scope.organizationId,
		taskId,
		limit: 500,
	});
	const approval = approvals.find((row) => row.id === approvalId);
	// Absent, foreign or otherwise unreadable: one indistinguishable refusal.
	if (
		approval === undefined ||
		approval.organization_id !== scope.organizationId ||
		approval.task_id !== taskId
	)
		throw new ControlPlaneError("FORBIDDEN");
	const now = (deps.now ?? (() => new Date()))().getTime();
	if (approval.status !== "pending" || approval.expires_at.getTime() <= now)
		throw new ControlPlaneError(
			"CONFLICT",
			undefined,
			decisionMessages.approvalNotPending,
		);
	const followUp =
		input.decision === "approved"
			? approvalFollowUp(approval.action, taskId, approvalId)
			: null;
	if (input.decision === "approved" && followUp === null)
		throw new ControlPlaneError(
			"CONFLICT",
			undefined,
			decisionMessages.approvalActionUnsupported,
		);
	const decided = await deps.approvals.decide({
		organizationId: scope.organizationId,
		taskId,
		approvalId,
		expectedStatus: "pending",
		decision: input.decision,
		decidedBy: scope.userId,
	});
	if (!decided.ok) {
		if (decided.code === "NOT_FOUND") throw new ControlPlaneError("FORBIDDEN");
		throw new ControlPlaneError(
			"CONFLICT",
			undefined,
			decisionMessages.approvalNotPending,
		);
	}
	if (
		decided.approval.organization_id !== scope.organizationId ||
		decided.approval.task_id !== taskId
	)
		throw new ControlPlaneError("FORBIDDEN");
	await deps.lifecycle.event({
		organizationId: scope.organizationId,
		taskId,
		workflowRunId: approval.workflow_run_id,
		type: "approval.decided",
		actor: "user",
		data: {
			approvalId,
			action: approval.action,
			decision: input.decision,
		},
	});
	if (input.decision === "rejected") {
		try {
			await deps.lifecycle.transition({
				organizationId: scope.organizationId,
				taskId,
				from: "awaiting_approval",
				to: "failed",
				actor: "user",
				reason: "approval rejected",
			});
		} catch (error) {
			throw actionFailure(error);
		}
		return { taskId, approvalId, decision: "rejected", jobId: null };
	}
	if (followUp === null) throw new ControlPlaneError("UNAVAILABLE");
	const job = await deps.queue.enqueue({
		organizationId: scope.organizationId,
		taskId,
		type: followUp.type,
		payload: followUp.payload,
		idempotencyKey: followUp.idempotencyKey,
		maxAttempts: WORKER_CONFIG_DEFAULTS.maxJobAttempts,
	});
	if (
		job.organizationId !== scope.organizationId ||
		job.taskId !== taskId ||
		job.type !== followUp.type
	)
		throw new ControlPlaneError("FORBIDDEN");
	return { taskId, approvalId, decision: "approved", jobId: job.id };
}

export function createRepositoryStore(
	deps: StoreActionDependencies & {
		repositoryBelongsToOrganization: (
			organizationId: string,
			repositoryId: string,
		) => Promise<boolean>;
		listLatest: TaskStore["listLatest"];
		compileSubmission: CompileSubmission;
	},
): TaskStore {
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
			const goal = input.goal ?? "";
			const acceptanceCriteria = input.acceptanceCriteria ?? [];
			const fileOwnership = input.fileOwnership ?? [];
			const task = await deps.tasks.create({
				organizationId: scope.organizationId,
				repositoryId: input.repositoryId,
				branch: input.branch,
				idempotencyKey: input.idempotencyKey,
				budgetLimits,
				goal,
				acceptanceCriteria,
				fileOwnership,
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
				task.budget_limits.max_duration_ms !== budgetLimits.maxDurationMs ||
				task.goal !== goal ||
				!sameList(task.acceptance_criteria, acceptanceCriteria) ||
				!sameList(task.file_ownership, fileOwnership)
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
		retry: (scope, input) => retryTaskWithDependencies(deps, scope, input),
		decideApproval: (scope, input) =>
			decideApprovalWithDependencies(deps, scope, input),
	};
}
