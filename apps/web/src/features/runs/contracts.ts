import { TASK_STATUSES, type TaskStatus } from "@isolate/shared";
import { z } from "zod";

/**
 * Client-safe contracts for the Runs surfaces. Nothing here imports the
 * database or a server-only module: the browser validates its own input and
 * renders a server projection, and the server re-validates every field before
 * touching SQL.
 */

/** One page of runs; the row cap is enforced again on the server. */
export const RUNS_PAGE_LIMIT_DEFAULT = 25;
export const RUNS_PAGE_LIMIT_MAX = 100;
/** `OFFSET` is bounded so a hostile search value cannot scan the table. */
export const RUNS_OFFSET_MAX = 10_000;
/** Highest page accepted by `parseRunsSearch` (10_000 / 25 pages). */
export const RUNS_PAGE_MAX = 400;
/** Free-text search is bounded before it reaches a parameter. */
export const RUNS_QUERY_MAX_LENGTH = 80;
/** Repository filter options are a bounded tenant list. */
export const RUN_REPOSITORY_OPTION_LIMIT = 50;
/** Detail page section caps; a noisy task streams a page, never all history. */
export const RUN_DETAIL_EVENT_LIMIT = 200;
export const RUN_DETAIL_RUN_LIMIT = 20;
export const RUN_DETAIL_APPROVAL_LIMIT = 50;
export const RUN_DETAIL_ARTIFACT_LIMIT = 20;
export const RUN_DETAIL_ATTEMPT_LIMIT = 10;
/** Inline artifact preview bound (the DB itself caps content at 256 KiB). */
export const RUN_ARTIFACT_PREVIEW_CHARS = 16_384;
/** Maximum rerun depth accepted by the retry action. */
export const RUN_MAX_RETRY_DEPTH = 3;

export const RUN_STATUS_FILTERS = ["all", ...TASK_STATUSES] as const;
export type RunStatusFilter = (typeof RUN_STATUS_FILTERS)[number];

export const RUN_SORTS = ["created", "updated", "status"] as const;
export type RunSort = (typeof RUN_SORTS)[number];

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** URL search state for `/runs`; `repo` is a UUID or empty. */
export type RunsSearch = {
	status: RunStatusFilter;
	repo: string;
	q: string;
	sort: RunSort;
	/** One-based page; always bounded by `RUNS_PAGE_MAX`. */
	page: number;
};

export const RUNS_SEARCH_DEFAULTS: RunsSearch = {
	status: "all",
	repo: "",
	q: "",
	sort: "created",
	page: 1,
};

function isStatusFilter(value: unknown): value is RunStatusFilter {
	return (
		typeof value === "string" &&
		(RUN_STATUS_FILTERS as readonly string[]).includes(value)
	);
}

function isSort(value: unknown): value is RunSort {
	return (
		typeof value === "string" &&
		(RUN_SORTS as readonly string[]).includes(value)
	);
}

/** One-based page from an untrusted URL value, clamped to `1..RUNS_PAGE_MAX`. */
export function parseRunsPage(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	if (!Number.isInteger(parsed)) return 1;
	return Math.min(Math.max(parsed, 1), RUNS_PAGE_MAX);
}

/**
 * Never throws: an unknown or hostile search value falls back to the default
 * instead of breaking navigation. This is the `validateSearch` seam.
 */
export function parseRunsSearch(
	input: Record<string, unknown> | undefined,
): RunsSearch {
	const raw = input ?? {};
	const status = isStatusFilter(raw.status)
		? raw.status
		: RUNS_SEARCH_DEFAULTS.status;
	const sort = isSort(raw.sort) ? raw.sort : RUNS_SEARCH_DEFAULTS.sort;
	const repo = isUuid(raw.repo)
		? raw.repo.toLowerCase()
		: RUNS_SEARCH_DEFAULTS.repo;
	const q =
		typeof raw.q === "string"
			? raw.q.trim().slice(0, RUNS_QUERY_MAX_LENGTH)
			: RUNS_SEARCH_DEFAULTS.q;
	return { status, repo, q, sort, page: parseRunsPage(raw.page) };
}

/**
 * Applies one filter patch. Changing status, repository, search text or sort
 * always returns to page one so the visible page cannot outlive its filter;
 * a page-only patch is clamped instead.
 */
export function applyRunsSearchPatch(
	current: RunsSearch,
	patch: Partial<RunsSearch>,
): RunsSearch {
	const next = { ...current, ...patch };
	const filtersChanged =
		next.status !== current.status ||
		next.repo !== current.repo ||
		next.q !== current.q ||
		next.sort !== current.sort;
	return {
		...next,
		page: filtersChanged ? 1 : parseRunsPage(next.page),
	};
}

/** Server input for the list read; strict so unknown keys are rejected. */
export const runsListInputSchema = z.strictObject({
	status: z.enum(RUN_STATUS_FILTERS).default("all"),
	repositoryId: z.uuid().nullable().default(null),
	q: z.string().trim().max(RUNS_QUERY_MAX_LENGTH).default(""),
	sort: z.enum(RUN_SORTS).default("created"),
	limit: z.number().int().min(1).max(RUNS_PAGE_LIMIT_MAX).default(25),
	offset: z.number().int().min(0).max(RUNS_OFFSET_MAX).default(0),
});

export type RunsListInput = z.input<typeof runsListInputSchema>;
export type ValidatedRunsListInput = z.output<typeof runsListInputSchema>;

/** Detail input; the read model re-validates the UUID before SQL. */
export type RunDetailInput = { taskId: string };

export function runsSearchToFilter(search: RunsSearch): RunsListInput {
	return {
		status: search.status,
		repositoryId: search.repo === "" ? null : search.repo,
		q: search.q,
		sort: search.sort,
		limit: RUNS_PAGE_LIMIT_DEFAULT,
		offset: (parseRunsPage(search.page) - 1) * RUNS_PAGE_LIMIT_DEFAULT,
	};
}

/* ---------------------------------------------------------------- read model */

export type RunRepositoryRef = {
	id: string;
	fullName: string;
	defaultBranch: string;
};

export type RunRepositoryOption = { id: string; fullName: string };

export type WorkflowRunStatusView =
	| "running"
	| "suspended"
	| "succeeded"
	| "failed";

export type RunLatestRun = {
	id: string;
	status: WorkflowRunStatusView;
	startedAt: string;
	finishedAt: string | null;
};

export type RunListRow = {
	taskId: string;
	branch: string;
	status: TaskStatus;
	retryDepth: number;
	/** Provenance of the signal that opened the task; null means manual. */
	incidentSource: string | null;
	createdAt: string;
	updatedAt: string;
	repository: RunRepositoryRef;
	latestRun: RunLatestRun | null;
};

export type RunsSummary = {
	total: number;
	active: number;
	awaitingApproval: number;
	failed: number;
	reviewReady: number;
};

export type RunsListPage = {
	rows: RunListRow[];
	/** Matching rows for the current filters; drives the page count. */
	total: number;
	/** One-based, already clamped to the last page that exists. */
	page: number;
	summary: RunsSummary;
	repositories: RunRepositoryOption[];
};

export type RunWorkflowRun = {
	id: string;
	status: WorkflowRunStatusView;
	startedAt: string;
	finishedAt: string | null;
};

/**
 * One durable `task_attempts` row, reduced to the fields the execution map
 * needs. `status` comes from the stored outcome; an open row is `running` and
 * an unreadable outcome on a closed row is `unknown`, never invented.
 */
export type RunAttemptStatus =
	| "running"
	| "failed"
	| "cancelled"
	| "retry"
	| "review_ready"
	| "awaiting_approval"
	| "unknown";

export type RunAttempt = {
	attemptIndex: number;
	status: RunAttemptStatus;
	startedAt: string;
	finishedAt: string | null;
	/** Typed machine code from the outcome, bounded; a free-text reason is not exposed. */
	errorCode: string | null;
};

export type RunEventActor = "user" | "agent" | "worker" | "system" | "policy";

/** JSON-safe value; event metadata is sanitized before it reaches this type. */
export type RunJsonValue =
	| string
	| number
	| boolean
	| null
	| RunJsonValue[]
	| { [key: string]: RunJsonValue };

export type RunEventView = {
	type: string;
	actor: RunEventActor;
	/** Sanitized event metadata; credentials were dropped before it arrived. */
	data: Record<string, RunJsonValue>;
	createdAt: string;
};

export type RunToolDecision = "allowed" | "allowed_by_approval" | "denied";

export type RunToolInvocation = {
	toolName: string;
	decision: RunToolDecision;
	denialReason: string | null;
	/** sha256 of the redacted arguments; the arguments never leave the server. */
	argumentsHash: string;
	durationMs: number | null;
	createdAt: string;
};

export type RunUsageRecord = {
	provider: string;
	modelId: string;
	promptTokens: number | null;
	completionTokens: number | null;
	/** Exact `numeric(12,6)` decimal string, or null when no price was known. */
	costUsd: string | null;
	createdAt: string;
};

export type RunConnectorCallStatus =
	| "queued"
	| "claimed"
	| "completed"
	| "failed"
	| "expired";

export type RunConnectorCall = {
	toolName: string;
	connectorId: string;
	status: RunConnectorCallStatus;
	errorCode: string | null;
	attempts: number;
	traceparent: string | null;
	createdAt: string;
	claimedAt: string | null;
	completedAt: string | null;
	expiresAt: string;
};

export type RunApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RunApproval = {
	id: string;
	action: string;
	status: RunApprovalStatus;
	payloadSha256: string;
	requestedBy: string;
	decidedBy: string | null;
	decidedAt: string | null;
	expiresAt: string;
	createdAt: string;
};

export type RunArtifact = {
	id: string;
	kind: string;
	contentType: string;
	byteSize: number;
	sha256: string;
	storageRef: string;
	/** True when the stored payload lives in object storage, not inline. */
	isBlob: boolean;
	/** Bounded preview; null when only metadata was stored inline. */
	contentPreview: string | null;
	/** True when the preview is shorter than the stored content. */
	truncated: boolean;
	createdAt: string;
};

/**
 * A later task created by the retry action and linked to this one through
 * `retry_of`. Bounded to a small list; the child is the authoritative task.
 */
export type RunRetryChild = {
	taskId: string;
	status: TaskStatus;
	retryDepth: number;
	createdAt: string;
};

export type RunTaskIdentity = {
	id: string;
	repository: RunRepositoryRef;
	branch: string;
	status: TaskStatus;
	goal: string;
	acceptanceCriteria: string[];
	fileOwnership: string[];
	pullRequestNumber: number | null;
	pullRequestUrl: string | null;
	retryOf: string | null;
	retryDepth: number;
	incidentSource: string | null;
	incidentFingerprint: string | null;
	/** Task autonomy level (migration 0016), e.g. `A2`; null only on old rows. */
	autonomyLevel: string | null;
	createdAt: string;
	updatedAt: string;
};

export type RunDetailView = {
	task: RunTaskIdentity;
	/** Bounded to `RUN_DETAIL_RUN_LIMIT`; see `workflowRunsTruncated`. */
	workflowRuns: RunWorkflowRun[];
	workflowRunsTruncated: boolean;
	/** Bounded to `RUN_DETAIL_ATTEMPT_LIMIT`; see `attemptsTruncated`. */
	attempts: RunAttempt[];
	attemptsTruncated: boolean;
	/** Later retry tasks linked by `retry_of`, oldest first. */
	retryChildren: RunRetryChild[];
	retryChildrenTruncated: boolean;
	traceId: string | null;
	/** Bounded to `RUN_DETAIL_EVENT_LIMIT`; see `eventsTruncated`. */
	events: RunEventView[];
	/** Exact count of durable events, so the cap can be stated honestly. */
	eventsTotal: number;
	eventsTruncated: boolean;
	toolInvocations: RunToolInvocation[];
	usage: RunUsageRecord[];
	connectorCalls: RunConnectorCall[];
	/** Bounded to `RUN_DETAIL_APPROVAL_LIMIT`; see `approvalsTruncated`. */
	approvals: RunApproval[];
	approvalsTruncated: boolean;
	/** Bounded to `RUN_DETAIL_ARTIFACT_LIMIT`; see `artifactsTruncated`. */
	artifacts: RunArtifact[];
	artifactsTruncated: boolean;
};

/**
 * Statuses where the run can still change on its own: a worker or a policy
 * decision will move it. `review_ready` and `pull_request_created` wait on a
 * human, and the terminal statuses are final, so polling stops for those.
 */
export const RUN_LIVE_STATUSES = [
	"queued",
	"planning",
	"awaiting_approval",
	"executing",
	"validating",
	"repairing",
] as const satisfies readonly TaskStatus[];

export function isLiveRunStatus(status: TaskStatus): boolean {
	return (RUN_LIVE_STATUSES as readonly TaskStatus[]).includes(status);
}

/** Detail and list polling cadence while a run is live. */
export const RUN_LIVE_POLL_INTERVAL_MS = 5_000;
