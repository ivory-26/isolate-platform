import "@tanstack/react-start/server-only";
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
} from "../features/tasks/contracts";

export type CallerScope = { organizationId: OrganizationId; userId: UserId };
export interface TaskStore {
	submit(
		scope: CallerScope,
		input: ValidatedSubmission,
	): Promise<SubmissionReceipt>;
	listLatest(scope: CallerScope, limit: number): Promise<TaskSummary[]>;
}
export class ControlPlaneError extends Error {
	constructor(readonly code: FailureCode) {
		super(failureMessages[code]);
	}
}
const scopeSchema = z.strictObject({
	organizationId: z.uuid(),
	userId: z.uuid(),
});
export function createTaskService(deps: {
	// Only a trusted server-side identity adapter may supply this context.
	resolveScope: () => Promise<CallerScope>;
	getStore: () => Promise<TaskStore>;
}) {
	async function scoped<T>(
		action: (store: TaskStore, scope: CallerScope) => Promise<T>,
	): Promise<ServiceResult<T>> {
		try {
			const scope = await deps.resolveScope();
			if (!scopeSchema.safeParse(scope).success)
				throw new ControlPlaneError("AUTH_REQUIRED");
			return { ok: true, value: await action(await deps.getStore(), scope) };
		} catch (error) {
			const code =
				error instanceof ControlPlaneError ? error.code : "UNAVAILABLE";
			// Never serialize driver errors, request data, stacks, or credentials.
			return { ok: false, error: { code, message: failureMessages[code] } };
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
			return scoped((store, scope) => store.submit(scope, parsed.data));
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
			return scoped((store, scope) =>
				store.listLatest(scope, parsed.data.limit),
			);
		},
	};
}
