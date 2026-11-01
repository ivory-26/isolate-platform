import type { ApprovalRisk } from "../approvals/contracts";

/**
 * Client-safe Overview read-model contracts and pure derivations.
 *
 * Metrics are derived only from stored task statuses and bounded windows; an
 * unknown or malformed count is treated as zero rather than guessed.
 */

export const TERMINAL_TASK_STATUSES = [
	"completed",
	"failed",
	"cancelled",
	"blocked",
] as const;

/**
 * Work that is in flight and not waiting in the queue. `queued` is reported
 * separately so the metric strip never double-counts the same task.
 */
export const ACTIVE_TASK_STATUSES = [
	"planning",
	"executing",
	"validating",
	"repairing",
	"awaiting_approval",
	"review_ready",
	"pull_request_created",
] as const;

export const QUEUED_TASK_STATUS = "queued";

/** The stated window for the "recent failures" metric. */
export const FAILURE_WINDOW_HOURS = 24;

export const OVERVIEW_LIMITS = {
	activeRuns: 6,
	pendingApprovals: 5,
	activity: 12,
	devices: 8,
	submitRepositories: 50,
	submitWorkflowRows: 200,
} as const;

export function isTerminalTaskStatus(status: string): boolean {
	return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export function isActiveTaskStatus(status: string): boolean {
	return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
}

export type OverviewMetrics = {
	activeTasks: number;
	queuedTasks: number;
	pendingApprovals: number;
	recentFailures: number;
	failureWindowHours: number;
};

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.trunc(value)
		: 0;
}

export function deriveOverviewMetrics(input: {
	statusCounts: Readonly<Record<string, number>>;
	pendingApprovals: number;
	recentFailures: number;
}): OverviewMetrics {
	let activeTasks = 0;
	for (const status of ACTIVE_TASK_STATUSES) {
		activeTasks += count(input.statusCounts[status]);
	}
	return {
		activeTasks,
		queuedTasks: count(input.statusCounts[QUEUED_TASK_STATUS]),
		pendingApprovals: count(input.pendingApprovals),
		recentFailures: count(input.recentFailures),
		failureWindowHours: FAILURE_WINDOW_HOURS,
	};
}

/** Inclusive lower bound for a rolling window, in UTC ISO form. */
export function windowStartIso(now: Date, hours: number): string {
	const boundedHours = Number.isFinite(hours) ? Math.max(0, hours) : 0;
	return new Date(now.getTime() - boundedHours * 3_600_000).toISOString();
}

/** Milliseconds from a stored timestamp to `now`; invalid input is zero. */
export function elapsedMsSince(startIso: string | null, now: Date): number {
	if (startIso === null) return 0;
	const start = Date.parse(startIso);
	if (!Number.isFinite(start)) return 0;
	return Math.max(0, now.getTime() - start);
}

const EVENT_LABELS: Record<string, string> = {
	"task.enqueued": "Task enqueued",
	"task.claimed": "Task claimed",
	"task.state_changed": "State changed",
	"task.retried": "Task retried",
	"workspace.cloned": "Workspace cloned",
	"artifact.created": "Artifact created",
	"agent.turn_started": "Agent turn started",
	"agent.turn_finished": "Agent turn finished",
	"tool.invoked": "Tool invoked",
	"tool.denied_by_policy": "Tool denied by policy",
	"workflow.step_started": "Step started",
	"workflow.step_finished": "Step finished",
	"workflow.step_failed": "Step failed",
	"validation.started": "Validation started",
	"validation.finished": "Validation finished",
	"acceptance.started": "Acceptance started",
	"acceptance.finished": "Acceptance finished",
	"repair.started": "Repair started",
	"repair.finished": "Repair finished",
	"approval.requested": "Approval requested",
	"approval.decided": "Approval decided",
	"pr.created": "Pull request created",
	"worker.lease_renewed": "Worker lease renewed",
	"worker.job_failed": "Worker job failed",
	"worker.job_dead_lettered": "Worker job dead-lettered",
};

export function eventTypeLabel(type: string | null): string {
	if (type === null || type.length === 0) return "No events yet";
	return (
		EVENT_LABELS[type] ??
		type
			.replaceAll(/[._-]+/g, " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase())
	);
}

export type OrganizationContext = {
	id: string;
	name: string;
	slug: string;
};

export type ActiveRunSummary = {
	taskId: string;
	repositoryName: string;
	branch: string;
	/** Task lifecycle status. */
	status: string;
	runStatus: string | null;
	/** Latest run event type, when one exists. */
	stage: string | null;
	stageLabel: string;
	/** Run start when a run exists, otherwise task creation. */
	startedAt: string;
	elapsedMs: number;
	latestUpdateAt: string;
};

export type PendingApprovalPreview = {
	approvalId: string;
	taskId: string;
	action: string;
	actionLabel: string;
	risk: ApprovalRisk;
	repositoryName: string;
	branch: string;
	requestedBy: string;
	createdAt: string;
	expiresAt: string;
};

export type ActivityItem = {
	id: string;
	taskId: string;
	type: string;
	typeLabel: string;
	actor: string;
	occurredAt: string;
	branch: string;
};

export type DeviceHealthRow = {
	id: string;
	displayName: string;
	status: "pending" | "active" | "revoked";
	lastSeenAt: string | null;
	createdAt: string;
};

export type OverviewSnapshot = {
	generatedAt: string;
	organization: OrganizationContext | null;
	metrics: OverviewMetrics;
	activeRuns: ActiveRunSummary[];
	pendingApprovals: PendingApprovalPreview[];
	activity: ActivityItem[];
	devices: DeviceHealthRow[];
};

export type RepositoryOption = {
	id: string;
	name: string;
	defaultBranch: string;
};

export type WorkflowOption = {
	id: string;
	name: string;
	/** Published versions, newest first. */
	versions: number[];
};

export type SubmitOptions = {
	repositories: RepositoryOption[];
	workflows: WorkflowOption[];
};
