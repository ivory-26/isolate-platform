import {
	asJobId,
	asTaskId,
	isTerminalTaskStatus,
	type JobId,
	type OrganizationId,
	type TaskId,
	type TaskStatus,
	type UsageRecordInput,
} from "@isolate/shared";
import type {
	ApprovalRepository,
	ApproveOrFailCode,
} from "../repositories/approval-repository";
import { evaluateDecisionOutcome } from "../repositories/approval-repository";
import {
	ackFailOutcome,
	type JobRow,
	type JobStatus,
	type QueueRepository,
} from "../repositories/queue-repository";
import {
	guardTransition,
	requireNonEmpty,
	requireNonNegativeInt,
	requirePositiveInt,
	requireStringArray,
	type TaskRepository,
	type TaskTransitionFailureCode,
} from "../repositories/task-repository";
import {
	aggregateUsageRows,
	costUsdToMicros,
	formatCostMicros,
	type UsageRepository,
	type UsageTotals,
	validateUsageInput,
} from "../repositories/usage-repository";
import type { ApprovalRow, TaskRow, UsageRecordRow } from "../schema";

/**
 * In-memory implementations of the repository contracts. They embed the SAME
 * pure decision helpers the Postgres drivers use (guardTransition,
 * evaluateDecisionOutcome, ackFailOutcome), so driver and fake cannot drift
 * on legality/expiry/dead-letter math. Test fakes stay in-scope for the
 * contract tests that do not require a database.
 */

function newUuid(): string {
	return crypto.randomUUID();
}

type TaskCreateInput = Parameters<TaskRepository["create"]>[0];

export class InMemoryTaskRepository implements TaskRepository {
	private readonly rows = new Map<TaskId, TaskRow>();

	async create(input: TaskCreateInput): Promise<TaskRow> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.repositoryId, "repositoryId");
		requireNonEmpty(input.branch, "branch");
		requireNonEmpty(input.idempotencyKey, "idempotencyKey");
		requireNonEmpty(input.createdBy, "createdBy");
		requirePositiveInt(input.budgetLimits.maxAgentTurns, "maxAgentTurns");
		requireNonNegativeInt(
			input.budgetLimits.maxRepairAttempts,
			"maxRepairAttempts",
		);
		requirePositiveInt(input.budgetLimits.maxDurationMs, "maxDurationMs");
		const goal = input.goal ?? "";
		if (typeof goal !== "string") {
			throw new Error("goal must be a string");
		}
		const acceptanceCriteria = requireStringArray(
			input.acceptanceCriteria ?? [],
			"acceptanceCriteria",
		);
		const fileOwnership = requireStringArray(
			input.fileOwnership ?? [],
			"fileOwnership",
		);

		for (const row of this.rows.values()) {
			if (
				row.organization_id === input.organizationId &&
				row.idempotency_key === input.idempotencyKey
			) {
				return row;
			}
		}
		const id = asTaskId(newUuid());
		const now = new Date();
		const row: TaskRow = {
			id,
			organization_id: input.organizationId,
			repository_id: input.repositoryId as TaskRow["repository_id"],
			worktree: input.branch,
			branch: input.branch,
			status: "queued",
			idempotency_key: input.idempotencyKey,
			// Row JSON keys are snake_case, matching the DB jsonb contract.
			budget_limits: {
				max_agent_turns: input.budgetLimits.maxAgentTurns,
				max_repair_attempts: input.budgetLimits.maxRepairAttempts,
				max_duration_ms: input.budgetLimits.maxDurationMs,
			},
			goal,
			acceptance_criteria: acceptanceCriteria,
			file_ownership: fileOwnership,
			created_by: input.createdBy as TaskRow["created_by"],
			created_at: now,
			updated_at: now,
		};
		this.rows.set(id, row);
		return { ...row };
	}

	async get(taskId: TaskId): Promise<TaskRow | null> {
		const row = this.rows.get(taskId);
		return row ? { ...row } : null;
	}

	async getByIdempotencyKey(
		organizationId: OrganizationId,
		idempotencyKey: string,
	): Promise<TaskRow | null> {
		for (const row of this.rows.values()) {
			if (
				row.organization_id === organizationId &&
				row.idempotency_key === idempotencyKey
			) {
				return { ...row };
			}
		}
		return null;
	}

	async listByStatus(status: TaskStatus, limit: number): Promise<TaskRow[]> {
		const clamped = Math.max(1, Math.min(500, Math.floor(limit)));
		const out: TaskRow[] = [];
		for (const row of this.rows.values()) {
			if (row.status === status) {
				out.push({ ...row });
				if (out.length >= clamped) {
					break;
				}
			}
		}
		return out.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
	}

	async transition(input: {
		taskId: TaskId;
		to: TaskStatus;
		expectedStatus: TaskStatus;
	}): Promise<
		{ ok: true; task: TaskRow } | { ok: false; code: TaskTransitionFailureCode }
	> {
		const row = this.rows.get(input.taskId);
		if (!row) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const guard = guardTransition(input.expectedStatus, row.status, input.to);
		if (!guard.ok) {
			return guard;
		}
		row.status = input.to;
		row.updated_at = new Date();
		return { ok: true, task: { ...row } };
	}

	async listExpiredOverBudget(): Promise<TaskRow[]> {
		const now = Date.now();
		const out: TaskRow[] = [];
		for (const row of this.rows.values()) {
			const deadline =
				row.created_at.getTime() + row.budget_limits.max_duration_ms;
			if (!isTerminalTaskStatus(row.status) && deadline < now) {
				out.push({ ...row });
			}
		}
		return out;
	}
}

type ApprovalRequestInput = Parameters<ApprovalRepository["request"]>[0];

export class InMemoryApprovalRepository implements ApprovalRepository {
	private readonly rows = new Map<string, ApprovalRow>();

	async request(input: ApprovalRequestInput): Promise<ApprovalRow> {
		if (!isSha256Hex(input.payloadSha256)) {
			throw new Error("payloadSha256 must be a 64-char lowercase hex digest");
		}
		if (
			!Number.isInteger(input.expiresInSeconds) ||
			input.expiresInSeconds < 1
		) {
			throw new Error("expiresInSeconds must be a positive integer");
		}
		const now = new Date();
		const row: ApprovalRow = {
			id: newUuid() as ApprovalRow["id"],
			organization_id: input.organizationId,
			task_id: input.taskId,
			workflow_run_id: input.workflowRunId as ApprovalRow["workflow_run_id"],
			action: input.action,
			payload_sha256: input.payloadSha256,
			status: "pending",
			requested_by: input.requestedBy,
			decided_by: null,
			decided_at: null,
			expires_at: new Date(now.getTime() + input.expiresInSeconds * 1000),
			created_at: now,
		};
		this.rows.set(row.id, row);
		return { ...row };
	}

	async get(approvalId: string): Promise<ApprovalRow | null> {
		const row = this.rows.get(approvalId);
		return row ? cloneApproval(row) : null;
	}

	async decide(input: {
		approvalId: string;
		decide: "approve" | "reject";
		payloadSha256: string;
		decidedBy: string;
	}): Promise<
		{ ok: true; approval: ApprovalRow } | { ok: false; code: ApproveOrFailCode }
	> {
		if (!isSha256Hex(input.payloadSha256)) {
			throw new Error("payloadSha256 must be a 64-char lowercase hex digest");
		}
		const row = this.rows.get(input.approvalId);
		if (!row) {
			return { ok: false, code: "NOT_FOUND" };
		}
		const now = Date.now();
		const outcome = evaluateDecisionOutcome({
			currentStatus: row.status,
			expiresAtMs: row.expires_at.getTime(),
			nowMs: now,
			payloadSha256Match: row.payload_sha256 === input.payloadSha256,
		});
		if (!outcome.ok) {
			return outcome;
		}
		row.status = input.decide === "approve" ? "approved" : "rejected";
		row.decided_by = input.decidedBy;
		row.decided_at = new Date(now);
		return { ok: true, approval: cloneApproval(row) };
	}

	async expirePending(ms: number): Promise<number> {
		if (!Number.isFinite(ms) || ms < 0) {
			throw new Error(
				"ms must be a non-negative age threshold in milliseconds",
			);
		}
		const now = Date.now();
		let expired = 0;
		for (const row of this.rows.values()) {
			if (
				row.status === "pending" &&
				(row.expires_at.getTime() <= now ||
					row.created_at.getTime() <= now - ms)
			) {
				row.status = "expired";
				expired += 1;
			}
		}
		return expired;
	}

	async expirePendingForTask(taskId: TaskId): Promise<number> {
		const now = Date.now();
		let expired = 0;
		for (const row of this.rows.values()) {
			if (row.task_id === taskId && row.status === "pending") {
				row.status = "expired";
				row.expires_at = new Date(Math.min(row.expires_at.getTime(), now));
				expired += 1;
			}
		}
		return expired;
	}

	async listPending(organizationId: OrganizationId): Promise<ApprovalRow[]> {
		const out: ApprovalRow[] = [];
		for (const row of this.rows.values()) {
			if (row.organization_id === organizationId && row.status === "pending") {
				out.push(cloneApproval(row));
			}
		}
		return out;
	}
}

type QueueEnqueueInput = Parameters<QueueRepository["enqueue"]>[0];

export class InMemoryQueueRepository implements QueueRepository {
	private readonly rows = new Map<JobId, JobRow>();

	async enqueue(input: QueueEnqueueInput): Promise<JobRow> {
		if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer");
		}
		for (const row of this.rows.values()) {
			if (
				row.organizationId === input.organizationId &&
				row.enqueueUuidKey === input.idempotencyKey
			) {
				return row;
			}
		}
		const now = new Date().toISOString();
		const row: JobRow = {
			id: asJobId(newUuid()),
			organizationId: input.organizationId,
			taskId: input.taskId,
			type: input.type,
			payload: { ...input.payload },
			status: "pending",
			attempts: 0,
			maxAttempts: input.maxAttempts,
			lease: null,
			notBefore: input.notBefore ?? now,
			enqueueUuidKey: input.idempotencyKey,
			lastError: null,
			createdAt: now,
		};
		this.rows.set(row.id, row);
		return cloneJob(row);
	}

	async claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
		/** Test hook: evaluate claimability against a fixed epoch-ms clock. */
		nowMs?: number;
	}): Promise<JobRow | null> {
		if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
			throw new Error("ownerId must be a non-empty string");
		}
		if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
			throw new Error("leaseSeconds must be a positive integer");
		}
		const now = input.nowMs ?? Date.now();
		let candidate: JobRow | null = null;
		for (const row of this.rows.values()) {
			const claimable =
				(row.status === "pending" &&
					new Date(row.notBefore).getTime() <= now) ||
				(row.status === "claimed" &&
					row.lease !== null &&
					new Date(row.lease.leaseExpiresAt).getTime() < now);
			if (!claimable) {
				continue;
			}
			if (candidate === null || row.createdAt < candidate.createdAt) {
				candidate = row;
			}
		}
		if (!candidate) {
			return null;
		}
		candidate.status = "claimed";
		candidate.attempts += 1;
		candidate.lease = {
			ownerId: input.ownerId,
			leaseExpiresAt: new Date(now + input.leaseSeconds * 1000).toISOString(),
		};
		return cloneJob(candidate);
	}

	async heartbeat(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean> {
		const result = await this.heartbeatResult(jobId, ownerId, extendSeconds);
		return result.ok;
	}

	async heartbeatResult(
		jobId: JobId,
		ownerId: string,
		extendSeconds: number,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
		if (!Number.isInteger(extendSeconds) || extendSeconds < 1) {
			throw new Error("extendSeconds must be a positive integer");
		}
		const row = this.rows.get(jobId);
		if (!row || row.status !== "claimed" || row.lease === null) {
			return { ok: false, code: "NOT_FOUND" };
		}
		if (row.lease.ownerId !== ownerId) {
			return { ok: false, code: "LEASE_LOST" };
		}
		row.lease = {
			ownerId,
			leaseExpiresAt: new Date(Date.now() + extendSeconds * 1000).toISOString(),
		};
		return { ok: true };
	}

	async ackComplete(
		jobId: JobId,
		ownerId: string,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
		const row = this.rows.get(jobId);
		if (!row || row.status !== "claimed" || row.lease === null) {
			return { ok: false, code: "NOT_FOUND" };
		}
		if (row.lease.ownerId !== ownerId) {
			return { ok: false, code: "LEASE_LOST" };
		}
		row.status = "done";
		row.lease = null;
		return { ok: true };
	}

	async ackFail(input: {
		jobId: JobId;
		ownerId: string;
		code: string;
		message: string;
	}): Promise<
		| { ok: true; requeued: boolean }
		| { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }
	> {
		const row = this.rows.get(input.jobId);
		if (!row || row.status !== "claimed" || row.lease === null) {
			return { ok: false, code: "NOT_FOUND" };
		}
		if (row.lease.ownerId !== input.ownerId) {
			return { ok: false, code: "LEASE_LOST" };
		}
		const outcome = ackFailOutcome(row.attempts, row.maxAttempts);
		row.lastError = { code: input.code, message: input.message.slice(0, 4000) };
		row.lease = null;
		row.status = outcome.status as JobStatus;
		if (outcome.requeued && outcome.backoffSeconds !== null) {
			row.status = "pending";
			row.notBefore = new Date(
				Date.now() + outcome.backoffSeconds * 1000,
			).toISOString();
		}
		return { ok: true, requeued: outcome.requeued };
	}

	async requeueExpiredLeases(nowMs: number): Promise<number> {
		if (!Number.isFinite(nowMs)) {
			throw new Error("nowMs must be a finite epoch-milliseconds value");
		}
		let requeued = 0;
		for (const row of this.rows.values()) {
			if (
				row.status === "claimed" &&
				row.lease !== null &&
				new Date(row.lease.leaseExpiresAt).getTime() <= nowMs
			) {
				row.status = "pending";
				row.lease = null;
				requeued += 1;
			}
		}
		return requeued;
	}
}

function isSha256Hex(value: string): boolean {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * In-memory spend ledger. Stores the SAME canonical cost strings the driver
 * writes (`numeric(12,6)` semantics) and aggregates through the shared pure
 * helper, so fake and driver totals cannot diverge.
 */
export class InMemoryUsageRepository implements UsageRepository {
	private readonly rows: UsageRecordRow[] = [];

	constructor(private readonly clock: () => Date = () => new Date()) {}

	async record(input: UsageRecordInput): Promise<UsageRecordRow> {
		validateUsageInput(input);
		const micros = costUsdToMicros(input.costUsd);
		const row: UsageRecordRow = {
			id: newUuid(),
			organization_id: input.organizationId,
			task_id: input.taskId,
			model_id: input.modelId,
			provider: input.provider,
			prompt_tokens: input.promptTokens,
			completion_tokens: input.completionTokens,
			cost_usd: micros === null ? null : formatCostMicros(micros),
			created_at: this.clock(),
		};
		this.rows.push(row);
		return { ...row };
	}

	async sumByTask(taskId: TaskId): Promise<UsageTotals> {
		requireNonEmpty(taskId, "taskId");
		return aggregateUsageRows(
			this.rows.filter((row) => row.task_id === taskId),
		);
	}

	async sumByOrgSince(
		organizationId: OrganizationId,
		since: Date,
	): Promise<UsageTotals> {
		requireNonEmpty(organizationId, "organizationId");
		if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
			throw new Error("since must be a valid Date");
		}
		const sinceMs = since.getTime();
		return aggregateUsageRows(
			this.rows.filter(
				(row) =>
					row.organization_id === organizationId &&
					row.created_at.getTime() >= sinceMs,
			),
		);
	}
}

function cloneApproval(row: ApprovalRow): ApprovalRow {
	return {
		...row,
		expires_at: new Date(row.expires_at),
		created_at: new Date(row.created_at),
	};
}

function cloneJob(row: JobRow): JobRow {
	return { ...row, payload: { ...row.payload } };
}
