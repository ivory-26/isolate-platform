import type {
	OrganizationId,
	RunEventType,
	TaskId,
	WorkflowRunId,
	WorkflowVersionId,
} from "@isolate/shared";
import type { RunEventRow, WorkflowRunRow, WorkflowVersionRow } from "..";

/** Workflow runs + append-only event timeline. */
export interface WorkflowRunRepository {
	startRun(input: {
		taskId: TaskId;
		organizationId: OrganizationId;
		workflowVersionId: WorkflowVersionId;
	}): Promise<WorkflowRunRow>;

	get(runId: WorkflowRunId): Promise<WorkflowRunRow | null>;

	finish(
		runId: WorkflowRunId,
		status: "succeeded" | "failed",
	): Promise<WorkflowRunRow | null>;

	suspend(runId: WorkflowRunId): Promise<WorkflowRunRow | null>;

	/** Awaited on approval resolution; resumption reads from persisted state. */
	getVersionPin(runId: WorkflowRunId): Promise<WorkflowVersionRow | null>;

	appendEvent(input: {
		taskId: TaskId;
		workflowRunId: WorkflowRunId | null;
		type: RunEventType;
		actor: RunEventRow["actor"];
		data: Record<string, unknown>; // already redacted by caller
	}): Promise<RunEventRow>;

	listEvents(taskId: TaskId, limit: number): Promise<RunEventRow[]>;
}
