import { PlatformError } from "@isolate/shared";
import {
	CONNECTOR_CALL_MAX_RESULT_BYTES,
	type ConnectorCallOutcome,
	type ConnectorCallRecord,
	type ConnectorCallRepository,
	type ConnectorCallScope,
	type ConnectorCallWriteResult,
	clampConnectorCallAwaitOptions,
	connectorCallOutcome,
	normalizeBoundedConnectorJsonObject,
	normalizeConnectorCallClaimLimit,
	normalizeConnectorCallEnqueueInput,
	normalizeConnectorCallErrorCode,
	normalizeConnectorCallWriteInput,
} from "../repositories/connector-calls";

/**
 * Offline twin of `PostgresConnectorCallRepository`.
 *
 * The same pure normalizers run here, so the fake cannot accept a call the
 * database CHECKs would reject. Claim moves are synchronous (no await between
 * selecting and flipping), which mirrors the single `FOR UPDATE SKIP LOCKED`
 * statement: two concurrent `claimNext` calls never receive the same row.
 */

type FakeOptions = {
	/** Clock seam for expiry tests; defaults to wall clock. */
	now?: () => Date;
};

function cloneRecord(record: ConnectorCallRecord): ConnectorCallRecord {
	return {
		...record,
		params: structuredClone(record.params),
		result: record.result === null ? null : structuredClone(record.result),
		claimedAt:
			record.claimedAt === null ? null : new Date(record.claimedAt.getTime()),
		completedAt:
			record.completedAt === null
				? null
				: new Date(record.completedAt.getTime()),
		expiresAt: new Date(record.expiresAt.getTime()),
		createdAt: new Date(record.createdAt.getTime()),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InMemoryConnectorCallRepository
	implements ConnectorCallRepository
{
	private readonly rows = new Map<string, ConnectorCallRecord>();
	private readonly now: () => Date;

	constructor(options: FakeOptions = {}) {
		this.now = options.now ?? (() => new Date());
	}

	async enqueue(
		input: Parameters<ConnectorCallRepository["enqueue"]>[0],
	): Promise<ConnectorCallRecord> {
		const normalized = normalizeConnectorCallEnqueueInput(input);
		const now = this.now();
		const record: ConnectorCallRecord = {
			id: crypto.randomUUID(),
			organizationId: normalized.organizationId,
			deviceId: normalized.deviceId,
			credentialId: normalized.credentialId,
			taskId: normalized.taskId,
			connectorId: normalized.connectorId,
			toolName: normalized.toolName,
			params: normalized.params,
			traceparent: normalized.traceparent,
			status: "queued",
			result: null,
			errorCode: null,
			attempts: 0,
			claimedAt: null,
			completedAt: null,
			expiresAt: new Date(now.getTime() + normalized.ttlMs),
			createdAt: now,
		};
		this.rows.set(record.id, record);
		return cloneRecord(record);
	}

	async claimNext(
		deviceId: string,
		limit?: number,
	): Promise<ConnectorCallRecord[]> {
		if (typeof deviceId !== "string" || deviceId.trim().length === 0) {
			throw new PlatformError("VALIDATION_FAILED", "deviceId is required");
		}
		const batch = normalizeConnectorCallClaimLimit(limit);
		const now = this.now();
		const candidates = [...this.rows.values()]
			.filter(
				(row) =>
					row.deviceId === deviceId &&
					row.status === "queued" &&
					row.expiresAt.getTime() > now.getTime(),
			)
			.sort((left, right) => {
				const byTime = left.createdAt.getTime() - right.createdAt.getTime();
				return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
			})
			.slice(0, batch);
		const claimed: ConnectorCallRecord[] = [];
		for (const row of candidates) {
			row.status = "claimed";
			row.claimedAt = now;
			row.attempts += 1;
			claimed.push(cloneRecord(row));
		}
		return claimed;
	}

	async complete(input: {
		callId: string;
		deviceId: string;
		result: Record<string, unknown>;
	}): Promise<ConnectorCallWriteResult> {
		const normalized = normalizeConnectorCallWriteInput(
			input.callId,
			input.deviceId,
		);
		const owned = this.rows.get(normalized.callId);
		if (owned === undefined || owned.deviceId !== normalized.deviceId) {
			return { ok: false, code: "NOT_FOUND" };
		}
		if (owned.status === "completed") {
			return { ok: true, replayed: true };
		}
		if (
			owned.status !== "claimed" ||
			owned.expiresAt.getTime() <= this.now().getTime()
		) {
			return { ok: false, code: "NOT_CLAIMED" };
		}
		owned.result = normalizeBoundedConnectorJsonObject(
			input.result,
			"connector call result",
			CONNECTOR_CALL_MAX_RESULT_BYTES,
		);
		owned.status = "completed";
		owned.completedAt = this.now();
		return { ok: true, replayed: false };
	}

	async fail(input: {
		callId: string;
		deviceId: string;
		errorCode: string;
	}): Promise<ConnectorCallWriteResult> {
		const normalized = normalizeConnectorCallWriteInput(
			input.callId,
			input.deviceId,
		);
		const errorCode = normalizeConnectorCallErrorCode(input.errorCode);
		const owned = this.rows.get(normalized.callId);
		if (owned === undefined || owned.deviceId !== normalized.deviceId) {
			return { ok: false, code: "NOT_FOUND" };
		}
		if (owned.status === "failed") {
			return { ok: true, replayed: true };
		}
		if (
			owned.status !== "claimed" ||
			owned.expiresAt.getTime() <= this.now().getTime()
		) {
			return { ok: false, code: "NOT_CLAIMED" };
		}
		owned.status = "failed";
		owned.result = null;
		owned.errorCode = errorCode;
		owned.completedAt = this.now();
		return { ok: true, replayed: false };
	}

	async expireStale(now: Date): Promise<number> {
		if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
			throw new PlatformError("VALIDATION_FAILED", "now must be a valid Date");
		}
		let expired = 0;
		for (const row of this.rows.values()) {
			if (
				(row.status === "queued" || row.status === "claimed") &&
				row.expiresAt.getTime() <= now.getTime()
			) {
				row.status = "expired";
				row.completedAt = new Date(now.getTime());
				expired += 1;
			}
		}
		return expired;
	}

	async awaitResult(
		callId: string,
		timeoutMs: number,
		pollMs: number,
		scope?: ConnectorCallScope,
	): Promise<ConnectorCallOutcome | null> {
		if (typeof callId !== "string" || callId.trim().length === 0) {
			throw new PlatformError("VALIDATION_FAILED", "callId is required");
		}
		const bounded = clampConnectorCallAwaitOptions(timeoutMs, pollMs);
		const deadline = Date.now() + bounded.timeoutMs;
		for (;;) {
			const row = this.rows.get(callId);
			if (
				scope !== undefined &&
				(row === undefined ||
					row.organizationId !== scope.organizationId ||
					row.deviceId !== scope.deviceId)
			) {
				// Same contract as the Postgres scoped SELECT: a foreign row is
				// indistinguishable from a missing one.
				return null;
			}
			if (row !== undefined) {
				const outcome = connectorCallOutcome(row);
				if (outcome !== null) return outcome;
				if (
					(row.status === "queued" || row.status === "claimed") &&
					row.expiresAt.getTime() <= this.now().getTime()
				) {
					return { ok: false, errorCode: "EXPIRED" };
				}
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return null;
			await sleep(Math.min(bounded.pollMs, remaining));
		}
	}

	/** Test-only visibility; never part of the repository contract. */
	peek(callId: string): ConnectorCallRecord | null {
		const row = this.rows.get(callId);
		return row === undefined ? null : cloneRecord(row);
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
