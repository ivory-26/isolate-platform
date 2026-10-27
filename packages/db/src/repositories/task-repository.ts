import type { OrganizationId, TaskId, TaskStatus } from "@isolate/shared";
import type { TaskRow } from "../schema";

/**
 * Tasks repository contract. Sprint A-2 implements it (Neon); the worker and
 * web app depend only on this interface. Implementations must enforce the
 * shared TASK_STATE_TRANSITIONS guard and never trust caller-supplied state.
 */
export interface TaskRepository {
	create(input: {
		organizationId: OrganizationId;
		repositoryId: string;
		// Role of the isolated branch/worktree this task is allowed to mutate.
		branch: string;
		idempotencyKey: string;
		budgetLimits: {
			maxAgentTurns: number;
			maxRepairAttempts: number;
			maxDurationMs: number;
		};
		createdBy: string;
	}): Promise<TaskRow>;

	get(taskId: TaskId): Promise<TaskRow | null>;

	getByIdempotencyKey(
		organizationId: OrganizationId,
		idempotencyKey: string,
	): Promise<TaskRow | null>;

	listByStatus(status: TaskStatus, limit: number): Promise<TaskRow[]>;

	/**
	 * Applies a state transition. Returns the updated row, or a typed failure
	 * when the task is missing, the transition is illegal, or the row changed
	 * underneath (optimistic concurrency via `expectedStatus`).
	 */
	transition(input: {
		taskId: TaskId;
		to: TaskStatus;
		expectedStatus: TaskStatus;
	}): Promise<
		| { ok: true; task: TaskRow }
		| { ok: false; code: "NOT_FOUND" | "INVALID_TRANSITION" | "CONFLICT" }
	>;

	listExpiredOverBudget(): Promise<TaskRow[]>;
}
