import {
	type CostPriceTable,
	costPriceTableSchema,
	PlatformError,
} from "@isolate/shared";

/**
 * Trusted price table loading (wave 11).
 *
 * Prices are configuration, never guesses. `COST_PRICE_TABLE` carries a JSON
 * document validated by the shared `costPriceTableSchema`:
 *
 * ```json
 * {
 *   "models": [
 *     {
 *       "modelId": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
 *       "promptTokenUsdPerMillion": 0.27,
 *       "completionTokenUsdPerMillion": 0.85
 *     }
 *   ],
 *   "sandbox": { "cpuSecondUsd": 0.00005, "gibSecondUsd": 0.00001 }
 * }
 * ```
 *
 * Rules:
 * - absent (or empty/whitespace) means `null`: the worker records cost `null`
 *   ("unknown"), never zero and never a fallback price. Boot does not fail for
 *   absence — a worker without prices still runs, it just cannot attribute
 *   spend.
 * - present but malformed fails closed with a bounded `VALIDATION_FAILED`
 *   error. The message names the variable and the rule only; the raw value is
 *   never echoed (it may contain operator data and must not reach a log).
 *
 * Env reading lives here (a boot-time composition concern), not in the
 * handler: `TaskExecutionDeps.priceTable` is always injected.
 */

/** Sentinel error code for a malformed price configuration. */
export const PRICE_TABLE_ERROR_CODE = "VALIDATION_FAILED" as const;

/**
 * Parses the raw `COST_PRICE_TABLE` value. `null` for absent/blank; throws a
 * bounded `PlatformError` when a value is present but not a valid table.
 */
export function parseCostPriceTable(
	raw: string | null | undefined,
): CostPriceTable | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;

	let decoded: unknown;
	try {
		decoded = JSON.parse(trimmed);
	} catch {
		throw new PlatformError(
			PRICE_TABLE_ERROR_CODE,
			"COST_PRICE_TABLE is present but not valid JSON",
		);
	}
	const parsed = costPriceTableSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new PlatformError(
			PRICE_TABLE_ERROR_CODE,
			"COST_PRICE_TABLE is present but does not match the trusted price table schema",
		);
	}
	return parsed.data;
}

/** Reads and validates `COST_PRICE_TABLE` from the process environment. */
export function loadCostPriceTable(
	env: Record<string, string | undefined> = process.env,
): CostPriceTable | null {
	return parseCostPriceTable(env.COST_PRICE_TABLE);
}
