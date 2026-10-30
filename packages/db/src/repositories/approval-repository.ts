import type { ApprovalId, OrganizationId, TaskId } from "@isolate/shared";
import type { PgSql } from "../client";
import type { ApprovalRow, ApprovalStatus } from "../schema";
import { clampPageLimit } from "./pagination";
import { requireNonEmpty } from "./task-repository";

/**
 * Postgres (Neon) approval store.
 *
 * Two decision paths share this table:
 * - `decide` with `payloadSha256` (wave 7): the worker/agent path, bound to the
 *   EXACT payload hash the approval was requested with.
 * - `decide` with `expectedStatus`/`decision` (wave 8): the human decision on a
 *   listed approval. It requires the row to still be `pending` and writes the
 *   `audit_events` row in the SAME transaction as the decision.
 *
 * Both paths require the row to still be `pending` and unexpired, are
 * tenant-scoped on `organization_id` AND `task_id`, and never change
 * `decided_by`/`decided_at` types (text / timestamptz).
 */

const APPROVAL_COLUMNS = `id, organization_id, task_id, workflow_run_id, action, payload_sha256, status, requested_by, decided_by, decided_at, expires_at, created_at`;
const APPROVAL_COLUMNS_A = `a.id, a.organization_id, a.task_id, a.workflow_run_id, a.action, a.payload_sha256, a.status, a.requested_by, a.decided_by, a.decided_at, a.expires_at, a.created_at`;

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
	// Single-statement payload-bound decision: every precondition is in WHERE.
	// $1=approvalId, $2=payloadSha256, $3=decidedBy, $4='approve'|'reject'.
	decide: `UPDATE approvals SET
			status = (CASE WHEN $4 = 'approve' THEN 'approved' ELSE 'rejected' END),
			decided_by = $3,
			decided_at = now()
		WHERE id = $1 AND status = 'pending' AND payload_sha256 = $2
		  AND expires_at > now()
		RETURNING ${APPROVAL_COLUMNS}`,
	// Human decision: tenant-scoped through both the approval row and its task.
	// $1=approvalId, $2=organizationId, $3=taskId, $4='approved'|'rejected',
	// $5=decidedBy.
	decidePending: `UPDATE approvals a SET
			status = $4,
			decided_by = $5,
			decided_at = now()
		FROM tasks t
		WHERE a.id = $1
		  AND a.organization_id = $2
		  AND a.task_id = $3
		  AND a.status = 'pending'
		  AND a.expires_at > now()
		  AND t.id = a.task_id
		  AND t.organization_id = $2
		RETURNING ${APPROVAL_COLUMNS_A}`,
	getTenantScoped: `SELECT ${APPROVAL_COLUMNS} FROM approvals
		WHERE id = $1 AND organization_id = $2 AND task_id = $3`,
	insertDecisionAudit: `INSERT INTO audit_events (
			organization_id, actor_id, actor_kind, action, target, details, created_at
		) VALUES ($1, $2, 'user', 'approval.decide', $3, $4::text::jsonb, now())
		RETURNING id`,
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
	// Newest first; the join makes an orphaned/foreign task unreadable even if
	// an approval row leaked across tenants.
	listByTask: `SELECT ${APPROVAL_COLUMNS_A} FROM approvals a
		JOIN tasks t ON t.id = a.task_id AND t.organization_id = a.organization_id
		WHERE a.organization_id = $1 AND a.task_id = $2
		ORDER BY a.created_at DESC, a.id DESC
		LIMIT $3`,
} as const;

export type ApproveOrFailCode =
	| "NOT_FOUND"
	| "APPROVAL_EXPIRED"
	| "PAYLOAD_CHANGED"
	| "ALREADY_DECIDED";

/** Refusal codes for the wave-8 human decision; both exist in the platform vocabulary. */
export type ApprovalDecisionFailCode = "NOT_FOUND" | "CONFLICT";

export type ApprovalDecisionInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	approvalId: ApprovalId;
	/** Optimistic guard: the row must still be pending. */
	expectedStatus: "pending";
	decision: "approved" | "rejected";
	decidedBy: string;
};

export type ApprovalDecisionResult =
	| { ok: true; approval: ApprovalRow }
	| { ok: false; code: ApprovalDecisionFailCode };

export type PayloadBoundDecisionInput = {
	approvalId: ApprovalId;
	decide: "approve" | "reject";
	payloadSha256: string;
	decidedBy: string;
};

export type PayloadBoundDecisionResult =
	| { ok: true; approval: ApprovalRow }
	| { ok: false; code: ApproveOrFailCode };

export type ListApprovalsByTaskInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	/** Page size; defaults to 100 and is clamped to 500. */
	limit?: number;
};

/**
 * Contract for the payload-bound approval store. Declared in this module so
 * the Postgres implementation and test fakes share one in-scope symbol.
 */
export interface ApprovalRepository {
	request(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		workflowRunId: string | null;
		action: string;
		payloadSha256: string;
		requestedBy: string;
		expiresInSeconds: number;
	}): Promise<ApprovalRow>;
	get(approvalId: ApprovalId): Promise<ApprovalRow | null>;
	/** Wave-8 human decision on a pending approval; audited in-transaction. */
	decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
	/** Wave-7 payload-bound decision (worker/agent resume path). */
	decide(input: PayloadBoundDecisionInput): Promise<PayloadBoundDecisionResult>;
	expirePending(ms: number): Promise<number>;
	expirePendingForTask(taskId: TaskId): Promise<number>;
	listPending(organizationId: OrganizationId): Promise<ApprovalRow[]>;
	/** Decisions (and requests) for one task, newest first, tenant-scoped. */
	listByTask(input: ListApprovalsByTaskInput): Promise<ApprovalRow[]>;
}

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

/**
 * Pure precondition for the wave-8 human decision. Any decided row, and any
 * pending row whose `expires_at` has passed, is `CONFLICT`; a row that does
 * not exist inside the caller's organization/task is `NOT_FOUND`. Shared by
 * the driver's failure classification, the audit boundary and the fake.
 */
export function evaluateApprovalDecision(input: {
	found: boolean;
	currentStatus: ApprovalStatus | null;
	expiresAtMs: number | null;
	nowMs: number;
	expectedStatus: "pending";
}): { ok: true } | { ok: false; code: ApprovalDecisionFailCode } {
	if (!input.found || input.currentStatus === null) {
		return { ok: false, code: "NOT_FOUND" };
	}
	if (input.currentStatus !== input.expectedStatus) {
		return { ok: false, code: "CONFLICT" };
	}
	if (input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs) {
		return { ok: false, code: "CONFLICT" };
	}
	return { ok: true };
}

export class PostgresApprovalRepository implements ApprovalRepository {
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
		if (
			!Number.isInteger(input.expiresInSeconds) ||
			input.expiresInSeconds < 1
		) {
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

	async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
	async decide(
		input: PayloadBoundDecisionInput,
	): Promise<PayloadBoundDecisionResult>;
	async decide(
		input: ApprovalDecisionInput | PayloadBoundDecisionInput,
	): Promise<ApprovalDecisionResult | PayloadBoundDecisionResult> {
		if ("decision" in input) {
			return this.decidePending(input);
		}
		return this.decidePayloadBound(input);
	}

	private async decidePayloadBound(
		input: PayloadBoundDecisionInput,
	): Promise<PayloadBoundDecisionResult> {
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

	private async decidePending(
		input: ApprovalDecisionInput,
	): Promise<ApprovalDecisionResult> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		requireNonEmpty(input.approvalId, "approvalId");
		requireNonEmpty(input.decidedBy, "decidedBy");
		if (input.expectedStatus !== "pending") {
			throw new Error("expectedStatus must be 'pending'");
		}
		if (input.decision !== "approved" && input.decision !== "rejected") {
			throw new Error("decision must be 'approved' or 'rejected'");
		}
		// One transaction: the decision and its audit row commit (or roll
		// back) together. A decision can never be recorded without the trail.
		return this.sql.begin<ApprovalDecisionResult>(async (transaction) => {
			const connection = transaction as unknown as PgSql;
			const rows = (await connection.unsafe(STMT.decidePending, [
				input.approvalId,
				input.organizationId,
				input.taskId,
				input.decision,
				input.decidedBy,
			])) as unknown as RecordingRow[];
			if (rows.length > 0) {
				const approval = mapApprovalRow(rows[0]);
				await connection.unsafe(STMT.insertDecisionAudit, [
					approval.organization_id,
					input.decidedBy,
					`approval:${approval.id}`,
					JSON.stringify({
						approvalId: approval.id,
						taskId: approval.task_id,
						action: approval.action,
						decision: input.decision,
					}),
				]);
				return { ok: true, approval };
			}
			const current = (await connection.unsafe(STMT.getTenantScoped, [
				input.approvalId,
				input.organizationId,
				input.taskId,
			])) as unknown as RecordingRow[];
			if (current.length === 0) {
				return { ok: false, code: "NOT_FOUND" };
			}
			const row = mapApprovalRow(current[0]);
			const outcome = evaluateApprovalDecision({
				found: true,
				currentStatus: row.status,
				expiresAtMs: row.expires_at.getTime(),
				nowMs: Date.now(),
				expectedStatus: input.expectedStatus,
			});
			if (outcome.ok) {
				// Preconditions hold but the guarded UPDATE matched nothing:
				// a concurrent decider won the race.
				return { ok: false, code: "CONFLICT" };
			}
			return outcome;
		});
	}

	async expirePending(ms: number): Promise<number> {
		if (!Number.isFinite(ms) || ms < 0) {
			throw new Error(
				"ms must be a non-negative age threshold in milliseconds",
			);
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

	async listByTask(input: ListApprovalsByTaskInput): Promise<ApprovalRow[]> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		const rows = (await this.sql.unsafe(STMT.listByTask, [
			input.organizationId,
			input.taskId,
			clampPageLimit(input.limit),
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
