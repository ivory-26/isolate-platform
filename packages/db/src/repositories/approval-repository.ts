import type { ApprovalId, OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { ApprovalRow, ApprovalStatus } from "../schema";
import type {
	ApprovalRepository as ApprovalRepositoryContract,
} from "./approval-repository";

/**
 * Postgres (Neon) approval store.
 *
 * A decision is recorded only when, atomically in a single statement:
 * - the approval row exists,
 * - the caller supplies the EXACT `payload_sha256` the approval was requested
 *   with (a changed payload invalidates the approval),
 * - the approval is still `pending`, and
 * - it has not expired (checked inside the same statement against now()).
 */

const APPROVAL_COLUMNS = `id, organization_id, task_id, workflow_run_id, action, payload_sha256, status, requested_by, decided_by, decided_at, expires_at, created_at`;

const STMT = {
	insert: `INSERT INTO approvals (
		organization_id, task_id, workflow_run_id, action, payload_sha256,
		status, requested_by, decided_by, decided_at, expires_at, created_at
	) VALUES (
		$1, $2, $3::uuid, $4, $5, 'pending', $6, NULL, NULL,
		now() + make_interval(secs => $7::int), now()
	)
	RETURNING ${APPROVAL_COLUMNS}`,
	get: `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1`,
	// Single-statement decision: every precondition is part of the WHERE.
	// $1=approvalId, $2=payloadSha256, $3=decidedBy, $4='approve'|'reject'.
	decide: `UPDATE approvals SET
			status = (CASE WHEN $4 = 'approve' THEN 'approved' ELSE 'rejected' END),
			decided_by = $3,
			decided_at = now()
		WHERE id = $1 AND status = 'pending' AND payload_sha256 = $2
		  AND expires_at > now()
		RETURNING ${APPROVAL_COLUMNS}`,
	expireByAge: `UPDATE approvals SET status = 'expired'
		WHERE status = 'pending'
		  AND (expires_at <= now()
			   OR created_at <= now()
			       - (($1::double precision / 1000.0) * interval '1 second'))
		RETURNING id`,
	expirePendingForTask: `UPDATE approvals SET status = 'expired'
		WHERE task_id = $1 AND status = 'pending'
		RETURNING id`,
	listPending: `SELECT ${APPROVAL_COLUMNS} FROM approvals
		WHERE organization_id = $1 AND status = 'pending'
		ORDER BY created_at DESC`,
} as const;

export type ApproveOrFailCode =
	| "NOT_FOUND"
	| "APPROVAL_EXPIRED"
	| "PAYLOAD_CHANGED"
	| "ALREADY_DECIDED";

/**
 * Pure decision precondition used by the driver's failure classification and
 * by contract-test fakes. Emulates the SQL WHERE + status mapping.
 */
export function evaluateDecisionOutcome(input: {
	currentStatus: ApprovalStatus | null;
	expiresAtMs: number | null;
	nowMs: number;
	payloadSha256Match: boolean;
}): { ok: true } | { ok: false; code: ApproveOrFailCode } {
	if (input.currentStatus === null) {
		return { ok: false, code: "NOT_FOUND" };
	}
	if (input.currentStatus === "expired") {
		return { ok: false, code: "APPROVAL_EXPIRED" };
	}
	if (input.currentStatus !== "pending") {
		return { ok: false, code: "ALREADY_DECIDED" };
	}
	if (!input.payloadSha256Match) {
		return { ok: false, code: "PAYLOAD_CHANGED" };
	}
	if (input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs) {
		return { ok: false, code: "APPROVAL_EXPIRED" };
	}
	return { ok: true };
}

export class PostgresApprovalRepository implements ApprovalRepositoryContract {
	constructor(private readonly sql: PgSql) {}

	async request(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		workflowRunId: string | null;
		action: string;
		payloadSha256: string;
		requestedBy: string;
		expiresInSeconds: number;
	}): Promise<ApprovalRow> {
		if (!isSha256Hex(input.payloadSha256)) {
			throw new Error("payloadSha256 must be a 64-char lowercase hex digest");
		}
		if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1) {
			throw new Error("expiresInSeconds must be a positive integer");
		}
		const rows = (await this.sql.unsafe(STMT.insert, [
			input.organizationId,
			input.taskId,
			input.workflowRunId,
			input.action,
			input.payloadSha256,
			input.requestedBy,
			input.expiresInSeconds,
		])) as unknown as RecordingRow[];
		if (rows.length === 0) {
			throw new Error("approval insert returned no row");
		}
		return mapApprovalRow(rows[0]);
	}

	async get(approvalId: ApprovalId): Promise<ApprovalRow | null> {
		const rows = (await this.sql.unsafe(STMT.get, [
			approvalId,
		])) as unknown as RecordingRow[];
		return rows.length === 0 ? null : mapApprovalRow(rows[0]);
	}

	async decide(input: {
		approvalId: ApprovalId;
		decide: "approve" | "reject";
		payloadSha256: string;
		decidedBy: string;
	}): Promise<
		| { ok: true; approval: ApprovalRow }
		| { ok: false; code: ApproveOrFailCode }
	> {
		if (!isSha256Hex(input.payloadSha256)) {
			throw new Error("payloadSha256 must be a 64-char lowercase hex digest");
		}
		const rows = (await this.sql.unsafe(STMT.decide, [
			input.approvalId,
			input.payloadSha256,
			input.decidedBy,
			input.decide,
		])) as unknown as RecordingRow[];
		if (rows.length > 0) {
			return { ok: true, approval: mapApprovalRow(rows[0]) };
		}
		const currentRows = (await this.sql.unsafe(STMT.get, [
			input.approvalId,
		])) as unknown as RecordingRow[];
		if (currentRows.length === 0) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const row = mapApprovalRow(currentRows[0]);
		const failure = evaluateDecisionOutcome({
			currentStatus: row.status,
			expiresAtMs: row.expires_at.getTime(),
			nowMs: Date.now(),
			payloadSha256Match: row.payload_sha256 === input.payloadSha256,
		});
		if (failure.ok) {
			// Preconditions now pass but the atomic UPDATE saw none match: a
			// concurrent decider or a just-crossed expiry boundary got there
			// first — surface as an already-decided-style failure.
			return { ok: false, code: "ALREADY_DECIDED" };
		}
		return failure;
	}

	async expirePending(ms: number): Promise<number> {
		if (!Number.isFinite(ms) || ms < 0) {
			throw new Error("ms must be a non-negative age threshold in milliseconds");
		}
		const rows = (await this.sql.unsafe(STMT.expireByAge, [
			ms,
		])) as unknown as Record<string, unknown>[];
		return rows.length;
	}

	async expirePendingForTask(taskId: TaskId): Promise<number> {
		const rows = (await this.sql.unsafe(STMT.expirePendingForTask, [
			taskId,
		])) as unknown as Record<string, unknown>[];
		return rows.length;
	}

	async listPending(organizationId: OrganizationId): Promise<ApprovalRow[]> {
		const rows = (await this.sql.unsafe(STMT.listPending, [
			organizationId,
		])) as unknown as RecordingRow[];
		return rows.map(mapApprovalRow);
	}
}

function isSha256Hex(value: string): boolean {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

type ApprovalDbRow = Record<string, unknown>;

function mapApprovalRow(row: ApprovalDbRow): ApprovalRow {
	return {
		id: row.id as ApprovalRow["id"],
		organization_id: row.organization_id as ApprovalRow["organization_id"],
		task_id: row.task_id as ApprovalRow["task_id"],
		workflow_run_id: row.workflow_run_id as ApprovalRow["workflow_run_id"],
		action: row.action as string,
		payload_sha256: row.payload_sha256 as string,
		status: row.status as ApprovalStatus,
		requested_by: row.requested_by as string,
		decided_by: row.decided_by as string | null,
		decided_at: row.decided_at as Date | null,
		expires_at: row.expires_at as Date,
		created_at: row.created_at as Date,
	};
}

type RecordingRow = Record<string, unknown>;
