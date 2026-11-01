import type {
	CostCoverage,
	UsageDay,
	UsagePeriod,
	UsageReadModel,
	UsageTotals,
} from "./contracts";

/**
 * Pure usage aggregation over the tenant-scoped SQL result sets.
 *
 * Money never passes through binary floating-point addition: daily cost
 * strings are parsed to integer micro-dollars, summed as BigInt and rendered
 * back to a canonical 6-decimal string. A day with no priced row stays null —
 * never a trusted zero the provider did not report.
 */

const DAY_MS = 86_400_000;
const COST_SCALE = 1_000_000n;
const COST_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export type UsageDayRow = {
	day: unknown;
	prompt_tokens: unknown;
	completion_tokens: unknown;
	cost_usd: unknown;
	known_cost_rows: unknown;
	total_rows: unknown;
};

export type SandboxDayRow = {
	day: unknown;
	sandbox_seconds: unknown;
};

export type UsageWindow = {
	since: Date;
	/** Exclusive. */
	until: Date;
	/** UTC `YYYY-MM-DD` labels, oldest first. */
	days: string[];
};

/** Fixed UTC window: N calendar days ending with today, inclusive. */
export function buildUsageWindow(period: UsagePeriod, now: Date): UsageWindow {
	const todayStart = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const until = todayStart + DAY_MS;
	const since = until - period * DAY_MS;
	const days = Array.from({ length: period }, (_, index) =>
		new Date(since + index * DAY_MS).toISOString().slice(0, 10),
	);
	return { since: new Date(since), until: new Date(until), days };
}

function dayKey(value: unknown): string {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	if (typeof value === "string") {
		if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed.toISOString().slice(0, 10);
		}
	}
	throw new Error("usage read returned an invalid day");
}

function integer(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error("usage read returned an invalid count");
	}
	return parsed;
}

function seconds(value: unknown): number {
	if (value === null || value === undefined) return 0;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error("usage read returned an invalid sandbox duration");
	}
	return parsed;
}

/** Parses one exact cost value into micro-dollars; null stays null. */
export function costMicros(value: unknown): bigint | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") {
		if (value < 0n) throw new Error("usage cost must be non-negative");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error("usage cost must be non-negative");
		}
		return BigInt(Math.round(value * 1_000_000));
	}
	if (typeof value === "string") {
		const match = COST_PATTERN.exec(value.trim());
		if (match === null) throw new Error("usage cost is not a decimal");
		const whole = BigInt(match[1]);
		const fraction = (match[2] ?? "").padEnd(6, "0").slice(0, 6);
		return whole * COST_SCALE + BigInt(fraction);
	}
	throw new Error("usage cost has an unsupported type");
}

/** Canonical 6-decimal USD string from micro-dollars. */
export function formatCostMicros(micros: bigint): string {
	if (micros < 0n) throw new Error("usage cost must be non-negative");
	const whole = micros / COST_SCALE;
	const fraction = (micros % COST_SCALE).toString().padStart(6, "0");
	return `${whole.toString()}.${fraction}`;
}

function coverage(knownRows: number, totalRows: number): CostCoverage {
	if (knownRows <= 0) return "none";
	return knownRows >= totalRows ? "complete" : "partial";
}

export function aggregateUsage(input: {
	period: UsagePeriod;
	now: Date;
	usageRows: readonly UsageDayRow[];
	sandboxRows: readonly SandboxDayRow[];
	taskCount: unknown;
}): UsageReadModel {
	const window = buildUsageWindow(input.period, input.now);
	const byDay = new Map(
		window.days.map((day) => [
			day,
			{
				promptTokens: 0,
				completionTokens: 0,
				costMicros: 0n,
				knownCostRows: 0,
				totalRows: 0,
				sandboxSeconds: 0,
			},
		]),
	);
	let recordCount = 0;
	let knownCostRows = 0;
	let totalRows = 0;
	let costTotal = 0n;

	for (const row of input.usageRows) {
		const key = dayKey(row.day);
		const bucket = byDay.get(key);
		if (!bucket) continue;
		bucket.promptTokens += integer(row.prompt_tokens);
		bucket.completionTokens += integer(row.completion_tokens);
		bucket.knownCostRows += integer(row.known_cost_rows);
		bucket.totalRows += integer(row.total_rows);
		const micros = costMicros(row.cost_usd);
		if (micros !== null) bucket.costMicros += micros;
		recordCount += integer(row.total_rows);
		knownCostRows += integer(row.known_cost_rows);
		totalRows += integer(row.total_rows);
		if (micros !== null) costTotal += micros;
	}

	for (const row of input.sandboxRows) {
		const key = dayKey(row.day);
		const bucket = byDay.get(key);
		if (!bucket) continue;
		bucket.sandboxSeconds += seconds(row.sandbox_seconds);
	}

	const days: UsageDay[] = window.days.map((day) => {
		const bucket = byDay.get(day) ?? {
			promptTokens: 0,
			completionTokens: 0,
			costMicros: 0n,
			knownCostRows: 0,
			totalRows: 0,
			sandboxSeconds: 0,
		};
		const dayCoverage = coverage(bucket.knownCostRows, bucket.totalRows);
		return {
			day,
			promptTokens: bucket.promptTokens,
			completionTokens: bucket.completionTokens,
			totalTokens: bucket.promptTokens + bucket.completionTokens,
			sandboxSeconds: bucket.sandboxSeconds,
			costUsd:
				dayCoverage === "none" ? null : formatCostMicros(bucket.costMicros),
			costCoverage: dayCoverage,
		};
	});

	const promptTokens = days.reduce((sum, day) => sum + day.promptTokens, 0);
	const completionTokens = days.reduce(
		(sum, day) => sum + day.completionTokens,
		0,
	);
	const sandboxSeconds = Math.floor(
		days.reduce((sum, day) => sum + day.sandboxSeconds, 0),
	);
	const totalCoverage = coverage(knownCostRows, totalRows);
	const totals: UsageTotals = {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		sandboxSeconds,
		costUsd: totalCoverage === "none" ? null : formatCostMicros(costTotal),
		costCoverage: totalCoverage,
		tasks: integer(input.taskCount),
	};

	return {
		period: input.period,
		since: window.since.toISOString(),
		until: window.until.toISOString(),
		timeZone: "UTC",
		totals,
		days,
		hasRows: recordCount > 0 || sandboxSeconds > 0,
	};
}

/**
 * Presentation helper for exact cost strings. Keeps enough precision for
 * sub-cent amounts without turning whole dollars into six trailing zeros.
 */
export function formatUsd(value: string | number | null): string {
	if (value === null) return "—";
	const amount = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(amount)) return "—";
	const digits = amount === 0 ? 2 : amount < 0.01 ? 6 : amount < 1 ? 4 : 2;
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(amount);
}
