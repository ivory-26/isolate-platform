import {
	type ConsumeRateLimitInput,
	type ConsumeRateLimitResult,
	normalizeConsumeRateLimitInput,
	normalizeDeleteExpiredBatch,
	normalizeRateLimitNow,
	RATE_LIMIT_DEFAULT_DELETE_BATCH,
	type RateLimitRepository,
	retryAfterSecondsFor,
} from "../repositories/rate-limit";

/**
 * Offline twin of `PostgresRateLimitRepository`.
 *
 * The same pure normalizers run here, so the fake cannot accept a key or window
 * the database CHECKs would reject. `consume` is a synchronous
 * read-modify-write with no `await` between the check and the increment, which
 * mirrors the single `INSERT ... ON CONFLICT` statement: concurrent callers
 * (`Promise.all`) serialize and can never pass the limit.
 */

type StoredWindow = {
	bucketKey: string;
	windowStartMs: number;
	count: number;
	expiresAtMs: number;
};

function windowId(bucketKey: string, windowStartMs: number): string {
	return `${windowStartMs}\u0000${bucketKey}`;
}

export class InMemoryRateLimitRepository implements RateLimitRepository {
	private readonly rows = new Map<string, StoredWindow>();

	async consume(input: ConsumeRateLimitInput): Promise<ConsumeRateLimitResult> {
		const normalized = normalizeConsumeRateLimitInput(input);
		const id = windowId(normalized.key, normalized.windowStart.getTime());
		const existing = this.rows.get(id);
		if (existing !== undefined && existing.count >= normalized.limit) {
			return {
				allowed: false,
				count: existing.count,
				remaining: 0,
				retryAfterSeconds: retryAfterSecondsFor(
					normalized.now,
					normalized.windowStart,
					normalized.windowSeconds,
				),
			};
		}
		const next: StoredWindow = {
			bucketKey: normalized.key,
			windowStartMs: normalized.windowStart.getTime(),
			count: (existing?.count ?? 0) + 1,
			expiresAtMs: normalized.expiresAt.getTime(),
		};
		this.rows.set(id, next);
		return {
			allowed: true,
			count: next.count,
			remaining: Math.max(0, normalized.limit - next.count),
			retryAfterSeconds: 0,
		};
	}

	async deleteExpired(
		now: Date,
		maxRows: number = RATE_LIMIT_DEFAULT_DELETE_BATCH,
	): Promise<number> {
		const current = normalizeRateLimitNow(now);
		const batch = normalizeDeleteExpiredBatch(maxRows);
		const expired = [...this.rows.entries()]
			.filter(([, row]) => row.expiresAtMs <= current.getTime())
			.sort((left, right) => left[1].expiresAtMs - right[1].expiresAtMs)
			.slice(0, batch);
		for (const [id] of expired) this.rows.delete(id);
		return expired.length;
	}

	/** Test-only visibility; never part of the repository contract. */
	countFor(key: string, windowStart: Date): number {
		const row = this.rows.get(windowId(key, windowStart.getTime()));
		return row === undefined ? 0 : row.count;
	}

	/** Test-only visibility; never part of the repository contract. */
	get rowCount(): number {
		return this.rows.size;
	}
}
