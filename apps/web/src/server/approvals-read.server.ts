import "@tanstack/react-start/server-only";
import { type PgSql, parseJsonbColumn } from "@isolate/db";
import {
	APPROVAL_LIMITS,
	type ApprovalItem,
	type ApprovalStatusValue,
	type ApprovalsSnapshot,
	approvalActionLabel,
	buildApprovalTarget,
	effectiveApprovalStatus,
	riskForAction,
} from "../features/approvals/contracts";
import type { UiResult } from "../features/ui/contracts";
import type { CallerScope } from "./task-service.server";
import { iso, isoOrNull, uiRead } from "./ui-runtime.server";

/**
 * Tenant-scoped Approvals read model.
 *
 * The browser receives the exact action, the task/repository/branch target,
 * the payload hash, requester, timestamps and a fixed impact classification.
 * It never receives the stored event payload, credentials or driver errors.
 */

export type ApprovalReadRow = {
	id: string;
	taskId: string;
	action: string;
	payloadSha256: string;
	status: string;
	requestedBy: string;
	decidedBy: string | null;
	decidedAt: string | null;
	expiresAt: string;
	createdAt: string;
	taskStatus: string;
	repositoryName: string;
	branch: string;
	/** Validated later by `buildApprovalTarget`; may be any stored JSON. */
	eventData: unknown;
};

export type ApprovalReadRepository = {
	/** Pending rows, newest first. May include rows past their expiry. */
	listPending(scope: CallerScope, limit: number): Promise<ApprovalReadRow[]>;
	/** Rows with a stored non-pending status, newest decision first. */
	listDecided(scope: CallerScope, limit: number): Promise<ApprovalReadRow[]>;
};

const PENDING_SQL = `SELECT a.id, a.task_id, a.action, a.payload_sha256, a.status,
	a.requested_by, a.decided_by, a.decided_at, a.expires_at, a.created_at,
	t.branch, t.status AS task_status, r.external_full_name,
	ev.data AS event_data
FROM approvals a
JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
JOIN repositories r ON r.id = t.repository_id AND r.organization_id = a.organization_id
LEFT JOIN LATERAL (
	SELECT e.data
	FROM run_events e
	WHERE e.task_id = a.task_id
	  AND e.type = 'approval.requested'
	  AND (
		(e.data ->> 'approvalId') = a.id::text
		OR ((e.data ->> 'payloadSha256') = a.payload_sha256
			AND (e.data ->> 'action') = a.action)
	  )
	ORDER BY e.occurred_at DESC, e.id DESC
	LIMIT 1
) ev ON true
WHERE a.organization_id = $1 AND a.status = 'pending'
ORDER BY a.created_at DESC, a.id DESC
LIMIT $2`;

const DECIDED_SQL = `SELECT a.id, a.task_id, a.action, a.payload_sha256, a.status,
	a.requested_by, a.decided_by, a.decided_at, a.expires_at, a.created_at,
	t.branch, t.status AS task_status, r.external_full_name,
	ev.data AS event_data
FROM approvals a
JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
JOIN repositories r ON r.id = t.repository_id AND r.organization_id = a.organization_id
LEFT JOIN LATERAL (
	SELECT e.data
	FROM run_events e
	WHERE e.task_id = a.task_id
	  AND e.type = 'approval.requested'
	  AND (
		(e.data ->> 'approvalId') = a.id::text
		OR ((e.data ->> 'payloadSha256') = a.payload_sha256
			AND (e.data ->> 'action') = a.action)
	  )
	ORDER BY e.occurred_at DESC, e.id DESC
	LIMIT 1
) ev ON true
WHERE a.organization_id = $1 AND a.status <> 'pending'
ORDER BY coalesce(a.decided_at, a.expires_at, a.created_at) DESC, a.id DESC
LIMIT $2`;

function mapRow(row: Record<string, unknown>): ApprovalReadRow {
	return {
		id: String(row.id),
		taskId: String(row.task_id),
		action: String(row.action),
		payloadSha256: String(row.payload_sha256),
		status: String(row.status),
		requestedBy: String(row.requested_by),
		decidedBy: row.decided_by === null ? null : String(row.decided_by),
		decidedAt: isoOrNull(row.decided_at),
		expiresAt: iso(row.expires_at),
		createdAt: iso(row.created_at),
		taskStatus: String(row.task_status),
		repositoryName: String(row.external_full_name),
		branch: String(row.branch),
		// jsonb may arrive parsed or as a raw string through a bound parameter.
		eventData: parseJsonbColumn<unknown>(row.event_data),
	};
}

export function createPostgresApprovalReadRepository(
	sql: PgSql,
): ApprovalReadRepository {
	return {
		async listPending(scope, limit) {
			const rows = (await sql.unsafe(PENDING_SQL, [
				scope.organizationId,
				limit,
			])) as unknown as Record<string, unknown>[];
			return rows.map(mapRow);
		},
		async listDecided(scope, limit) {
			const rows = (await sql.unsafe(DECIDED_SQL, [
				scope.organizationId,
				limit,
			])) as unknown as Record<string, unknown>[];
			return rows.map(mapRow);
		},
	};
}

function storedStatus(value: string): ApprovalStatusValue {
	return value === "approved" || value === "rejected" || value === "expired"
		? value
		: "pending";
}

/** Pure row-to-item mapping; exported for the mocked-repository tests. */
export function mapApprovalItem(row: ApprovalReadRow, now: Date): ApprovalItem {
	const rawStatus = storedStatus(row.status);
	return {
		id: row.id,
		taskId: row.taskId,
		action: row.action,
		actionLabel: approvalActionLabel(row.action),
		rawStatus,
		status: effectiveApprovalStatus(rawStatus, row.expiresAt, now),
		payloadSha256: row.payloadSha256,
		requestedBy: row.requestedBy,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
		taskStatus: row.taskStatus,
		repositoryName: row.repositoryName,
		branch: row.branch,
		target: buildApprovalTarget({
			action: row.action,
			repositoryName: row.repositoryName,
			branch: row.branch,
			eventData: row.eventData,
		}),
		risk: riskForAction(row.action),
	};
}

export type ApprovalsReadService = {
	readApprovals(scope: CallerScope, now?: Date): Promise<ApprovalsSnapshot>;
};

export function createApprovalsReadService(
	repository: ApprovalReadRepository,
): ApprovalsReadService {
	return {
		async readApprovals(scope, now = new Date()) {
			const [pendingRows, decidedRows] = await Promise.all([
				repository.listPending(scope, APPROVAL_LIMITS.pending),
				repository.listDecided(scope, APPROVAL_LIMITS.decided),
			]);

			const pending: ApprovalItem[] = [];
			const closed: ApprovalItem[] = [];
			for (const row of pendingRows) {
				const item = mapApprovalItem(row, now);
				if (item.status === "pending") pending.push(item);
				else closed.push(item);
			}
			for (const row of decidedRows) {
				closed.push(mapApprovalItem(row, now));
			}

			closed.sort((left, right) =>
				(right.decidedAt ?? right.expiresAt).localeCompare(
					left.decidedAt ?? left.expiresAt,
				),
			);

			return {
				pending: pending.slice(0, APPROVAL_LIMITS.pending),
				decided: closed.slice(0, APPROVAL_LIMITS.decided),
				generatedAt: now.toISOString(),
			};
		},
	};
}

/**
 * Server-function entry point. `task:read` is checked before storage; the
 * caller's organization is the only tenancy input.
 */
export function readApprovalsSnapshot(): Promise<UiResult<ApprovalsSnapshot>> {
	return uiRead("task:read", (scope, sql) =>
		createApprovalsReadService(
			createPostgresApprovalReadRepository(sql),
		).readApprovals(scope, new Date()),
	);
}
