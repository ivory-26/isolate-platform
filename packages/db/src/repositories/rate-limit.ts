import { PlatformError } from "@isolate/shared";
import type { PgSql } from "../client";

/**
 * DB-backed fixed-window rate limiting (migration 0012).
 *
 * `consume` is ONE statement: the INSERT seeds a window row and the
 * `ON CONFLICT ... DO UPDATE ... WHERE count < limit` arm increments only while
 * headroom remains. Two concurrent consumers therefore serialize on the
 * `(bucket_key, window_start)` primary key and the (limit + 1)th call returns
 * no row — the limit is enforced in the database, not in process memory, so it
 * holds across replicas.
 *
 * A fixed window avoids the drift of a sliding log: `window_start` is
 * `floor(now / windowSeconds) * windowSeconds`, `expires_at` is the end of that
 * window, and `deleteExpired` removes whole expired buckets in bounded batches.
 *
 * Keys are opaque, server-built identifiers. Validation rejects empty, padded
 * and oversized keys; a caller must never pass a token, body or credential as
 * a key. Every rejection is fixed text.
 */

export const RATE_LIMIT_MAX_KEY_CHARS = 300;
export const RATE_LIMIT_MAX_WINDOW_SECONDS = 86_400;
export const RATE_LIMIT_MAX_LIMIT = 1_000_000;
export const RATE_LIMIT_DEFAULT_DELETE_BATCH = 1_000;
export const RATE_LIMIT_MAX_DELETE_BATCH = 10_000;

export type ConsumeRateLimitInput = {
	/** Opaque server-built bucket key (1–300 characters). */
	key: string;
	/** Calls allowed per fixed window. */
	limit: number;
	/** Window length in whole seconds. */
	windowSeconds: number;
	/** Injected clock; defaults to wall clock. */
	now?: Date;
};

export type ConsumeRateLimitResult = {
	allowed: boolean;
	/** Counter after this call; equals `limit` when refused. */
	count: number;
	remaining: number;
	/** Whole seconds until the window resets; 0 when allowed. */
	retryAfterSeconds: number;
};

export interface RateLimitRepository {
	consume(input: ConsumeRateLimitInput): Promise<ConsumeRateLimitResult>;
	/** Deletes at most `maxRows` expired windows and returns the count. */
	deleteExpired(now: Date, maxRows?: number): Promise<number>;
}

export type NormalizedRateLimitInput = {
	key: string;
	limit: number;
	windowSeconds: number;
	now: Date;
	windowStart: Date;
	expiresAt: Date;
};

function validationError(message: string): PlatformError {
	return new PlatformError("VALIDATION_FAILED", message);
}

/** Shared clock validation; the fake uses the same rejection text. */
export function normalizeRateLimitNow(now: unknown): Date {
	if (now === undefined) return new Date();
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
		throw validationError("now must be a valid Date");
	}
	return new Date(now.getTime());
}

/** A key must be exactly as built: no leading/trailing space, no control chars. */
function requireKey(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw validationError("rate limit key must be a non-empty string");
	}
	if (value.length > RATE_LIMIT_MAX_KEY_CHARS) {
		throw validationError("rate limit key is too long");
	}
	if (value.trim() !== value) {
		throw validationError("rate limit key must not be padded");
	}
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			throw validationError("rate limit key contains control characters");
		}
	}
	return value;
}

function requireLimit(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > RATE_LIMIT_MAX_LIMIT
	) {
		throw validationError("rate limit limit must be a positive integer");
	}
	return value;
}

function requireWindowSeconds(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > RATE_LIMIT_MAX_WINDOW_SECONDS
	) {
		throw validationError("rate limit windowSeconds is invalid");
	}
	return value;
}

export function windowStartFor(now: Date, windowSeconds: number): Date {
	const windowMs = requireWindowSeconds(windowSeconds) * 1000;
	const startMs = Math.floor(now.getTime() / windowMs) * windowMs;
	return new Date(startMs);
}

export function retryAfterSecondsFor(
	now: Date,
	windowStart: Date,
	windowSeconds: number,
): number {
	const resetMs = windowStart.getTime() + windowSeconds * 1000;
	const remainingMs = resetMs - now.getTime();
	return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
}

export function normalizeConsumeRateLimitInput(
	input: ConsumeRateLimitInput,
): NormalizedRateLimitInput {
	const key = requireKey(input.key);
	const limit = requireLimit(input.limit);
	const windowSeconds = requireWindowSeconds(input.windowSeconds);
	const now = normalizeRateLimitNow(input.now);
	const windowStart = windowStartFor(now, windowSeconds);
	return {
		key,
		limit,
		windowSeconds,
		now,
		windowStart,
		expiresAt: new Date(windowStart.getTime() + windowSeconds * 1000),
	};
}

export function normalizeDeleteExpiredBatch(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > RATE_LIMIT_MAX_DELETE_BATCH
	) {
		throw validationError("rate limit delete batch is invalid");
	}
	return value;
}

const STMT = {
	// One atomic statement: a full window yields no row, which is a denial.
	consume: `INSERT INTO rate_limit_counters (
		bucket_key, window_start, count, expires_at
	) VALUES ($1, $2::timestamptz, 1, $3::timestamptz)
	ON CONFLICT (bucket_key, window_start) DO UPDATE
	SET count = rate_limit_counters.count + 1
	WHERE rate_limit_counters.count < $4::integer
	RETURNING count`,
	deleteExpired: `DELETE FROM rate_limit_counters
		WHERE (bucket_key, window_start) IN (
			SELECT bucket_key, window_start FROM rate_limit_counters
			WHERE expires_at <= $1::timestamptz
			ORDER BY expires_at ASC
			LIMIT $2
		)
		RETURNING bucket_key`,
} as const;

export class PostgresRateLimitRepository implements RateLimitRepository {
	constructor(private readonly sql: PgSql) {}

	async consume(input: ConsumeRateLimitInput): Promise<ConsumeRateLimitResult> {
		const normalized = normalizeConsumeRateLimitInput(input);
		const rows = (await this.sql.unsafe(STMT.consume, [
			normalized.key,
			normalized.windowStart.toISOString(),
			normalized.expiresAt.toISOString(),
			normalized.limit,
		])) as unknown as Record<string, unknown>[];
		if (rows.length === 0) {
			// The window is full: the counter is at least the limit. No second
			// query, so a denial costs exactly one round trip.
			return {
				allowed: false,
				count: normalized.limit,
				remaining: 0,
				retryAfterSeconds: retryAfterSecondsFor(
					normalized.now,
					normalized.windowStart,
					normalized.windowSeconds,
				),
			};
		}
		const count = Number(rows[0].count);
		if (!Number.isSafeInteger(count) || count < 1) {
			throw new PlatformError(
				"DB_UNAVAILABLE",
				"rate limit counter is invalid",
			);
		}
		return {
			allowed: true,
			count,
			remaining: Math.max(0, normalized.limit - count),
			retryAfterSeconds: 0,
		};
	}

	async deleteExpired(
		now: Date,
		maxRows: number = RATE_LIMIT_DEFAULT_DELETE_BATCH,
	): Promise<number> {
		const current = normalizeRateLimitNow(now);
		const batch = normalizeDeleteExpiredBatch(maxRows);
		const rows = (await this.sql.unsafe(STMT.deleteExpired, [
			current.toISOString(),
			batch,
		])) as unknown as Record<string, unknown>[];
		return rows.length;
	}
}
