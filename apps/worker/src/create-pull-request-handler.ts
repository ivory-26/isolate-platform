import type {
	CreatePullRequestInput,
	PullRequestCreationResult,
} from "@isolate/integrations";
import { pullRequestApprovalPayloadSha256 } from "@isolate/integrations";
import type {
	ExecutionLifecycle,
	LifecycleTransitionInput,
	Logger,
	OrganizationId,
	TaskId,
	TaskStatus,
} from "@isolate/shared";
import type { HandlerVerdict, JobHandler } from "./contracts";
import { emitMetric, WORKER_METRICS } from "./metrics";
import { readApprovalId, readTaskId } from "./payload";
import {
	PULL_REQUEST_APPROVAL_ACTION,
	type PullRequestTarget,
} from "./pull-request-approval";
import { clampErrorCode, sanitizeMessage } from "./sanitize";

/**
 * `create_pull_request` job handler (wave 8).
 *
 * A second, independent human gate: the task already passed validation and
 * was pushed, then paused at `awaiting_approval` bound to the exact
 * `{repositoryFullName, headBranch, baseBranch, headSha}`. This handler runs
 * only after a human approved that record. Every refusal is bounded and
 * acknowledged as complete (no retry loop); the control plane owns turning a
 * rejection into a failed task.
 *
 * Invariants:
 * - the approval status is `approved` AND its stored payload SHA equals the
 *   SHA of the target the handler is about to use (recomputed here);
 * - a cancelled task never opens a pull request;
 * - redelivery is idempotent: a task that already has a PR number returns the
 *   recorded result without a second GitHub call;
 * - title/body are rebuilt deterministically and carry no secrets; the
 *   approval payload never includes them.
 */

/** Bounded snapshot of the task fields this handler needs. */
export type PullRequestTaskState = {
	readonly status: TaskStatus;
	readonly pullRequestNumber: number | null;
	readonly pullRequestUrl: string | null;
};

/**
 * The PR service seam: `createPullRequestForTask` with the token provider and
 * audit sink already bound. `organizationId` travels separately because the
 * audit entry must name the tenant and the composition is shared across them.
 */
export type CreatePullRequestSeam = (
	input: CreatePullRequestInput & { readonly organizationId: OrganizationId },
) => Promise<PullRequestCreationResult>;

export type PullRequestWorkflowDeps = {
	lifecycle: ExecutionLifecycle;
	loadTaskState(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<PullRequestTaskState | null>;
	loadPullRequestTarget(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
	}): Promise<PullRequestTarget | null>;
	recordPullRequest(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		pullRequestNumber: number;
		pullRequestUrl: string;
	}): Promise<{ readonly ok: boolean }>;
	createPullRequest: CreatePullRequestSeam;
};

const REJECTED_PAYLOAD: HandlerVerdict = {
	outcome: "dead_letter",
	code: "VALIDATION_FAILED",
	note: "job payload rejected by handler",
};

/** Terminal statuses that must never open a pull request. */
const INELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"cancelled",
	"completed",
	"failed",
	"blocked",
]);

/** Statuses from which `pull_request_created` is a legal transition. */
const PR_ELIGIBLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"awaiting_approval",
	"review_ready",
]);

const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 20_000;

function isLifecycleConflict(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "CONFLICT" || code === "DEPENDENCY_CONFLICT";
}

async function transitionLifecycle(
	lifecycle: ExecutionLifecycle,
	logger: Logger,
	input: LifecycleTransitionInput,
	tolerateConflict: boolean,
): Promise<void> {
	try {
		await lifecycle.transition(input);
	} catch (error) {
		if (tolerateConflict && isLifecycleConflict(error)) {
			logger.debug("lifecycle transition conflict tolerated", { to: input.to });
			return;
		}
		throw error;
	}
}

/** Deterministic, bounded title; nothing from the repository or model. */
export function buildPullRequestTitle(taskId: string): string {
	return `Task ${taskId}`.slice(0, MAX_TITLE_LENGTH);
}

/** Deterministic, bounded body built only from bounded identifiers. */
export function buildPullRequestBody(input: {
	taskId: string;
	target: PullRequestTarget;
}): string {
	const body = [
		"Automated change produced by isolate-platform.",
		"",
		`Task: ${input.taskId}`,
		`Branch: ${input.target.headBranch} -> ${input.target.baseBranch}`,
		`Commit: ${input.target.headSha}`,
	].join("\n");
	return body.slice(0, MAX_BODY_LENGTH);
}

/**
 * Maps a connector failure to a bounded verdict. Network/timeout/rate-limit
 * failures are retryable (the connector is idempotent on an already-open PR);
 * every policy/validation/approval failure is terminal.
 */
function failureVerdict(
	code: string,
	message: string | undefined,
): HandlerVerdict {
	const bounded = clampErrorCode(code);
	if (bounded === "INTEGRATION_UNAVAILABLE" || bounded === "RATE_LIMITED") {
		return { outcome: "retry", code: bounded };
	}
	const note = sanitizeMessage(message ?? "", 200);
	return note === ""
		? { outcome: "dead_letter", code: bounded }
		: { outcome: "dead_letter", code: bounded, note };
}

export function createPullRequestHandler(
	deps: PullRequestWorkflowDeps,
): JobHandler {
	return {
		jobType: "create_pull_request",

		supports(payload) {
			return readTaskId(payload) !== null && readApprovalId(payload) !== null;
		},

		async handle(job, ctx): Promise<HandlerVerdict> {
			/**
			 * Wave 11: one bounded `worker.pr.outcome` record per attempt at this
			 * job. Only the outcome (and a bounded code) is emitted.
			 */
			const prOutcome = (
				outcome: "created" | "recorded" | "failed" | "skipped",
				code?: string,
			): void => {
				emitMetric(ctx.logger, WORKER_METRICS.prOutcome, {
					taskId: job.taskId,
					outcome,
					...(code === undefined ? {} : { code }),
				});
			};

			if (
				readTaskId(job.payload) === null ||
				readApprovalId(job.payload) === null
			) {
				prOutcome("skipped", "VALIDATION_FAILED");
				return REJECTED_PAYLOAD;
			}

			const task = await deps.loadTaskState({
				organizationId: job.organizationId,
				taskId: job.taskId,
			});
			if (task === null) {
				prOutcome("failed", "NOT_FOUND");
				return {
					outcome: "dead_letter",
					code: "NOT_FOUND",
					note: "task not found",
				};
			}
			// Idempotent redelivery: the first run recorded the PR (or the task
			// already reached the terminal-ish state). Never call GitHub twice.
			if (
				task.status === "pull_request_created" ||
				task.pullRequestNumber !== null
			) {
				prOutcome("skipped", "ALREADY_RECORDED");
				return { outcome: "complete", note: "pull request already recorded" };
			}
			if (INELIGIBLE_STATUSES.has(task.status)) {
				prOutcome("skipped", "TASK_NOT_ELIGIBLE");
				return { outcome: "complete", note: "task not eligible" };
			}
			if (!PR_ELIGIBLE_STATUSES.has(task.status)) {
				prOutcome("skipped", "APPROVAL_REQUIRED");
				return {
					outcome: "complete",
					note: "task not awaiting pull request approval",
				};
			}

			const approvalId = readApprovalId(job.payload);
			if (approvalId === null) {
				prOutcome("skipped", "VALIDATION_FAILED");
				return REJECTED_PAYLOAD;
			}
			const approval = await deps.lifecycle.approvalStatus({
				organizationId: job.organizationId,
				taskId: job.taskId,
				approvalId,
			});
			if (approval === null) {
				prOutcome("skipped", "NOT_FOUND");
				return { outcome: "complete", note: "approval not found" };
			}
			if (approval.status === "pending") {
				// Enqueue-before-decide: the job may fire before the human answers.
				// Wait (bounded by max_attempts) rather than consuming the job.
				prOutcome("skipped", "APPROVAL_REQUIRED");
				return {
					outcome: "retry",
					code: "APPROVAL_REQUIRED",
					backoffMs: 60_000,
				};
			}
			// Rejected / expired: no PR. The control plane fails the task on
			// rejection; this handler must not retry.
			if (approval.status !== "approved") {
				prOutcome("skipped", "APPROVAL_REQUIRED");
				return { outcome: "complete", note: `approval ${approval.status}` };
			}

			const target = await deps.loadPullRequestTarget({
				organizationId: job.organizationId,
				taskId: job.taskId,
			});
			if (target === null) {
				prOutcome("skipped", "NOT_FOUND");
				return { outcome: "complete", note: "pull request target unavailable" };
			}
			const expectedPayloadSha256 =
				await pullRequestApprovalPayloadSha256(target);
			if (approval.payloadSha256.toLowerCase() !== expectedPayloadSha256) {
				// The approval is bound to a different request: no PR, no retry.
				prOutcome("skipped", "DEPENDENCY_CONFLICT");
				return { outcome: "complete", note: "approval payload mismatch" };
			}

			ctx.logger.info("creating pull request for approved task", {
				action: PULL_REQUEST_APPROVAL_ACTION,
			});
			const created = await deps.createPullRequest({
				organizationId: job.organizationId,
				repositoryFullName: target.repositoryFullName,
				headBranch: target.headBranch,
				baseBranch: target.baseBranch,
				headSha: target.headSha,
				title: buildPullRequestTitle(job.taskId),
				body: buildPullRequestBody({ taskId: job.taskId, target }),
				expectedPayloadSha256,
			});
			if (!created.ok) {
				ctx.logger.warn("pull request creation failed", {
					code: clampErrorCode(created.code),
				});
				prOutcome("failed", clampErrorCode(created.code));
				return failureVerdict(created.code, created.message);
			}

			const record = created.pullRequest;
			const recorded = await deps.recordPullRequest({
				organizationId: job.organizationId,
				taskId: job.taskId,
				pullRequestNumber: record.number,
				pullRequestUrl: record.url,
			});
			if (!recorded.ok) {
				prOutcome("failed", "NOT_FOUND");
				return {
					outcome: "dead_letter",
					code: "NOT_FOUND",
					note: "task not found",
				};
			}
			await transitionLifecycle(
				deps.lifecycle,
				ctx.logger,
				{
					organizationId: job.organizationId,
					taskId: job.taskId,
					from: task.status,
					to: "pull_request_created",
					actor: "worker",
					reason: "pull request created",
				},
				true,
			);
			await deps.lifecycle.event({
				organizationId: job.organizationId,
				taskId: job.taskId,
				workflowRunId: null,
				type: "pr.created",
				actor: "worker",
				data: {
					number: record.number,
					url: record.url,
					headBranch: record.headBranch,
					baseBranch: record.baseBranch,
					headSha: record.headSha,
				},
			});
			ctx.logger.info("pull request recorded", { number: record.number });
			prOutcome(created.created ? "created" : "recorded");
			return {
				outcome: "complete",
				note: created.created
					? "pull request created"
					: "pull request recorded",
			};
		},
	};
}
