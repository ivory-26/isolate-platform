import {
	PlatformError,
	type RunSummary,
	type ValidationStatus,
} from "@isolate/shared";

/**
 * Pure per-task run summary (wave 11).
 *
 * Assembles the shared `RunSummary` from durable rows only — no database
 * import, no clock, no I/O — so it can be tested with literal rows and bound by
 * the composition root to the Postgres repositories.
 *
 * Inputs are bounded projections, not full rows:
 * - `task`: id, status and the recorded pull request (when one exists);
 * - `usage`: `usage_records` rows (model + sandbox), costs read as the exact
 *   decimal strings postgres.js returns for `numeric(12,6)`;
 * - `attempts`: `task_attempts` rows. Each attempt may carry the measured
 *   `sandboxSeconds` the handler wrote into its outcome at teardown, and its
 *   `validation` report (the configured command gate);
 * - `artifacts`: any artifact list — only the count is used.
 *
 * Rules:
 * - tokens and cost are summed; costs are accumulated as integer micro-dollars
 *   so binary floats never drift the 6-decimal amount;
 * - cost stays `null` when no row carried a price — never a trusted zero we
 *   did not see;
 * - sandbox seconds are the floored sum of measured attempt sandbox time, so a
 *   run that never provisioned a sandbox reports 0 rather than a guess;
 * - an unparseable cost (string with the wrong shape, negative number, ...)
 *   fails closed with a bounded `VALIDATION_FAILED` error.
 */

export type RunSummaryTaskRow = {
	readonly id: string;
	readonly status: string;
	readonly pull_request_number: number | null;
	readonly pull_request_url: string | null;
};

/** Bounded projection of one `usage_records` row. */
export type RunSummaryUsageRow = {
	readonly prompt_tokens: number | string | null;
	readonly completion_tokens: number | string | null;
	/** Exact decimal string (or number in fakes); `null` means unknown. */
	readonly cost_usd: number | string | bigint | null;
};

/** Bounded projection of one `task_attempts` row. */
export type RunSummaryAttemptRow = {
	readonly outcome?: unknown;
};

export type RunSummaryInput = {
	readonly task: RunSummaryTaskRow;
	readonly usage: readonly RunSummaryUsageRow[];
	readonly attempts: readonly RunSummaryAttemptRow[];
	readonly artifacts: readonly unknown[];
	/**
	 * Gate outcome. Omitted means "read it from the latest attempt"; `null`
	 * means no gate ran at all.
	 */
	readonly validation?: ValidationStatus | null;
};

const MAX_TASK_ID_CHARS = 64;
const MAX_STATUS_CHARS = 64;
const MAX_ATTEMPTS = 1000;
const MAX_ARTIFACTS = 10_000;
const MAX_PR_URL_CHARS = 512;
const MAX_SANDBOX_SECONDS = 30 * 24 * 60 * 60;

const COST_SCALE_FACTOR = 1_000_000n;
const MAX_COST_MICROS = 999_999_999_999n;
const COST_DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

const VALIDATION_STATUSES: ReadonlySet<string> = new Set<ValidationStatus>([
	"passed",
	"failed",
	"skipped",
]);

function invalid(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

function tokenCount(value: number | string | null, field: string): number {
	if (value === null) return 0;
	const count = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(count) || count < 0) {
		throw invalid(`usage ${field} is not a non-negative integer`);
	}
	return count;
}

function costMicros(value: RunSummaryUsageRow["cost_usd"]): bigint | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) {
			throw invalid("usage cost is not a bounded decimal");
		}
		return BigInt(Math.round(value * 1_000_000));
	}
	if (typeof value === "bigint") {
		if (value < 0n || value > MAX_COST_MICROS) {
			throw invalid("usage cost is not a bounded decimal");
		}
		return value;
	}
	if (typeof value === "string") {
		const match = COST_DECIMAL_PATTERN.exec(value.trim());
		if (match === null) throw invalid("usage cost is not a bounded decimal");
		const whole = BigInt(match[1]);
		const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
		const micros = whole * COST_SCALE_FACTOR + BigInt(fraction);
		if (micros > MAX_COST_MICROS) {
			throw invalid("usage cost is not a bounded decimal");
		}
		return micros;
	}
	throw invalid("usage cost is not a bounded decimal");
}

/** Exact 6-decimal USD amount from integer micro-dollars. */
function microsToUsd(micros: bigint): number {
	return Math.round(Number(micros)) / 1_000_000;
}

function sandboxSecondsFrom(attempts: readonly RunSummaryAttemptRow[]): number {
	let seconds = 0;
	for (const attempt of attempts) {
		const outcome = attempt.outcome;
		if (outcome === null || typeof outcome !== "object") continue;
		const measured = (outcome as Record<string, unknown>).sandboxSeconds;
		if (typeof measured !== "number" || !Number.isFinite(measured)) continue;
		seconds += Math.max(0, measured);
	}
	return Math.min(Math.floor(seconds), MAX_SANDBOX_SECONDS);
}

function validationFromAttempts(
	attempts: readonly RunSummaryAttemptRow[],
): ValidationStatus | null {
	for (let index = attempts.length - 1; index >= 0; index--) {
		const outcome = attempts[index]?.outcome;
		if (outcome === null || typeof outcome !== "object") continue;
		const validation = (outcome as Record<string, unknown>).validation;
		if (validation === null || typeof validation !== "object") continue;
		const status = (validation as Record<string, unknown>).status;
		if (typeof status === "string" && VALIDATION_STATUSES.has(status)) {
			return status as ValidationStatus;
		}
	}
	return null;
}

function pullRequestFrom(task: RunSummaryTaskRow): RunSummary["pullRequest"] {
	const number = task.pull_request_number;
	const url = task.pull_request_url;
	if (
		typeof number !== "number" ||
		!Number.isInteger(number) ||
		number <= 0 ||
		typeof url !== "string" ||
		url.length === 0
	) {
		return null;
	}
	return { number, url: url.slice(0, MAX_PR_URL_CHARS) };
}

/**
 * Builds the bounded per-task rollup. Pure: same rows in, same summary out.
 */
export function buildRunSummary(input: RunSummaryInput): RunSummary {
	let promptTokens = 0;
	let completionTokens = 0;
	let costMicrosTotal = 0n;
	let hasCost = false;
	for (const row of input.usage) {
		promptTokens += tokenCount(row.prompt_tokens, "promptTokens");
		completionTokens += tokenCount(row.completion_tokens, "completionTokens");
		const micros = costMicros(row.cost_usd);
		if (micros !== null) {
			costMicrosTotal += micros;
			hasCost = true;
		}
	}
	if (costMicrosTotal > MAX_COST_MICROS) {
		throw invalid("usage cost is not a bounded decimal");
	}

	const validation =
		input.validation === undefined
			? validationFromAttempts(input.attempts)
			: input.validation;

	return {
		taskId: input.task.id.slice(0, MAX_TASK_ID_CHARS),
		status: input.task.status.slice(0, MAX_STATUS_CHARS),
		promptTokens,
		completionTokens,
		sandboxSeconds: sandboxSecondsFrom(input.attempts),
		costUsd: hasCost ? microsToUsd(costMicrosTotal) : null,
		attempts: Math.min(input.attempts.length, MAX_ATTEMPTS),
		artifacts: Math.min(input.artifacts.length, MAX_ARTIFACTS),
		validation,
		pullRequest: pullRequestFrom(input.task),
	};
}

/** Latest attempt's validation report status, or `null` when no gate ran. */
export function validationOutcomeFromAttempts(
	attempts: readonly RunSummaryAttemptRow[],
): ValidationStatus | null {
	return validationFromAttempts(attempts);
}
