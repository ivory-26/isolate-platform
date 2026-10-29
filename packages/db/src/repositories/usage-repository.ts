import type { OrganizationId, TaskId, UsageRecordInput } from "@isolate/shared";
import type { PgSql } from "../client";
import type { UsageRecordRow } from "../schema";
import { requireNonEmpty } from "./task-repository";

/**
 * Spend attribution over the existing `usage_records` table (wave 4, no
 * migration).
 *
 * Money precision: `cost_usd` is `numeric(12,6)`, and postgres.js returns
 * `numeric` columns as EXACT decimal strings (type OID 1700 has no float
 * parser). Aggregates are therefore accumulated as integer micro-dollars
 * (`bigint`) and emitted as canonical 6-decimal strings — never via
 * floating-point addition. The same pure helper backs both the Postgres
 * driver and the in-memory fake, so the two cannot drift on rounding.
 *
 * A model call and a sandbox session both use `UsageRecordInput`:
 * - model rows: provider `baseten`, model id, prompt/completion tokens, cost.
 * - sandbox rows: provider `modal`, `sandbox:<cpu>x<memMiB>`, null tokens.
 * `costUsd` stays null when no trusted price configuration exists.
 */

export type UsageTotals = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Exact decimal string (6-dp scale), or null when no row carried a cost. */
	costUsd: string | null;
};

export interface UsageRepository {
	record(input: UsageRecordInput): Promise<UsageRecordRow>;
	sumByTask(taskId: TaskId): Promise<UsageTotals>;
	sumByOrgSince(
		organizationId: OrganizationId,
		since: Date,
	): Promise<UsageTotals>;
}

/** Column bound mirrored from `numeric(12,6)`. */
export const MAX_USAGE_COST_USD = 999999.999999;
export const MAX_USAGE_PROVIDER_LENGTH = 200;
export const MAX_USAGE_MODEL_ID_LENGTH = 200;

const COST_SCALE_FACTOR = 1_000_000n;
const MAX_USAGE_COST_MICROS = 999_999_999_999n;
const COST_DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Bounded input validation shared by the driver and the fake. Messages name
 * the field and the rule only; supplied values are never echoed.
 */
export function validateUsageInput(input: UsageRecordInput): void {
	requireNonEmpty(input.organizationId, "organizationId");
	if (input.taskId !== null) {
		requireNonEmpty(input.taskId, "taskId");
	}
	requireNonEmpty(input.provider, "provider");
	requireNonEmpty(input.modelId, "modelId");
	if (input.provider.length > MAX_USAGE_PROVIDER_LENGTH) {
		throw new Error(
			`provider must be at most ${MAX_USAGE_PROVIDER_LENGTH} characters`,
		);
	}
	if (input.modelId.length > MAX_USAGE_MODEL_ID_LENGTH) {
		throw new Error(
			`modelId must be at most ${MAX_USAGE_MODEL_ID_LENGTH} characters`,
		);
	}
	validateTokenCount(input.promptTokens, "promptTokens");
	validateTokenCount(input.completionTokens, "completionTokens");
	if (input.costUsd !== null) {
		if (
			typeof input.costUsd !== "number" ||
			!Number.isFinite(input.costUsd) ||
			input.costUsd < 0
		) {
			throw new Error("costUsd must be a finite non-negative number or null");
		}
		if (input.costUsd > MAX_USAGE_COST_USD) {
			throw new Error("costUsd exceeds the numeric(12,6) column bound");
		}
	}
}

function validateTokenCount(value: number | null, field: string): void {
	if (value === null) return;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer or null`);
	}
}

/**
 * Converts a validated input cost to micro-dollars. JS numbers are rounded to
 * the column's 6-decimal scale BEFORE binding, so binary-float artifacts (e.g.
 * `0.1 + 0.2 = 0.30000000000000004`) are never sent to Postgres.
 */
export function costUsdToMicros(value: number | null): bigint | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("costUsd must be a finite non-negative number or null");
	}
	const micros = BigInt(Math.round(value * 1_000_000));
	if (micros > MAX_USAGE_COST_MICROS) {
		throw new Error("costUsd exceeds the numeric(12,6) column bound");
	}
	return micros;
}

/** Canonical 6-decimal rendering of a micro-dollar amount. */
export function formatCostMicros(micros: bigint): string {
	if (micros < 0n) {
		throw new Error("usage cost must be non-negative");
	}
	const whole = micros / COST_SCALE_FACTOR;
	const fraction = (micros % COST_SCALE_FACTOR).toString().padStart(6, "0");
	return `${whole.toString()}.${fraction}`;
}

export type UsageAggregateRow = {
	prompt_tokens: unknown;
	completion_tokens: unknown;
	cost_usd: unknown;
};

/**
 * Pure aggregation shared by the driver (fed one SQL SUM row, where numerics
 * arrive as decimal strings and bigint sums as strings) and the fake (fed the
 * stored rows). Token totals are plain integers; cost totals are exact
 * micro-dollar BigInts formatted back to a 6-decimal string.
 */
export function aggregateUsageRows(
	rows: Iterable<UsageAggregateRow>,
): UsageTotals {
	let promptTokens = 0;
	let completionTokens = 0;
	let costMicros = 0n;
	let hasCost = false;
	for (const row of rows) {
		promptTokens += tokenCountFromColumn(row.prompt_tokens);
		completionTokens += tokenCountFromColumn(row.completion_tokens);
		const micros = costMicrosFromColumn(row.cost_usd);
		if (micros !== null) {
			costMicros += micros;
			hasCost = true;
		}
	}
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		// No cost-bearing row => null; never claim a trusted zero we did not see.
		costUsd: hasCost ? formatCostMicros(costMicros) : null,
	};
}

function tokenCountFromColumn(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const count = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(count) || count < 0) {
		throw new Error("usage token aggregate is not a non-negative integer");
	}
	return count;
}

function costMicrosFromColumn(value: unknown): bigint | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error("usage cost aggregate is not a non-negative number");
		}
		return BigInt(Math.round(value * 1_000_000));
	}
	if (typeof value === "bigint") {
		if (value < 0n) {
			throw new Error("usage cost aggregate is not a non-negative number");
		}
		return value;
	}
	if (typeof value === "string") {
		return parseCostMicros(value);
	}
	throw new Error("usage cost aggregate has an unsupported type");
}

function parseCostMicros(value: string): bigint {
	const match = COST_DECIMAL_PATTERN.exec(value.trim());
	if (!match) {
		throw new Error("usage cost aggregate is not a valid decimal");
	}
	const whole = BigInt(match[1]);
	const fraction = match[2] ?? "";
	let micros =
		whole * COST_SCALE_FACTOR + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
	// numeric SUM keeps scale 6, but never understate an unexpected extra digit.
	if (fraction.length > 6 && fraction[6] >= "5") {
		micros += 1n;
	}
	return micros;
}

const USAGE_COLUMNS = `id, organization_id, task_id, model_id, provider, prompt_tokens, completion_tokens, cost_usd, created_at`;

const AGGREGATE_COLUMNS = `COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
		COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
		SUM(cost_usd) AS cost_usd,
		COUNT(cost_usd) > 0 AS has_cost`;

const STMT = {
	insert: `INSERT INTO usage_records (
		organization_id, task_id, model_id, provider, prompt_tokens,
		completion_tokens, cost_usd, created_at
	) VALUES (
		$1, $2::uuid, $3, $4, $5, $6, $7::numeric(12,6), now()
	)
	RETURNING ${USAGE_COLUMNS}`,
	sumByTask: `SELECT ${AGGREGATE_COLUMNS}
		FROM usage_records WHERE task_id = $1`,
	sumByOrgSince: `SELECT ${AGGREGATE_COLUMNS}
		FROM usage_records
		WHERE organization_id = $1 AND created_at >= $2`,
} as const;

type UsageAggregateDbRow = {
	prompt_tokens: unknown;
	completion_tokens: unknown;
	cost_usd: unknown;
	has_cost: unknown;
};

export class PostgresUsageRepository implements UsageRepository {
	constructor(private readonly sql: PgSql) {}

	async record(input: UsageRecordInput): Promise<UsageRecordRow> {
		validateUsageInput(input);
		// The cost is bound as a canonical decimal string (not a JS float) and
		// cast to the column's numeric scale; token counts bind as integers.
		const micros = costUsdToMicros(input.costUsd);
		const rows = (await this.sql.unsafe(STMT.insert, [
			input.organizationId,
			input.taskId,
			input.modelId,
			input.provider,
			input.promptTokens,
			input.completionTokens,
			micros === null ? null : formatCostMicros(micros),
		])) as unknown as Array<Record<string, unknown>>;
		if (rows.length === 0) {
			throw new Error("usage insert returned no row");
		}
		return mapUsageRow(rows[0]);
	}

	async sumByTask(taskId: TaskId): Promise<UsageTotals> {
		requireNonEmpty(taskId, "taskId");
		const rows = (await this.sql.unsafe(STMT.sumByTask, [
			taskId,
		])) as unknown as UsageAggregateDbRow[];
		return totalsFromAggregateRow(rows[0]);
	}

	async sumByOrgSince(
		organizationId: OrganizationId,
		since: Date,
	): Promise<UsageTotals> {
		requireNonEmpty(organizationId, "organizationId");
		if (!(since instanceof Date) || Number.isNaN(since.getTime())) {
			throw new Error("since must be a valid Date");
		}
		const rows = (await this.sql.unsafe(STMT.sumByOrgSince, [
			organizationId,
			since,
		])) as unknown as UsageAggregateDbRow[];
		return totalsFromAggregateRow(rows[0]);
	}
}

/** Maps one `usage_records` row; `cost_usd` stays the driver's exact string. */
export function mapUsageRow(row: Record<string, unknown>): UsageRecordRow {
	return {
		id: row.id as string,
		organization_id: row.organization_id as OrganizationId,
		task_id: (row.task_id as TaskId | null | undefined) ?? null,
		model_id: row.model_id as string,
		provider: row.provider as string,
		prompt_tokens: nullableInteger(row.prompt_tokens),
		completion_tokens: nullableInteger(row.completion_tokens),
		// numeric(12,6) via postgres.js is a string; keep it verbatim.
		cost_usd:
			row.cost_usd === null || row.cost_usd === undefined
				? null
				: String(row.cost_usd),
		created_at: row.created_at as Date,
	};
}

function nullableInteger(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	return typeof value === "number" ? value : Number(value);
}

function totalsFromAggregateRow(
	row: UsageAggregateDbRow | undefined,
): UsageTotals {
	if (!row) return aggregateUsageRows([]);
	return aggregateUsageRows([
		{
			prompt_tokens: row.prompt_tokens,
			completion_tokens: row.completion_tokens,
			cost_usd: row.has_cost === true ? row.cost_usd : null,
		},
	]);
}
