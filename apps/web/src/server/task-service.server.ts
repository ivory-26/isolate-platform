import "@tanstack/react-start/server-only";
import {
	hasCapability,
	type PlatformCapability,
	type UserRole,
} from "@isolate/db";
import type { OrganizationId, UserId } from "@isolate/shared";
import { z } from "zod";
import {
	type FailureCode,
	failureMessages,
	listTasksSchema,
	type ServiceResult,
	type SubmissionReceipt,
	submitTaskSchema,
	type TaskSummary,
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
}
export class ControlPlaneError extends Error {
	constructor(
		readonly code: FailureCode,
		/** Already sanitized by the compilation boundary; bounded again below. */
		readonly issues?: readonly WorkflowRejectionIssue[],
	) {
		super(failureMessages[code]);
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
			return {
				ok: false,
				error: {
					code,
					message: failureMessages[code],
					...(issues ? { issues } : {}),
				},
			};
		}
	}
	return {
		submit(input: unknown): Promise<ServiceResult<SubmissionReceipt>> {
			const parsed = submitTaskSchema.safeParse(input);
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
	};
}
