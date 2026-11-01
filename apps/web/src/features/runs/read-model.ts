import {
	type PgSql,
	PostgresTraceReadRepository,
	parseJsonbColumn,
} from "@isolate/db";
import {
	asTaskId,
	type OrganizationId,
	TASK_STATUSES,
	type TaskStatus,
} from "@isolate/shared";
import { UiInvalidInputError, UiNotFoundError } from "../ui/contracts";
import {
	RUN_ARTIFACT_PREVIEW_CHARS,
	RUN_DETAIL_APPROVAL_LIMIT,
	RUN_DETAIL_ARTIFACT_LIMIT,
	RUN_DETAIL_EVENT_LIMIT,
	RUN_DETAIL_RUN_LIMIT,
	RUN_REPOSITORY_OPTION_LIMIT,
	RUNS_PAGE_LIMIT_MAX,
	type RunApproval,
	type RunApprovalStatus,
	type RunArtifact,
	type RunConnectorCall,
	type RunDetailView,
	type RunEventActor,
	type RunEventView,
	type RunJsonValue,
	type RunListRow,
	type RunRepositoryOption,
	type RunsListPage,
	type RunTaskIdentity,
	type RunToolDecision,
	type RunToolInvocation,
	type RunUsageRecord,
	type RunWorkflowRun,
	runsListInputSchema,
	type WorkflowRunStatusView,
} from "./contracts";
import { summarizeStatusCounts } from "./view";

/**
 * Tenant-scoped read model behind the Runs list and run detail pages.
 *
 * Contract:
 * - `scope.organizationId` is the only tenancy input; no request value can
 *   widen it, and a foreign task is indistinguishable from a missing one.
 * - The task id is normalized as a UUID before any statement runs.
 * - Every statement is parameterized: no identifier or value is interpolated,
 *   and sort order is selected with CASE over a bound parameter rather than by
 *   composing SQL text.
 * - Row caps are applied before the limit parameter is bound (25 default, 100
 *   max for the list; fixed section caps for detail).
 * - Timeline, tool, usage and connector sections come from
 *   `PostgresTraceReadRepository`, so the trace redaction contract (credential
 *   scan, argument hashing, no payload columns) is preserved rather than
 *   re-implemented. Artifact previews are capped well below the DB's 256 KiB
 *   inline cap.
 */

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RunsReadScope = { readonly organizationId: OrganizationId };

export function normalizeRunTaskId(value: unknown): string | null {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) return null;
	return value.toLowerCase();
}

const STMT = {
	summary: `SELECT t.status, count(*)::int AS count
		FROM tasks t
		WHERE t.organization_id = $1
		GROUP BY t.status`,
	repositories: `SELECT r.id, r.external_full_name
		FROM repositories r
		WHERE r.organization_id = $1
		ORDER BY lower(r.external_full_name) ASC, r.id ASC
		LIMIT $2`,
	task: `SELECT t.id, t.branch, t.status, t.goal, t.acceptance_criteria,
			t.file_ownership, t.pull_request_number, t.pull_request_url,
			t.retry_of, t.retry_depth, t.incident_source, t.incident_fingerprint,
			t.created_at, t.updated_at,
			r.id AS repository_id, r.external_full_name, r.default_branch
		FROM tasks t
		JOIN repositories r
			ON r.id = t.repository_id AND r.organization_id = t.organization_id
		WHERE t.organization_id = $1 AND t.id = $2
		LIMIT 1`,
	workflowRuns: `SELECT w.id, w.status, w.started_at, w.finished_at
		FROM workflow_runs w
		WHERE w.organization_id = $1 AND w.task_id = $2
		ORDER BY w.started_at ASC, w.id ASC
		LIMIT $3`,
	approvals: `SELECT a.id, a.action, a.status, a.payload_sha256, a.requested_by,
			a.decided_by, a.decided_at, a.expires_at, a.created_at
		FROM approvals a
		JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
		WHERE a.organization_id = $1 AND a.task_id = $2
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT $3`,
	artifacts: `SELECT a.id, a.kind, a.content_type, a.byte_size, a.sha256,
			a.storage_ref, left(a.content, $4::int) AS content_preview,
			octet_length(a.content) AS content_bytes, a.created_at
		FROM artifacts a
		WHERE a.organization_id = $1 AND a.task_id = $2
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT $3`,
} as const;

const LIST_SQL = `SELECT t.id, t.branch, t.status, t.retry_depth, t.created_at,
		t.updated_at,
		r.id AS repository_id, r.external_full_name, r.default_branch,
		w.id AS run_id, w.status AS run_status, w.started_at AS run_started_at,
		w.finished_at AS run_finished_at
	FROM tasks t
	JOIN repositories r
		ON r.id = t.repository_id AND r.organization_id = t.organization_id
	LEFT JOIN LATERAL (
		SELECT wr.id, wr.status, wr.started_at, wr.finished_at
		FROM workflow_runs wr
		WHERE wr.task_id = t.id AND wr.organization_id = t.organization_id
		ORDER BY wr.started_at DESC, wr.id DESC
		LIMIT 1
	) w ON true
	WHERE t.organization_id = $1
	  AND ($2::text = 'all' OR t.status = $2)
	  AND ($3::uuid IS NULL OR t.repository_id = $3)
	  AND ($4::text = ''
		OR position(lower($4) in lower(t.id::text || ' ' || t.branch)) > 0)
	ORDER BY
		CASE WHEN $5 = 'created' THEN t.created_at END DESC,
		CASE WHEN $5 = 'updated' THEN t.updated_at END DESC,
		CASE WHEN $5 = 'status' THEN t.status END ASC,
		t.created_at DESC, t.id DESC
	LIMIT $6`;

function rowError(): Error {
	return new Error("run row is invalid");
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw rowError();
	return value;
}

function optionalText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw rowError();
	return value;
}

function timestamp(value: unknown): string {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw rowError();
		return value.toISOString();
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	throw rowError();
}

function optionalTimestamp(value: unknown): string | null {
	return value === null || value === undefined ? null : timestamp(value);
}

function count(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw rowError();
	return Math.trunc(parsed);
}

function optionalCount(value: unknown): number | null {
	return value === null || value === undefined ? null : count(value);
}

const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

function taskStatus(value: unknown): TaskStatus {
	if (typeof value !== "string" || !TASK_STATUS_SET.has(value)) {
		throw rowError();
	}
	return value as TaskStatus;
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
	"running",
	"suspended",
	"succeeded",
	"failed",
]);

function workflowStatus(value: unknown): WorkflowRunStatusView {
	if (typeof value !== "string" || !RUN_STATUSES.has(value)) throw rowError();
	return value as WorkflowRunStatusView;
}

const APPROVAL_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"approved",
	"rejected",
	"expired",
]);

function approvalStatus(value: unknown): RunApprovalStatus {
	if (typeof value !== "string" || !APPROVAL_STATUSES.has(value)) {
		throw rowError();
	}
	return value as RunApprovalStatus;
}

const ACTORS: ReadonlySet<string> = new Set([
	"user",
	"agent",
	"worker",
	"system",
	"policy",
]);

function actor(value: unknown): RunEventActor {
	if (typeof value !== "string" || !ACTORS.has(value)) throw rowError();
	return value as RunEventActor;
}

const TOOL_DECISIONS: ReadonlySet<string> = new Set([
	"allowed",
	"allowed_by_approval",
	"denied",
]);

function toolDecision(value: unknown): RunToolDecision {
	if (typeof value !== "string" || !TOOL_DECISIONS.has(value)) throw rowError();
	return value as RunToolDecision;
}

function stringList(value: unknown): string[] {
	let parsed: unknown;
	try {
		parsed = parseJsonbColumn<unknown>(value);
	} catch {
		throw rowError();
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((item): item is string => typeof item === "string");
}

function mapRepositoryOption(
	row: Record<string, unknown>,
): RunRepositoryOption {
	return {
		id: text(row.id),
		fullName: text(row.external_full_name),
	};
}

function mapListRow(row: Record<string, unknown>): RunListRow {
	const runId = optionalText(row.run_id);
	return {
		taskId: text(row.id),
		branch: text(row.branch),
		status: taskStatus(row.status),
		retryDepth: count(row.retry_depth),
		createdAt: timestamp(row.created_at),
		updatedAt: timestamp(row.updated_at),
		repository: {
			id: text(row.repository_id),
			fullName: text(row.external_full_name),
			defaultBranch: text(row.default_branch),
		},
		latestRun:
			runId === null
				? null
				: {
						id: runId,
						status: workflowStatus(row.run_status),
						startedAt: timestamp(row.run_started_at),
						finishedAt: optionalTimestamp(row.run_finished_at),
					},
	};
}

function mapTask(row: Record<string, unknown>): RunTaskIdentity {
	const pullRequestNumber = optionalCount(row.pull_request_number);
	return {
		id: text(row.id),
		repository: {
			id: text(row.repository_id),
			fullName: text(row.external_full_name),
			defaultBranch: text(row.default_branch),
		},
		branch: text(row.branch),
		status: taskStatus(row.status),
		goal: typeof row.goal === "string" ? row.goal : "",
		acceptanceCriteria: stringList(row.acceptance_criteria),
		fileOwnership: stringList(row.file_ownership),
		pullRequestNumber,
		pullRequestUrl: optionalText(row.pull_request_url),
		retryOf: optionalText(row.retry_of),
		retryDepth: count(row.retry_depth),
		incidentSource: optionalText(row.incident_source),
		incidentFingerprint: optionalText(row.incident_fingerprint),
		createdAt: timestamp(row.created_at),
		updatedAt: timestamp(row.updated_at),
	};
}

function mapWorkflowRun(row: Record<string, unknown>): RunWorkflowRun {
	return {
		id: text(row.id),
		status: workflowStatus(row.status),
		startedAt: timestamp(row.started_at),
		finishedAt: optionalTimestamp(row.finished_at),
	};
}

function mapApproval(row: Record<string, unknown>): RunApproval {
	return {
		id: text(row.id),
		action: text(row.action),
		status: approvalStatus(row.status),
		payloadSha256: text(row.payload_sha256),
		requestedBy: text(row.requested_by),
		decidedBy: optionalText(row.decided_by),
		decidedAt: optionalTimestamp(row.decided_at),
		expiresAt: timestamp(row.expires_at),
		createdAt: timestamp(row.created_at),
	};
}

function mapArtifact(row: Record<string, unknown>): RunArtifact {
	const storageRef = text(row.storage_ref);
	const rawPreview = row.content_preview;
	const preview =
		typeof rawPreview === "string"
			? rawPreview.slice(0, RUN_ARTIFACT_PREVIEW_CHARS)
			: null;
	const contentBytes = optionalCount(row.content_bytes);
	const previewBytes =
		preview === null ? 0 : new TextEncoder().encode(preview).length;
	return {
		id: text(row.id),
		kind: text(row.kind),
		contentType: text(row.content_type),
		byteSize: count(row.byte_size),
		sha256: text(row.sha256),
		storageRef,
		isBlob: storageRef.startsWith("blob:"),
		contentPreview: preview,
		truncated:
			preview !== null && contentBytes !== null && contentBytes > previewBytes,
		createdAt: timestamp(row.created_at),
	};
}

function mapEvent(event: {
	type: string;
	actor: string;
	data: Record<string, unknown>;
	createdAt: string;
}): RunEventView {
	return {
		type: text(event.type),
		actor: actor(event.actor),
		// `sanitizeTraceData` already reduced this to JSON-safe primitives,
		// bounded arrays and plain objects with credential keys dropped.
		data: event.data as Record<string, RunJsonValue>,
		createdAt: timestamp(event.createdAt),
	};
}

function mapTool(row: {
	toolName: string;
	decision: string;
	denialReason: string | null;
	argumentsHash: string;
	durationMs: number | null;
	createdAt: string;
}): RunToolInvocation {
	return {
		toolName: text(row.toolName),
		decision: toolDecision(row.decision),
		denialReason: optionalText(row.denialReason),
		argumentsHash: text(row.argumentsHash),
		durationMs: optionalCount(row.durationMs),
		createdAt: timestamp(row.createdAt),
	};
}

function mapUsage(row: {
	provider: string;
	modelId: string;
	promptTokens: number | null;
	completionTokens: number | null;
	costUsd: string | null;
	createdAt: string;
}): RunUsageRecord {
	return {
		provider: text(row.provider),
		modelId: text(row.modelId),
		promptTokens: optionalCount(row.promptTokens),
		completionTokens: optionalCount(row.completionTokens),
		costUsd: row.costUsd === null ? null : text(row.costUsd),
		createdAt: timestamp(row.createdAt),
	};
}

function mapConnectorCall(row: {
	toolName: string;
	connectorId: string;
	status: string;
	errorCode: string | null;
	attempts: number;
	traceparent: string | null;
	createdAt: string;
	claimedAt: string | null;
	completedAt: string | null;
	expiresAt: string;
}): RunConnectorCall {
	return {
		toolName: text(row.toolName),
		connectorId: text(row.connectorId),
		status: row.status as RunConnectorCall["status"],
		errorCode: optionalText(row.errorCode),
		attempts: count(row.attempts),
		traceparent: optionalText(row.traceparent),
		createdAt: timestamp(row.createdAt),
		claimedAt: optionalTimestamp(row.claimedAt),
		completedAt: optionalTimestamp(row.completedAt),
		expiresAt: timestamp(row.expiresAt),
	};
}

/** List page: bounded filtered rows plus organization-wide status counts. */
export async function readRunsList(
	sql: PgSql,
	scope: RunsReadScope,
	input: unknown,
): Promise<RunsListPage> {
	const parsed = runsListInputSchema.safeParse(input);
	if (!parsed.success) throw new UiInvalidInputError();
	const filter = parsed.data;
	const limit = Math.min(filter.limit, RUNS_PAGE_LIMIT_MAX);

	const summaryRows = (await sql.unsafe(STMT.summary, [
		scope.organizationId,
	])) as unknown as Record<string, unknown>[];
	const counts: Record<string, number> = {};
	for (const row of summaryRows) {
		const status = text(row.status);
		counts[status] = count(row.count);
	}

	const rows = (await sql.unsafe(LIST_SQL, [
		scope.organizationId,
		filter.status,
		filter.repositoryId,
		filter.q,
		filter.sort,
		limit,
	])) as unknown as Record<string, unknown>[];

	const repositoryRows = (await sql.unsafe(STMT.repositories, [
		scope.organizationId,
		RUN_REPOSITORY_OPTION_LIMIT,
	])) as unknown as Record<string, unknown>[];

	return {
		rows: rows.map(mapListRow),
		summary: summarizeStatusCounts(counts),
		repositories: repositoryRows.map(mapRepositoryOption),
	};
}

/** Run detail: identity, lifecycle, tool/usage/connector trace, approvals and artifacts. */
export async function readRunDetail(
	sql: PgSql,
	scope: RunsReadScope,
	input: unknown,
): Promise<RunDetailView> {
	const candidate =
		typeof input === "object" && input !== null
			? (input as { taskId?: unknown }).taskId
			: undefined;
	const taskId = normalizeRunTaskId(candidate);
	if (taskId === null) throw new UiNotFoundError();

	const taskRows = (await sql.unsafe(STMT.task, [
		scope.organizationId,
		taskId,
	])) as unknown as Record<string, unknown>[];
	const taskRow = taskRows[0];
	if (taskRow === undefined) throw new UiNotFoundError();

	// Reuses the wave-19 trace read model: same tenancy gate, credential
	// scan, argument hashing and bounded sections as the trace API.
	const trace = await new PostgresTraceReadRepository(sql).getTaskTrace({
		organizationId: scope.organizationId,
		taskId: asTaskId(taskId),
		maxEvents: RUN_DETAIL_EVENT_LIMIT,
	});
	if (trace === null) throw new UiNotFoundError();

	const runRows = (await sql.unsafe(STMT.workflowRuns, [
		scope.organizationId,
		taskId,
		RUN_DETAIL_RUN_LIMIT,
	])) as unknown as Record<string, unknown>[];
	const approvalRows = (await sql.unsafe(STMT.approvals, [
		scope.organizationId,
		taskId,
		RUN_DETAIL_APPROVAL_LIMIT,
	])) as unknown as Record<string, unknown>[];
	const artifactRows = (await sql.unsafe(STMT.artifacts, [
		scope.organizationId,
		taskId,
		RUN_DETAIL_ARTIFACT_LIMIT,
		RUN_ARTIFACT_PREVIEW_CHARS,
	])) as unknown as Record<string, unknown>[];

	return {
		task: mapTask(taskRow),
		workflowRuns: runRows.map(mapWorkflowRun),
		traceId: trace.traceId,
		events: trace.events.map(mapEvent),
		toolInvocations: trace.toolInvocations.map(mapTool),
		usage: trace.usage.map(mapUsage),
		connectorCalls: trace.connectorCalls.map(mapConnectorCall),
		approvals: approvalRows.map(mapApproval),
		artifacts: artifactRows.map(mapArtifact),
	};
}
