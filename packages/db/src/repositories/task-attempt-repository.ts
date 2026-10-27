import type { TaskAttemptId, TaskId } from "@isolate/shared";
import type { TaskAttemptOutcome, TaskAttemptRow } from "../schema";

/**
 * Bounded attempt bookkeeping. `attemptIndex` is monotonic per task; the
 * repair budget (max_repair_attempts) is enforced against these rows, which is
 * what keeps the repair loop finite (architecture §9).
 */
export interface TaskAttemptRepository {
	begin(taskId: TaskId, workflowRunId: string | null): Promise<TaskAttemptRow>;

	finish(input: {
		attemptId: TaskAttemptId;
		outcome: TaskAttemptOutcome;
	}): Promise<TaskAttemptRow | null>;

	countRepairAttempts(taskId: TaskId): Promise<number>;

	listByTask(taskId: TaskId): Promise<TaskAttemptRow[]>;
}
