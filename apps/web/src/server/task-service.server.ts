import "@tanstack/react-start/server-only";
import {
	hasCapability,
	type PlatformCapability,
	type UserRole,
} from "@isolate/db";
import type { OrganizationId, UserId } from "@isolate/shared";
import { z } from "zod";
import {
	type ApprovalDecisionReceipt,
	decideApprovalSchema,
	type FailureCode,
	failureMessages,
	incidentSubmissionSchema,
	listTasksSchema,
	type RetryReceipt,
	retryTaskSchema,
	type ServiceResult,
	type SubmissionReceipt,
	type TaskSummary,
	type ValidatedApprovalDecision,
	type ValidatedRetry,
	type ValidatedSubmission,
	type WorkflowRejectionIssue,
	workflowRejectionIssuesSchema,
} from "../features/tasks/contracts";

export type CallerScope = {
	organizationId: OrganizationId;
	userId: UserId;
	/** The role the caller holds in `organizationId`; never supplied by a request. */
	role: UserRole;
};
export interface TaskStore {
	submit(
		scope: CallerScope,
		input: ValidatedSubmission,
	): Promise<SubmissionReceipt>;
	listLatest(scope: CallerScope, limit: number): Promise<TaskSummary[]>;
	/** Rerun a failed task as a NEW task in the same boundary. */
	retry(scope: CallerScope, input: ValidatedRetry): Promise<RetryReceipt>;
	/** Human decision on one pending approval; approval enqueues one follow-up. */
	decideApproval(
		scope: CallerScope,
		input: ValidatedApprovalDecision,
	): Promise<ApprovalDecisionReceipt>;
}
export class ControlPlaneError extends Error {
	constructor(
		readonly code: FailureCode,
		/** Already sanitized by the compilation boundary; bounded again below. */
		readonly issues?: readonly WorkflowRejectionIssue[],
		/** Optional bounded message for an action-specific refusal. */
		message?: string,
	) {
		super(
			message === undefined ? failureMessages[code] : message.slice(0, 240),
		);
	}
}
const scopeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
	role: z.enum(["owner", "admin", "member", "viewer"]),
});
function boundedIssues(
	error: ControlPlaneError,
): WorkflowRejectionIssue[] | undefined {
	if (error.code !== "WORKFLOW_REJECTED" || !error.issues) return undefined;
	const parsed = workflowRejectionIssuesSchema.safeParse(error.issues);
	return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}
export function createTaskService(deps: {
	// Only a trusted server-side identity adapter may supply this context.
	resolveScope: () => Promise<CallerScope>;
	getStore: () => Promise<TaskStore>;
}) {
	async function scoped<T>(
		action: (store: TaskStore, scope: CallerScope) => Promise<T>,
		capability: PlatformCapability,
	): Promise<ServiceResult<T>> {
		try {
			const scope = await deps.resolveScope();
			if (!scopeSchema.safeParse(scope).success)
				throw new ControlPlaneError("AUTH_REQUIRED");
			// A viewer may read but never submit; the role is the only input.
			if (!hasCapability(scope.role, capability))
				throw new ControlPlaneError("FORBIDDEN");
			return { ok: true, value: await action(await deps.getStore(), scope) };
		} catch (error) {
			const code =
				error instanceof ControlPlaneError ? error.code : "UNAVAILABLE";
			const issues =
				error instanceof ControlPlaneError ? boundedIssues(error) : undefined;
			// Never serialize driver errors, request data, stacks, or credentials.
			// A ControlPlaneError message is already bounded by the server-side
			// action that raised it.
			return {
				ok: false,
				error: {
					code,
					message:
						error instanceof ControlPlaneError
							? error.message
							: failureMessages.UNAVAILABLE,
					...(issues ? { issues } : {}),
				},
			};
		}
	}
	return {
		submit(input: unknown): Promise<ServiceResult<SubmissionReceipt>> {
			// Accepts the ordinary submission plus optional incident provenance. The
			// browser-facing validators use `submitTaskSchema` and reject provenance
			// before this point, so only the server-side intake can set it.
			const parsed = incidentSubmissionSchema.safeParse(input);
			if (!parsed.success)
				return Promise.resolve({
					ok: false,
					error: {
						code: "INVALID_INPUT",
						message: failureMessages.INVALID_INPUT,
					},
				});
			return scoped(
				(store, scope) => store.submit(scope, parsed.data),
				"task:submit",
			);
		},
		list(input: unknown): Promise<ServiceResult<TaskSummary[]>> {
			const parsed = listTasksSchema.safeParse(input);
			if (!parsed.success)
				return Promise.resolve({
					ok: false,
					error: {
						code: "INVALID_INPUT",
						message: failureMessages.INVALID_INPUT,
					},
				});
			return scoped(
				(store, scope) => store.listLatest(scope, parsed.data.limit),
				"task:read",
			);
		},
		retry(input: unknown): Promise<ServiceResult<RetryReceipt>> {
			const parsed = retryTaskSchema.safeParse(input);
			if (!parsed.success)
				return Promise.resolve({
					ok: false,
					error: {
						code: "INVALID_INPUT",
						message: failureMessages.INVALID_INPUT,
					},
				});
			// `task:submit` is checked inside scoped() BEFORE the store is touched.
			return scoped(
				(store, scope) => store.retry(scope, parsed.data),
				"task:submit",
			);
		},
		decideApproval(
			input: unknown,
		): Promise<ServiceResult<ApprovalDecisionReceipt>> {
			const parsed = decideApprovalSchema.safeParse(input);
			if (!parsed.success)
				return Promise.resolve({
					ok: false,
					error: {
						code: "INVALID_INPUT",
						message: failureMessages.INVALID_INPUT,
					},
				});
			// A viewer can never decide: capability before any storage read.
			return scoped(
				(store, scope) => store.decideApproval(scope, parsed.data),
				"task:submit",
			);
		},
	};
}
