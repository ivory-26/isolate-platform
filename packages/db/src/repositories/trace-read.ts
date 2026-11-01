import { createHash } from "node:crypto";
import {
	findCredentialMaterial,
	isCredentialMaterialKey,
	type OrganizationId,
	PlatformError,
	type TaskId,
} from "@isolate/shared";
import type { PgSql } from "../client";
import { parseJsonbColumn } from "../client";
import type { RunEventRow, ToolInvocationRow } from "../schema";
import type { ConnectorCallStatus } from "./connector-calls";
import { clampPageLimit } from "./pagination";
import { requireNonEmpty } from "./task-repository";

/**
 * Tenant-scoped trace read model over durable rows (wave 19).
 *
 * Reconstructs one task run from the four tables that already record it:
 * `run_events` (timeline), `tool_invocations` (policy decisions), `usage_records`
 * (tokens/cost) and `connector_calls` (device-side provider work, 0011/0013).
 *
 * Contract:
 * - Tenancy is proven first: a missing OR foreign `taskId` returns `null`, so a
 *   leaked id can never read another organization's run.
 * - Every section is ordered oldest-first and bounded before the SQL parameter
 *   is bound; a noisy task streams a page, never its whole history.
 * - No payload leaves this layer: tool arguments become a sha256 digest,
 *   connector `params`/`result` are never selected, and `run_events.data` is
 *   re-scanned on read so a credential-shaped key or value is dropped even if a
 *   row predates the write-time redaction.
 * - Dates are ISO strings; the cost keeps the driver's exact `numeric(12,6)`
 *   decimal string.
 */

/** Timeline page: default 200 events, hard cap 500. */
export const TRACE_EVENT_DEFAULT_LIMIT = 200;
export const TRACE_EVENT_MAX_LIMIT = 500;
/** One page per section; fixed bounds keep one trace read predictable. */
export const TRACE_TOOL_INVOCATION_LIMIT = 200;
export const TRACE_USAGE_LIMIT = 200;
export const TRACE_CONNECTOR_CALL_LIMIT = 100;

const MAX_TRACE_DATA_DEPTH = 6;
const MAX_TRACE_DATA_KEYS = 64;
const MAX_TRACE_DATA_ITEMS = 64;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACE_ACTORS: ReadonlySet<string> = new Set([
	"user",
	"agent",
	"worker",
	"system",
	"policy",
]);
const TOOL_DECISIONS: ReadonlySet<string> = new Set([
	"allowed",
	"allowed_by_approval",
	"denied",
]);
const CONNECTOR_CALL_STATUSES: ReadonlySet<string> = new Set([
	"queued",
	"claimed",
	"completed",
	"failed",
	"expired",
]);

export type TraceEventView = {
	readonly type: string;
	readonly actor: RunEventRow["actor"];
	/** Bounded, credential-scanned event metadata; never a secret or payload. */
	readonly data: Record<string, unknown>;
	readonly createdAt: string;
};

export type TraceToolInvocationView = {
	readonly toolName: string;
	readonly decision: ToolInvocationRow["decision"];
	readonly denialReason: string | null;
	/** sha256 of the redacted arguments; the arguments themselves never leave. */
	readonly argumentsHash: string;
	readonly durationMs: number | null;
	readonly createdAt: string;
};

export type TraceUsageView = {
	readonly provider: string;
	readonly modelId: string;
	readonly promptTokens: number | null;
	readonly completionTokens: number | null;
	/** Exact `numeric(12,6)` decimal string, or null when no price was known. */
	readonly costUsd: string | null;
	readonly createdAt: string;
};

export type TraceConnectorCallView = {
	readonly toolName: string;
	readonly connectorId: string;
	readonly status: ConnectorCallStatus;
	readonly errorCode: string | null;
	readonly attempts: number;
	readonly traceparent: string | null;
	readonly createdAt: string;
	readonly claimedAt: string | null;
	readonly completedAt: string | null;
	readonly expiresAt: string;
};

export type TaskTrace = {
	readonly taskId: string;
	/** First valid W3C trace id: connector call traceparent, else event data. */
	readonly traceId: string | null;
	readonly events: TraceEventView[];
	readonly toolInvocations: TraceToolInvocationView[];
	readonly usage: TraceUsageView[];
	readonly connectorCalls: TraceConnectorCallView[];
};

export type GetTaskTraceInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	/** Timeline page size; defaults to 200 and is clamped to 500. */
	maxEvents?: number;
};

export interface TaskTraceRepository {
	getTaskTrace(input: GetTaskTraceInput): Promise<TaskTrace | null>;
}

function traceRowError(): PlatformError {
	return new PlatformError("DB_UNAVAILABLE", "trace row is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Bounded, credential-scanned clone of one `run_events.data` value.
 *
 * Depth, key count and array length are capped so one hostile row cannot blow
 * up a response; credential-shaped keys are dropped and credential-shaped
 * strings become null. The scan mirrors the shared credential detector, so a
 * row written before the write-time redaction still cannot leak a secret.
 */
export function sanitizeTraceData(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		return findCredentialMaterial(value) === null ? value : null;
	}
	if (depth >= MAX_TRACE_DATA_DEPTH) return null;
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_TRACE_DATA_ITEMS)
			.map((item) => sanitizeTraceData(item, depth + 1));
	}
	if (!isRecord(value)) return null;
	const bounded: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value).slice(
		0,
		MAX_TRACE_DATA_KEYS,
	)) {
		if (isCredentialMaterialKey(key)) continue;
		bounded[key] = sanitizeTraceData(child, depth + 1);
	}
	return bounded;
}

/** Deterministic JSON (sorted keys) so one argument set hashes once. */
function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return `{${entries
		.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
		.join(",")}}`;
}

/** sha256 hex of the redacted tool arguments; stable across key order. */
export function hashToolArguments(argumentsRedacted: unknown): string {
	return createHash("sha256")
		.update(stableJson(argumentsRedacted))
		.digest("hex");
}

/**
 * One trace id per task run: the first connector call carrying a valid W3C
 * `traceparent` wins, otherwise the first `run_events.data.traceId`. Anything
 * malformed is ignored rather than surfaced as a fake id.
 */
export function deriveTraceId(input: {
	readonly events: readonly Pick<TraceEventView, "data">[];
	readonly connectorCalls: readonly Pick<
		TraceConnectorCallView,
		"traceparent"
	>[];
}): string | null {
	for (const call of input.connectorCalls) {
		if (call.traceparent === null) continue;
		const match = TRACEPARENT_PATTERN.exec(call.traceparent);
		if (match !== null) return match[1] ?? null;
	}
	for (const event of input.events) {
		const candidate = event.data.traceId;
		if (typeof candidate === "string" && TRACE_ID_PATTERN.test(candidate)) {
			return candidate;
		}
	}
	return null;
}

function requireString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw traceRowError();
	return value;
}

function nullableString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw traceRowError();
	return value;
}

function toIso(value: unknown): string {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw traceRowError();
		return value.toISOString();
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	throw traceRowError();
}

function toOptionalIso(value: unknown): string | null {
	return value === null || value === undefined ? null : toIso(value);
}

function nullableCount(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return nonNegativeInt(value);
}

function nonNegativeInt(value: unknown): number {
	const count = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(count) || count < 0) throw traceRowError();
	return count;
}

function actorOf(value: unknown): RunEventRow["actor"] {
	if (typeof value !== "string" || !TRACE_ACTORS.has(value)) {
		throw traceRowError();
	}
	return value as RunEventRow["actor"];
}

function decisionOf(value: unknown): ToolInvocationRow["decision"] {
	if (typeof value !== "string" || !TOOL_DECISIONS.has(value)) {
		throw traceRowError();
	}
	return value as ToolInvocationRow["decision"];
}

function statusOf(value: unknown): ConnectorCallStatus {
	if (typeof value !== "string" || !CONNECTOR_CALL_STATUSES.has(value)) {
		throw traceRowError();
	}
	return value as ConnectorCallStatus;
}

function traceparentOf(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !TRACEPARENT_PATTERN.test(value))
		return null;
	return value;
}

function mapEventRow(row: Record<string, unknown>): TraceEventView {
	const sanitized = sanitizeTraceData(
		parseJsonbColumn<unknown>(row.data) ?? {},
	);
	return {
		type: requireString(row.type),
		actor: actorOf(row.actor),
		data: isRecord(sanitized) ? sanitized : {},
		createdAt: toIso(row.occurred_at),
	};
}

function mapToolInvocationRow(
	row: Record<string, unknown>,
): TraceToolInvocationView {
	return {
		toolName: requireString(row.tool_name),
		decision: decisionOf(row.decision),
		denialReason: nullableString(row.denial_reason),
		argumentsHash: hashToolArguments(
			parseJsonbColumn<unknown>(row.arguments_redacted) ?? {},
		),
		durationMs: nullableCount(row.duration_ms),
		createdAt: toIso(row.created_at),
	};
}

function mapUsageRow(row: Record<string, unknown>): TraceUsageView {
	return {
		provider: requireString(row.provider),
		modelId: requireString(row.model_id),
		promptTokens: nullableCount(row.prompt_tokens),
		completionTokens: nullableCount(row.completion_tokens),
		// numeric(12,6) arrives as an exact decimal string; keep it verbatim.
		costUsd:
			row.cost_usd === null || row.cost_usd === undefined
				? null
				: String(row.cost_usd),
		createdAt: toIso(row.created_at),
	};
}

function mapConnectorCallRow(
	row: Record<string, unknown>,
): TraceConnectorCallView {
	return {
		toolName: requireString(row.tool_name),
		connectorId: requireString(row.connector_id),
		status: statusOf(row.status),
		errorCode: nullableString(row.error_code),
		attempts: nonNegativeInt(row.attempts),
		traceparent: traceparentOf(row.traceparent),
		createdAt: toIso(row.created_at),
		claimedAt: toOptionalIso(row.claimed_at),
		completedAt: toOptionalIso(row.completed_at),
		expiresAt: toIso(row.expires_at),
	};
}

const STMT = {
	// Tenancy is proven first; a foreign or missing task stops the read here.
	taskExists: `SELECT t.id FROM tasks t
		WHERE t.organization_id = $1 AND t.id = $2
		LIMIT 1`,
	events: `SELECT e.type, e.actor, e.data, e.occurred_at
		FROM run_events e
		JOIN tasks t ON t.id = e.task_id AND t.organization_id = $1
		WHERE e.task_id = $2
		ORDER BY e.occurred_at ASC, e.id ASC
		LIMIT $3`,
	toolInvocations: `SELECT i.tool_name, i.decision, i.denial_reason,
			i.arguments_redacted, i.duration_ms, i.created_at
		FROM tool_invocations i
		WHERE i.organization_id = $1 AND i.task_id = $2
		ORDER BY i.created_at ASC, i.id ASC
		LIMIT $3`,
	usage: `SELECT u.provider, u.model_id, u.prompt_tokens, u.completion_tokens,
			u.cost_usd, u.created_at
		FROM usage_records u
		WHERE u.organization_id = $1 AND u.task_id = $2
		ORDER BY u.created_at ASC, u.id ASC
		LIMIT $3`,
	connectorCalls: `SELECT c.tool_name, c.connector_id, c.status, c.error_code,
			c.attempts, c.traceparent, c.created_at, c.claimed_at, c.completed_at,
			c.expires_at
		FROM connector_calls c
		WHERE c.organization_id = $1 AND c.task_id = $2
		ORDER BY c.created_at ASC, c.id ASC
		LIMIT $3`,
} as const;

export class PostgresTraceReadRepository implements TaskTraceRepository {
	constructor(private readonly sql: PgSql) {}

	async getTaskTrace(input: GetTaskTraceInput): Promise<TaskTrace | null> {
		requireNonEmpty(input.organizationId, "organizationId");
		requireNonEmpty(input.taskId, "taskId");
		const organizationId = input.organizationId;
		const taskId = input.taskId;
		const eventLimit = clampPageLimit(
			input.maxEvents,
			TRACE_EVENT_DEFAULT_LIMIT,
			TRACE_EVENT_MAX_LIMIT,
		);

		// A foreign task is indistinguishable from a missing one: stop, don't
		// read any child table.
		const exists = (await this.sql.unsafe(STMT.taskExists, [
			organizationId,
			taskId,
		])) as unknown as Record<string, unknown>[];
		if (exists.length === 0) return null;

		// Sequential and fixed-order so a caller can reason about one read.
		const eventRows = (await this.sql.unsafe(STMT.events, [
			organizationId,
			taskId,
			eventLimit,
		])) as unknown as Record<string, unknown>[];
		const toolRows = (await this.sql.unsafe(STMT.toolInvocations, [
			organizationId,
			taskId,
			TRACE_TOOL_INVOCATION_LIMIT,
		])) as unknown as Record<string, unknown>[];
		const usageRows = (await this.sql.unsafe(STMT.usage, [
			organizationId,
			taskId,
			TRACE_USAGE_LIMIT,
		])) as unknown as Record<string, unknown>[];
		const callRows = (await this.sql.unsafe(STMT.connectorCalls, [
			organizationId,
			taskId,
			TRACE_CONNECTOR_CALL_LIMIT,
		])) as unknown as Record<string, unknown>[];

		const events = eventRows.map(mapEventRow);
		const connectorCalls = callRows.map(mapConnectorCallRow);
		return {
			taskId,
			traceId: deriveTraceId({ events, connectorCalls }),
			events,
			toolInvocations: toolRows.map(mapToolInvocationRow),
			usage: usageRows.map(mapUsageRow),
			connectorCalls,
		};
	}
}
