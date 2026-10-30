/**
 * Bounded page-size math shared by the review-surface list reads.
 *
 * Wave-8 read paths (approval decisions, run events) are newest/oldest pages
 * over tenant-scoped rows. The bound is applied before the SQL parameter is
 * bound, so a caller can never request an unbounded result set.
 */

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/**
 * Clamps a requested page size into `[1, maxLimit]`; `undefined`/non-finite
 * values collapse to `defaultLimit`. Fractional inputs are floored.
 */
export function clampPageLimit(
	limit: number | undefined,
	defaultLimit: number = DEFAULT_PAGE_LIMIT,
	maxLimit: number = MAX_PAGE_LIMIT,
): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return defaultLimit;
	}
	return Math.max(1, Math.min(maxLimit, Math.floor(limit)));
}
