import "@tanstack/react-start/server-only";
import type { PgSql } from "@isolate/db";
import {
	approvalActionLabel,
	riskForAction,
} from "../features/approvals/contracts";
import {
	ACTIVE_TASK_STATUSES,
	type ActiveRunSummary,
	type ActivityItem,
	type DeviceHealthRow,
	deriveOverviewMetrics,
	elapsedMsSince,
	eventTypeLabel,
	FAILURE_WINDOW_HOURS,
	type OrganizationContext,
	OVERVIEW_LIMITS,
	type OverviewSnapshot,
	type PendingApprovalPreview,
	type RepositoryOption,
	type SubmitOptions,
	type WorkflowOption,
	windowStartIso,
} from "../features/overview/contracts";
import type { UiResult } from "../features/ui/contracts";
import type { CallerScope } from "./task-service.server";
import { iso, isoOrNull, numeric, uiRead } from "./ui-runtime.server";

/**
 * Tenant-scoped Overview read model.
 *
 * Every query binds `scope.organizationId` and a bounded row limit. The result
 * is an operational projection only: no goal text, payload, secret or driver
 * error crosses this boundary. Device rows are listed exactly as registered;
 * there is no synthetic "all systems operational" claim.
 */

export type OrganizationReadRow = { name: string; slug: string };

export type ActiveRunRow = {
	taskId: string;
	repositoryName: string;
	branch: string;
	status: string;
	createdAt: string;
	updatedAt: string;
	runStatus: string | null;
	runStartedAt: string | null;
	latestEventType: string | null;
	latestEventAt: string | null;
};

export type PendingApprovalRow = {
	approvalId: string;
	taskId: string;
	action: string;
	requestedBy: string;
	createdAt: string;
	expiresAt: string;
	repositoryName: string;
	branch: string;
};

export type ActivityRow = {
	id: string;
	taskId: string;
	type: string;
	actor: string;
	occurredAt: string;
	branch: string;
};

export type DeviceRow = {
	id: string;
	displayName: string;
	status: string;
	lastSeenAt: string | null;
	createdAt: string;
};

export type RepositoryRow = {
	id: string;
	name: string;
	defaultBranch: string;
};

export type WorkflowVersionRow = {
	definitionId: string;
	name: string;
	version: number | null;
};

export type OverviewReadRepository = {
	getOrganization(scope: CallerScope): Promise<OrganizationReadRow | null>;
	countTaskStatuses(
		scope: CallerScope,
	): Promise<Readonly<Record<string, number>>>;
	countRecentFailures(scope: CallerScope, sinceIso: string): Promise<number>;
	countPendingApprovals(scope: CallerScope, nowIso: string): Promise<number>;
	listActiveRuns(scope: CallerScope, limit: number): Promise<ActiveRunRow[]>;
	listPendingApprovals(
		scope: CallerScope,
		limit: number,
		nowIso: string,
	): Promise<PendingApprovalRow[]>;
	listActivity(scope: CallerScope, limit: number): Promise<ActivityRow[]>;
	listDevices(scope: CallerScope, limit: number): Promise<DeviceRow[]>;
	listRepositories(scope: CallerScope, limit: number): Promise<RepositoryRow[]>;
	listWorkflowVersions(
		scope: CallerScope,
		limit: number,
	): Promise<WorkflowVersionRow[]>;
};

const TASK_STATUS_COUNTS_SQL = `SELECT status, count(*)::int AS count
FROM tasks
WHERE organization_id = $1
GROUP BY status`;

const RECENT_FAILURES_SQL = `SELECT count(*)::int AS count
FROM tasks
WHERE organization_id = $1
  AND status = 'failed'
  AND updated_at >= $2::timestamptz`;

const PENDING_APPROVAL_COUNT_SQL = `SELECT count(*)::int AS count
FROM approvals
WHERE organization_id = $1
  AND status = 'pending'
  AND expires_at > $2::timestamptz`;

const ORGANIZATION_SQL = `SELECT name, slug FROM organizations WHERE id = $1 LIMIT 1`;

const ACTIVE_RUNS_SQL = `SELECT t.id AS task_id, t.branch, t.status, t.created_at, t.updated_at,
	r.external_full_name,
	wr.status AS run_status, wr.started_at AS run_started_at,
	ev.type AS latest_event_type, ev.occurred_at AS latest_event_at
FROM tasks t
JOIN repositories r ON r.id = t.repository_id AND r.organization_id = t.organization_id
LEFT JOIN LATERAL (
	SELECT status, started_at FROM workflow_runs
	WHERE task_id = t.id AND organization_id = $1
	ORDER BY started_at DESC, id DESC LIMIT 1
) wr ON true
LEFT JOIN LATERAL (
	SELECT type, occurred_at FROM run_events
	WHERE task_id = t.id
	ORDER BY occurred_at DESC, id DESC LIMIT 1
) ev ON true
WHERE t.organization_id = $1
  AND t.status = ANY($2::text[])
ORDER BY t.updated_at DESC, t.id DESC
LIMIT $3`;

const PENDING_APPROVALS_SQL = `SELECT a.id AS approval_id, a.task_id, a.action,
	a.requested_by, a.created_at, a.expires_at,
	r.external_full_name, t.branch
FROM approvals a
JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
JOIN repositories r ON r.id = t.repository_id AND r.organization_id = a.organization_id
WHERE a.organization_id = $1
  AND a.status = 'pending'
  AND a.expires_at > $3::timestamptz
ORDER BY a.created_at DESC, a.id DESC
LIMIT $2`;

const ACTIVITY_SQL = `SELECT e.id, e.task_id, e.type, e.actor, e.occurred_at, t.branch
FROM run_events e
JOIN tasks t ON t.id = e.task_id
WHERE t.organization_id = $1
ORDER BY e.occurred_at DESC, e.id DESC
LIMIT $2`;

const DEVICES_SQL = `SELECT id, display_name, status, last_seen_at, created_at
FROM connector_devices
WHERE organization_id = $1
ORDER BY display_name ASC, id ASC
LIMIT $2`;

const REPOSITORIES_SQL = `SELECT id, external_full_name, default_branch
FROM repositories
WHERE organization_id = $1
ORDER BY external_full_name ASC, id ASC
LIMIT $2`;

const WORKFLOW_VERSIONS_SQL = `SELECT d.id AS definition_id, d.name, v.version::int AS version
FROM workflow_definitions d
LEFT JOIN workflow_versions v ON v.definition_id = d.id
WHERE d.organization_id = $1
ORDER BY d.name ASC, d.id ASC, v.version DESC NULLS LAST
LIMIT $2`;

function rowsOf(result: unknown): Record<string, unknown>[] {
	return result as unknown as Record<string, unknown>[];
}

export function createPostgresOverviewRepository(
	sql: PgSql,
): OverviewReadRepository {
	return {
		async getOrganization(scope) {
			const rows = rowsOf(
				await sql.unsafe(ORGANIZATION_SQL, [scope.organizationId]),
			);
			const row = rows[0];
			if (row === undefined) return null;
			return { name: String(row.name), slug: String(row.slug) };
		},
		async countTaskStatuses(scope) {
			const rows = rowsOf(
				await sql.unsafe(TASK_STATUS_COUNTS_SQL, [scope.organizationId]),
			);
			const counts: Record<string, number> = {};
			for (const row of rows) {
				counts[String(row.status)] = numeric(row.count);
			}
			return counts;
		},
		async countRecentFailures(scope, sinceIso) {
			const rows = rowsOf(
				await sql.unsafe(RECENT_FAILURES_SQL, [scope.organizationId, sinceIso]),
			);
			return numeric(rows[0]?.count);
		},
		async countPendingApprovals(scope, nowIso) {
			const rows = rowsOf(
				await sql.unsafe(PENDING_APPROVAL_COUNT_SQL, [
					scope.organizationId,
					nowIso,
				]),
			);
			return numeric(rows[0]?.count);
		},
		async listActiveRuns(scope, limit) {
			const rows = rowsOf(
				await sql.unsafe(ACTIVE_RUNS_SQL, [
					scope.organizationId,
					[...ACTIVE_TASK_STATUSES],
					limit,
				]),
			);
			return rows.map((row) => ({
				taskId: String(row.task_id),
				repositoryName: String(row.external_full_name),
				branch: String(row.branch),
				status: String(row.status),
				createdAt: iso(row.created_at),
				updatedAt: iso(row.updated_at),
				runStatus: row.run_status === null ? null : String(row.run_status),
				runStartedAt: isoOrNull(row.run_started_at),
				latestEventType:
					row.latest_event_type === null ? null : String(row.latest_event_type),
				latestEventAt: isoOrNull(row.latest_event_at),
			}));
		},
		async listPendingApprovals(scope, limit, nowIso) {
			const rows = rowsOf(
				await sql.unsafe(PENDING_APPROVALS_SQL, [
					scope.organizationId,
					limit,
					nowIso,
				]),
			);
			return rows.map((row) => ({
				approvalId: String(row.approval_id),
				taskId: String(row.task_id),
				action: String(row.action),
				requestedBy: String(row.requested_by),
				createdAt: iso(row.created_at),
				expiresAt: iso(row.expires_at),
				repositoryName: String(row.external_full_name),
				branch: String(row.branch),
			}));
		},
		async listActivity(scope, limit) {
			const rows = rowsOf(
				await sql.unsafe(ACTIVITY_SQL, [scope.organizationId, limit]),
			);
			return rows.map((row) => ({
				id: String(row.id),
				taskId: String(row.task_id),
				type: String(row.type),
				actor: String(row.actor),
				occurredAt: iso(row.occurred_at),
				branch: String(row.branch),
			}));
		},
		async listDevices(scope, limit) {
			const rows = rowsOf(
				await sql.unsafe(DEVICES_SQL, [scope.organizationId, limit]),
			);
			return rows.map((row) => ({
				id: String(row.id),
				displayName: String(row.display_name),
				status: String(row.status),
				lastSeenAt: isoOrNull(row.last_seen_at),
				createdAt: iso(row.created_at),
			}));
		},
		async listRepositories(scope, limit) {
			const rows = rowsOf(
				await sql.unsafe(REPOSITORIES_SQL, [scope.organizationId, limit]),
			);
			return rows.map((row) => ({
				id: String(row.id),
				name: String(row.external_full_name),
				defaultBranch: String(row.default_branch),
			}));
		},
		async listWorkflowVersions(scope, limit) {
			const rows = rowsOf(
				await sql.unsafe(WORKFLOW_VERSIONS_SQL, [scope.organizationId, limit]),
			);
			return rows.map((row) => ({
				definitionId: String(row.definition_id),
				name: String(row.name),
				version: row.version === null ? null : numeric(row.version),
			}));
		},
	};
}

function deviceStatus(value: string): DeviceHealthRow["status"] {
	return value === "active" || value === "revoked" ? value : "pending";
}

/** Pure mapping helpers; exported for the mocked-repository tests. */
export function mapActiveRun(row: ActiveRunRow, now: Date): ActiveRunSummary {
	const startedAt = row.runStartedAt ?? row.createdAt;
	return {
		taskId: row.taskId,
		repositoryName: row.repositoryName,
		branch: row.branch,
		status: row.status,
		runStatus: row.runStatus,
		stage: row.latestEventType,
		stageLabel: eventTypeLabel(row.latestEventType),
		startedAt,
		elapsedMs: elapsedMsSince(startedAt, now),
		latestUpdateAt: row.latestEventAt ?? row.updatedAt,
	};
}

export function mapPendingApproval(
	row: PendingApprovalRow,
): PendingApprovalPreview {
	return {
		approvalId: row.approvalId,
		taskId: row.taskId,
		action: row.action,
		actionLabel: approvalActionLabel(row.action),
		risk: riskForAction(row.action),
		repositoryName: row.repositoryName,
		branch: row.branch,
		requestedBy: row.requestedBy,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
	};
}

export function mapActivity(row: ActivityRow): ActivityItem {
	return {
		id: row.id,
		taskId: row.taskId,
		type: row.type,
		typeLabel: eventTypeLabel(row.type),
		actor: row.actor,
		occurredAt: row.occurredAt,
		branch: row.branch,
	};
}

export function mapDevice(row: DeviceRow): DeviceHealthRow {
	return {
		id: row.id,
		displayName: row.displayName,
		status: deviceStatus(row.status),
		lastSeenAt: row.lastSeenAt,
		createdAt: row.createdAt,
	};
}

export function groupWorkflowOptions(
	rows: readonly WorkflowVersionRow[],
): WorkflowOption[] {
	const workflows = new Map<string, WorkflowOption>();
	for (const row of rows) {
		let workflow = workflows.get(row.definitionId);
		if (workflow === undefined) {
			workflow = { id: row.definitionId, name: row.name, versions: [] };
			workflows.set(row.definitionId, workflow);
		}
		if (row.version !== null && !workflow.versions.includes(row.version)) {
			workflow.versions.push(row.version);
		}
	}
	return [...workflows.values()]
		.map((workflow) => ({
			...workflow,
			versions: [...workflow.versions].sort((left, right) => right - left),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export type OverviewReadService = {
	readOverview(scope: CallerScope, now?: Date): Promise<OverviewSnapshot>;
	readSubmitOptions(scope: CallerScope): Promise<SubmitOptions>;
};

export function createOverviewReadService(
	repository: OverviewReadRepository,
): OverviewReadService {
	return {
		async readOverview(scope, now = new Date()) {
			const [
				organization,
				statusCounts,
				pendingApprovals,
				recentFailures,
				activeRuns,
				pendingPreviews,
				activity,
				devices,
			] = await Promise.all([
				repository.getOrganization(scope),
				repository.countTaskStatuses(scope),
				repository.countPendingApprovals(scope, now.toISOString()),
				repository.countRecentFailures(
					scope,
					windowStartIso(now, FAILURE_WINDOW_HOURS),
				),
				repository.listActiveRuns(scope, OVERVIEW_LIMITS.activeRuns),
				repository.listPendingApprovals(
					scope,
					OVERVIEW_LIMITS.pendingApprovals,
					now.toISOString(),
				),
				repository.listActivity(scope, OVERVIEW_LIMITS.activity),
				repository.listDevices(scope, OVERVIEW_LIMITS.devices),
			]);

			const organizationContext: OrganizationContext | null =
				organization === null
					? null
					: {
							id: scope.organizationId,
							name: organization.name,
							slug: organization.slug,
						};

			return {
				generatedAt: now.toISOString(),
				organization: organizationContext,
				metrics: deriveOverviewMetrics({
					statusCounts,
					pendingApprovals,
					recentFailures,
				}),
				activeRuns: activeRuns.map((row) => mapActiveRun(row, now)),
				pendingApprovals: pendingPreviews.map(mapPendingApproval),
				activity: activity.map(mapActivity),
				devices: devices.map(mapDevice),
			};
		},
		async readSubmitOptions(scope) {
			const [repositories, workflowRows] = await Promise.all([
				repository.listRepositories(scope, OVERVIEW_LIMITS.submitRepositories),
				repository.listWorkflowVersions(
					scope,
					OVERVIEW_LIMITS.submitWorkflowRows,
				),
			]);
			const repositoryOptions: RepositoryOption[] = repositories.map((row) => ({
				id: row.id,
				name: row.name,
				defaultBranch: row.defaultBranch,
			}));
			return {
				repositories: repositoryOptions,
				workflows: groupWorkflowOptions(workflowRows),
			};
		},
	};
}

/**
 * Server-function entry point for the Overview page. `task:read` gates the
 * read; `scope.organizationId` is the only tenancy input.
 */
export function readOverviewSnapshot(): Promise<UiResult<OverviewSnapshot>> {
	return uiRead("task:read", (scope, sql) =>
		createOverviewReadService(
			createPostgresOverviewRepository(sql),
		).readOverview(scope, new Date()),
	);
}

/** Repository and workflow choices for the Submit form. */
export function readSubmitOptions(): Promise<UiResult<SubmitOptions>> {
	return uiRead("task:read", (scope, sql) =>
		createOverviewReadService(
			createPostgresOverviewRepository(sql),
		).readSubmitOptions(scope),
	);
}
