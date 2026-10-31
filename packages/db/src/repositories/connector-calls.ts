import {
	connectorIdSchema,
	type OrganizationId,
	PlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";

/**
 * Device-daemon connector call queue (migration 0011, `connector_calls`).
 *
 * SECURITY: a call carries typed tool arguments only. The provider secret never
 * reaches this table, this repository or the server process: the device looks
 * it up locally by `credential_id` and posts a bounded result back.
 *
 * Decisions enforced here and mirrored by the in-memory fake:
 * - `enqueue` validates identifiers, tool name, argument shape, size and
 *   credential-shaped strings before the row exists.
 * - `claimNext` is ONE statement using `FOR UPDATE SKIP LOCKED`; it flips
 *   `queued -> claimed`, increments `attempts` and returns only a call whose
 *   `expires_at` is still in the future. Two concurrent claims cannot collide.
 * - `complete` / `fail` are scoped to the owning device and to `claimed` rows.
 *   A replay of an already terminal call is an idempotent success, so a device
 *   that lost the response does not have to guess.
 * - `expireStale` moves queued/claimed rows past `expires_at` to `expired`.
 * - `awaitResult` polls a bounded number of times; it never waits forever.
 */

export const CONNECTOR_CALL_MAX_PARAMS_BYTES = 64 * 1024;
export const CONNECTOR_CALL_MAX_RESULT_BYTES = 256 * 1024;
export const CONNECTOR_CALL_DEFAULT_TTL_MS = 60_000;
export const CONNECTOR_CALL_MIN_TTL_MS = 1_000;
export const CONNECTOR_CALL_MAX_TTL_MS = 15 * 60_000;
export const CONNECTOR_CALL_DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
export const CONNECTOR_CALL_MAX_AWAIT_TIMEOUT_MS = 60_000;
export const CONNECTOR_CALL_MIN_POLL_MS = 10;
export const CONNECTOR_CALL_MAX_POLL_MS = 5_000;
export const CONNECTOR_CALL_MAX_ID_CHARS = 128;
export const CONNECTOR_CALL_MAX_TASK_ID_CHARS = 128;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 128;
const MAX_JSON_ARRAY_ITEMS = 1_024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Credential-shaped strings are refused in both directions. A provider key must
 * never be pasted into tool arguments or smuggled back in a result.
 */
const CREDENTIAL_MATERIAL_PATTERNS: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export type ConnectorCallStatus =
	| "queued"
	| "claimed"
	| "completed"
	| "failed"
	| "expired";

/** Row shape surfaced to callers. `result` is the device's bounded data. */
export type ConnectorCallRecord = {
	id: string;
	organizationId: OrganizationId;
	deviceId: string;
	credentialId: string;
	taskId: string | null;
	connectorId: string;
	toolName: string;
	params: Record<string, unknown>;
	status: ConnectorCallStatus;
	result: Record<string, unknown> | null;
	errorCode: string | null;
	attempts: number;
	claimedAt: Date | null;
	completedAt: Date | null;
	expiresAt: Date;
	createdAt: Date;
};

export type EnqueueConnectorCallInput = {
	organizationId: OrganizationId;
	deviceId: string;
	credentialId: string;
	taskId?: string | null;
	connectorId: string;
	toolName: string;
	/** Typed tool arguments only; never a provider secret. */
	params: Record<string, unknown>;
	ttlMs?: number;
};

export type ConnectorCallWriteResult =
	| { ok: true; replayed: boolean }
	| { ok: false; code: "NOT_FOUND" | "NOT_CLAIMED" };

export type ConnectorCallOutcome =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; errorCode: string };

export interface ConnectorCallRepository {
	enqueue(input: EnqueueConnectorCallInput): Promise<ConnectorCallRecord>;
	claimNext(deviceId: string): Promise<ConnectorCallRecord | null>;
	complete(input: {
		callId: string;
		deviceId: string;
		result: Record<string, unknown>;
	}): Promise<ConnectorCallWriteResult>;
	fail(input: {
		callId: string;
		deviceId: string;
		errorCode: string;
	}): Promise<ConnectorCallWriteResult>;
	expireStale(now: Date): Promise<number>;
	awaitResult(
		callId: string,
		timeoutMs: number,
		pollMs: number,
	): Promise<ConnectorCallOutcome | null>;
}

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function requireBoundedId(value: unknown, field: string, maxChars: number) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw validationError(`${field} must be a non-empty string`);
	}
	if (value.length > maxChars) throw validationError(`${field} is too long`);
	return value;
}

function requireTaskId(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	return requireBoundedId(value, "taskId", CONNECTOR_CALL_MAX_TASK_ID_CHARS);
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, depth: number, label: string): void {
	if (depth > MAX_JSON_DEPTH) {
		throw validationError(`${label} is nested too deeply`);
	}
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw validationError(`${label} must be finite JSON`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_JSON_ARRAY_ITEMS) {
			throw validationError(`${label} has too many items`);
		}
		for (const item of value) assertJsonValue(item, depth + 1, label);
		return;
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length > MAX_JSON_KEYS) {
			throw validationError(`${label} has too many keys`);
		}
		for (const [key, item] of entries) {
			if (FORBIDDEN_KEYS.has(key)) {
				throw validationError(`${label} has a forbidden key`);
			}
			assertJsonValue(item, depth + 1, label);
		}
		return;
	}
	throw validationError(`${label} must be JSON`);
}

function assertNoCredentialMaterial(value: unknown, label: string): void {
	if (typeof value === "string") {
		for (const pattern of CREDENTIAL_MATERIAL_PATTERNS) {
			if (pattern.test(value)) {
				throw validationError(`${label} contains credential material`);
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertNoCredentialMaterial(item, label);
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			for (const pattern of CREDENTIAL_MATERIAL_PATTERNS) {
				if (pattern.test(key)) {
					throw validationError(`${label} contains credential material`);
				}
			}
			assertNoCredentialMaterial(item, label);
		}
	}
}

/**
 * Validates an untrusted JSON object, refuses credential-shaped text and
 * returns a detached clone. Failures carry fixed text, never a value.
 */
export function normalizeBoundedConnectorJsonObject(
	value: unknown,
	label: string,
	maxBytes: number,
): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw validationError(`${label} must be a JSON object`);
	}
	assertJsonValue(value, 1, label);
	assertNoCredentialMaterial(value, label);
	const text = JSON.stringify(value);
	if (text === undefined || byteLength(text) > maxBytes) {
		throw validationError(`${label} exceeds ${maxBytes} bytes`);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

function normalizeTtl(value: unknown): number {
	if (value === undefined) return CONNECTOR_CALL_DEFAULT_TTL_MS;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < CONNECTOR_CALL_MIN_TTL_MS ||
		value > CONNECTOR_CALL_MAX_TTL_MS
	) {
		throw validationError("ttlMs is invalid");
	}
	return value;
}

export function normalizeConnectorCallEnqueueInput(
	input: EnqueueConnectorCallInput,
): {
	organizationId: OrganizationId;
	deviceId: string;
	credentialId: string;
	taskId: string | null;
	connectorId: string;
	toolName: string;
	params: Record<string, unknown>;
	ttlMs: number;
} {
	const organizationId = requireBoundedId(
		input.organizationId,
		"organizationId",
		CONNECTOR_CALL_MAX_ID_CHARS,
	) as OrganizationId;
	const deviceId = requireBoundedId(
		input.deviceId,
		"deviceId",
		CONNECTOR_CALL_MAX_ID_CHARS,
	);
	const credentialId = requireBoundedId(
		input.credentialId,
		"credentialId",
		CONNECTOR_CALL_MAX_ID_CHARS,
	);
	const taskId = requireTaskId(input.taskId);
	const connectorId = connectorIdSchema.safeParse(input.connectorId);
	if (!connectorId.success) {
		throw validationError(
			`connectorId is invalid: ${zodIssueSummary(connectorId.error)}`,
		);
	}
	if (
		typeof input.toolName !== "string" ||
		!TOOL_NAME_PATTERN.test(input.toolName)
	) {
		throw validationError("toolName is invalid");
	}
	const params = normalizeBoundedConnectorJsonObject(
		input.params,
		"connector call params",
		CONNECTOR_CALL_MAX_PARAMS_BYTES,
	);
	return {
		organizationId,
		deviceId,
		credentialId,
		taskId,
		connectorId: connectorId.data,
		toolName: input.toolName,
		params,
		ttlMs: normalizeTtl(input.ttlMs),
	};
}

export function normalizeConnectorCallWriteInput(
	callId: unknown,
	deviceId: unknown,
): { callId: string; deviceId: string } {
	return {
		callId: requireBoundedId(callId, "callId", CONNECTOR_CALL_MAX_ID_CHARS),
		deviceId: requireBoundedId(
			deviceId,
			"deviceId",
			CONNECTOR_CALL_MAX_ID_CHARS,
		),
	};
}

export function normalizeConnectorCallErrorCode(value: unknown): string {
	if (typeof value !== "string" || !ERROR_CODE_PATTERN.test(value)) {
		throw validationError("errorCode is invalid");
	}
	return value;
}

const CALL_COLUMNS = `id, organization_id, device_id, credential_id, task_id,
	connector_id, tool_name, params, status, result, error_code, attempts,
	claimed_at, completed_at, expires_at, created_at`;

function toDate(value: unknown, field: string): Date {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return new Date(value.getTime());
	}
	const parsed = new Date(String(value));
	if (Number.isNaN(parsed.getTime())) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			`connector call ${field} column is invalid`,
		);
	}
	return parsed;
}

function toOptionalDate(value: unknown, field: string): Date | null {
	return value === null || value === undefined ? null : toDate(value, field);
}

function toJsonObject(value: unknown, field: string): Record<string, unknown> {
	const parsed = parseJsonbColumn<unknown>(value);
	if (parsed === null) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			`connector call ${field} column is invalid`,
		);
	}
	if (!isPlainObject(parsed)) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			`connector call ${field} column is invalid`,
		);
	}
	return parsed;
}

export function mapConnectorCallRow(
	row: Record<string, unknown>,
): ConnectorCallRecord {
	const status = row.status;
	if (
		status !== "queued" &&
		status !== "claimed" &&
		status !== "completed" &&
		status !== "failed" &&
		status !== "expired"
	) {
		throw new PlatformError(
			"DB_UNAVAILABLE",
			"connector call status column is invalid",
		);
	}
	return {
		id: String(row.id),
		organizationId: row.organization_id as OrganizationId,
		deviceId: String(row.device_id),
		credentialId: String(row.credential_id),
		taskId: row.task_id === null ? null : String(row.task_id),
		connectorId: String(row.connector_id),
		toolName: String(row.tool_name),
		params: toJsonObject(row.params, "params"),
		status,
		result:
			row.result === null || row.result === undefined
				? null
				: toJsonObject(row.result, "result"),
		errorCode: row.error_code === null ? null : String(row.error_code),
		attempts: Number(row.attempts),
		claimedAt: toOptionalDate(row.claimed_at, "claimed_at"),
		completedAt: toOptionalDate(row.completed_at, "completed_at"),
		expiresAt: toDate(row.expires_at, "expires_at"),
		createdAt: toDate(row.created_at, "created_at"),
	};
}

const STMT = {
	insert: `INSERT INTO connector_calls (
		organization_id, device_id, credential_id, task_id, connector_id,
		tool_name, params, status, expires_at
	) VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, 'queued',
		now() + make_interval(secs => $8::double precision / 1000.0))
	RETURNING ${CALL_COLUMNS}`,
	// Atomic claim: SKIP LOCKED so two pollers never receive the same call.
	claimNext: `UPDATE connector_calls SET
			status = 'claimed',
			claimed_at = now(),
			attempts = attempts + 1
		WHERE id = (
			SELECT id FROM connector_calls
			WHERE device_id = $1
			  AND status = 'queued'
			  AND expires_at > now()
			ORDER BY created_at ASC, id ASC
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING ${CALL_COLUMNS}`,
	complete: `UPDATE connector_calls SET
			status = 'completed',
			result = $3::text::jsonb,
			completed_at = now()
		WHERE id = $1 AND device_id = $2
		  AND status = 'claimed' AND expires_at > now()
		RETURNING id`,
	fail: `UPDATE connector_calls SET
			status = 'failed',
			result = NULL,
			error_code = $3,
			completed_at = now()
		WHERE id = $1 AND device_id = $2
		  AND status = 'claimed' AND expires_at > now()
		RETURNING id`,
	statusForDevice: `SELECT status FROM connector_calls
		WHERE id = $1 AND device_id = $2`,
	expireStale: `UPDATE connector_calls SET
			status = 'expired',
			completed_at = $1::timestamptz
		WHERE status IN ('queued', 'claimed')
		  AND expires_at <= $1::timestamptz
		RETURNING id`,
	awaitResult: `SELECT status, result, error_code, expires_at
		FROM connector_calls WHERE id = $1`,
} as const;

export function clampConnectorCallAwaitOptions(
	timeoutMs: number,
	pollMs: number,
): {
	timeoutMs: number;
	pollMs: number;
} {
	if (
		typeof timeoutMs !== "number" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0
	) {
		throw validationError("timeoutMs is invalid");
	}
	if (typeof pollMs !== "number" || !Number.isFinite(pollMs) || pollMs <= 0) {
		throw validationError("pollMs is invalid");
	}
	return {
		timeoutMs: Math.min(
			CONNECTOR_CALL_MAX_AWAIT_TIMEOUT_MS,
			Math.max(1, Math.floor(timeoutMs)),
		),
		pollMs: Math.min(
			CONNECTOR_CALL_MAX_POLL_MS,
			Math.max(CONNECTOR_CALL_MIN_POLL_MS, Math.floor(pollMs)),
		),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Terminal-state lookup shared by the Postgres poll loop and the fake. A
 * queued/claimed row returns null; a completed row returns its data.
 */
export function connectorCallOutcome(row: {
	status: ConnectorCallStatus;
	result: Record<string, unknown> | null;
	errorCode: string | null;
}): ConnectorCallOutcome | null {
	if (row.status === "completed") {
		return row.result === null
			? { ok: false, errorCode: "INTERNAL" }
			: { ok: true, data: row.result };
	}
	if (row.status === "failed") {
		return { ok: false, errorCode: row.errorCode ?? "INTERNAL" };
	}
	if (row.status === "expired") {
		return { ok: false, errorCode: "EXPIRED" };
	}
	return null;
}

export class PostgresConnectorCallRepository
	implements ConnectorCallRepository
{
	constructor(private readonly sql: PgSql) {}

	async enqueue(
		input: EnqueueConnectorCallInput,
	): Promise<ConnectorCallRecord> {
		const normalized = normalizeConnectorCallEnqueueInput(input);
		const rows = (await this.sql.unsafe(STMT.insert, [
			normalized.organizationId,
			normalized.deviceId,
			normalized.credentialId,
			normalized.taskId,
			normalized.connectorId,
			normalized.toolName,
			JSON.stringify(normalized.params),
			normalized.ttlMs,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			throw new PlatformError(
				"DB_UNAVAILABLE",
				"connector call insert returned no row",
			);
		}
		return mapConnectorCallRow(rows[0]);
	}

	async claimNext(deviceId: string): Promise<ConnectorCallRecord | null> {
		const id = requireBoundedId(
			deviceId,
			"deviceId",
			CONNECTOR_CALL_MAX_ID_CHARS,
		);
		const rows = (await this.sql.unsafe(STMT.claimNext, [
			id,
		])) as unknown as Record<string, unknown>[];
		return rows.length === 0 ? null : mapConnectorCallRow(rows[0]);
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
		const result = normalizeBoundedConnectorJsonObject(
			input.result,
			"connector call result",
			CONNECTOR_CALL_MAX_RESULT_BYTES,
		);
		const rows = (await this.sql.unsafe(STMT.complete, [
			normalized.callId,
			normalized.deviceId,
			JSON.stringify(result),
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) return { ok: true, replayed: false };
		return this.resolveReplay(normalized.callId, normalized.deviceId, [
			"completed",
		]);
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
		const rows = (await this.sql.unsafe(STMT.fail, [
			normalized.callId,
			normalized.deviceId,
			errorCode,
		])) as unknown as Record<string, unknown>[];
		if (rows.length > 0) return { ok: true, replayed: false };
		return this.resolveReplay(normalized.callId, normalized.deviceId, [
			"failed",
		]);
	}

	/**
	 * A device that lost the response retries the same write. If the row is
	 * already terminal in the same direction, that is success, not a conflict.
	 * Another device (or a missing row) is indistinguishable from not found.
	 */
	private async resolveReplay(
		callId: string,
		deviceId: string,
		terminal: readonly ConnectorCallStatus[],
	): Promise<ConnectorCallWriteResult> {
		const rows = (await this.sql.unsafe(STMT.statusForDevice, [
			callId,
			deviceId,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) return { ok: false, code: "NOT_FOUND" };
		const status = rows[0].status as ConnectorCallStatus;
		if (terminal.includes(status)) return { ok: true, replayed: true };
		return { ok: false, code: "NOT_CLAIMED" };
	}

	async expireStale(now: Date): Promise<number> {
		if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
			throw validationError("now must be a valid Date");
		}
		const rows = (await this.sql.unsafe(STMT.expireStale, [
			now.toISOString(),
		])) as unknown as Record<string, unknown>[];
		return rows.length;
	}

	async awaitResult(
		callId: string,
		timeoutMs: number,
		pollMs: number,
	): Promise<ConnectorCallOutcome | null> {
		const id = requireBoundedId(callId, "callId", CONNECTOR_CALL_MAX_ID_CHARS);
		const bounded = clampConnectorCallAwaitOptions(timeoutMs, pollMs);
		const deadline = Date.now() + bounded.timeoutMs;
		for (;;) {
			const rows = (await this.sql.unsafe(STMT.awaitResult, [
				id,
			])) as unknown as Record<string, unknown>[];
			if (rows.length > 0) {
				const outcome = connectorCallOutcome({
					status: rows[0].status as ConnectorCallStatus,
					result:
						rows[0].result === null || rows[0].result === undefined
							? null
							: toJsonObject(rows[0].result, "result"),
					errorCode:
						rows[0].error_code === null ? null : String(rows[0].error_code),
				});
				if (outcome !== null) return outcome;
				if (toDate(rows[0].expires_at, "expires_at").getTime() <= Date.now()) {
					return { ok: false, errorCode: "EXPIRED" };
				}
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) return null;
			await sleep(Math.min(bounded.pollMs, remaining));
		}
	}
}
