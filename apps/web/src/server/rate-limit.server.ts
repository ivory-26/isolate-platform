import "@tanstack/react-start/server-only";
import type { RateLimitRepository } from "@isolate/db";

/**
 * DB-backed request throttling for the web edge (wave 18).
 *
 * Every counter lives in `rate_limit_counters` (migration 0012) and is consumed
 * with one upsert, so the limit holds across replicas instead of drifting in
 * process memory. This module owns the HTTP translation and the bucket naming;
 * it stores no request value verbatim:
 *
 * - `ip:<address>:device` — pre-auth gateway bucket, one per client address;
 * - `device:<id>:<action>` — post-auth per-device bucket;
 * - `user:<id>:<action>` — per-user bucket on the session routes;
 * - `webhook:<mode>:global` — intake bucket per detected provider mode.
 *
 * A denial is ONE fixed 429: `{ error }`, `Retry-After` (whole seconds until the
 * window resets) and `Cache-Control: no-store`. No limit, key, counter or
 * request value is echoed. A limiter failure is not swallowed here: the caller
 * turns it into its own fixed 503, so a database outage never silently disables
 * throttling.
 */

export const TRUST_PROXY_HEADERS_VARIABLE = "TRUST_PROXY_HEADERS";
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_DENIED_MESSAGE = "too many requests";

/** Pre-auth bucket: 600 device requests per minute per client address. */
export const DEVICE_IP_RATE_LIMIT = 600;
/** Post-auth per-device buckets. */
export const DEVICE_CLAIM_RATE_LIMIT = 120;
export const DEVICE_RESULT_RATE_LIMIT = 240;
export const DEVICE_HEARTBEAT_RATE_LIMIT = 60;
/** Per-mode global intake bucket (webhook deliveries have no session). */
export const WEBHOOK_MODE_RATE_LIMIT = 600;

/** Shared pre-auth bucket used when proxy headers are not trusted. */
export const UNTRUSTED_CLIENT_IP = "direct";

const MAX_CLIENT_IP_CHARS = 45;
const CLIENT_IP_PATTERN = /^[0-9a-f:.]+$/i;

export type RateLimitCounter = Pick<RateLimitRepository, "consume">;

/**
 * Only the literal `true` (trimmed, case-insensitive) makes the server read
 * `x-forwarded-for`. Without it the header is attacker-controlled and must be
 * ignored, so every request shares one pre-auth bucket.
 */
export function isTrustProxyHeadersEnabled(
	env: Record<string, string | undefined>,
): boolean {
	const value = env[TRUST_PROXY_HEADERS_VARIABLE];
	return value !== undefined && value.trim().toLowerCase() === "true";
}

/**
 * Bounded, printable client address or the shared fallback. The first
 * `x-forwarded-for` hop is the client only when a trusted proxy overwrites the
 * header; anything malformed, empty or oversized collapses to the fallback so a
 * crafted header can neither widen a bucket nor inject into a key.
 */
export function normalizeClientIp(value: string | null): string {
	if (value === null) return UNTRUSTED_CLIENT_IP;
	const first = value.split(",")[0]?.trim() ?? "";
	if (first.length === 0 || first.length > MAX_CLIENT_IP_CHARS) {
		return UNTRUSTED_CLIENT_IP;
	}
	return CLIENT_IP_PATTERN.test(first)
		? first.toLowerCase()
		: UNTRUSTED_CLIENT_IP;
}

export function readClientIp(
	request: Request,
	trustProxyHeaders: boolean,
): string {
	if (!trustProxyHeaders) return UNTRUSTED_CLIENT_IP;
	return normalizeClientIp(request.headers.get("x-forwarded-for"));
}

export function deviceIpRateLimitKey(clientIp: string): string {
	return `ip:${clientIp}:device`;
}

export type DeviceRateLimitAction = "claim" | "result" | "heartbeat";

export function deviceRateLimitKey(
	deviceId: string,
	action: DeviceRateLimitAction,
): string {
	return `device:${deviceId}:${action}`;
}

export type UserRateLimitAction =
	| "device:register"
	| "device:list"
	| "device:revoke"
	| "connector:connect"
	| "connector:list"
	| "connector:revoke";

/** Fixed per-user budgets; every window is one minute. */
export const USER_RATE_LIMITS = {
	"device:register": 10,
	"device:list": 120,
	"device:revoke": 30,
	"connector:connect": 30,
	"connector:list": 120,
	"connector:revoke": 30,
} as const satisfies Record<UserRateLimitAction, number>;

export function userRateLimitKey(
	userId: string,
	action: UserRateLimitAction,
): string {
	return `user:${userId}:${action}`;
}

export function webhookRateLimitKey(mode: string): string {
	return `webhook:${mode}:global`;
}

/** The single fixed denial; `Retry-After` is always a positive integer. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
	const seconds =
		Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 1
			? Math.ceil(retryAfterSeconds)
			: 1;
	return Response.json(
		{ error: RATE_LIMIT_DENIED_MESSAGE },
		{
			status: 429,
			headers: {
				"cache-control": "no-store",
				"retry-after": String(seconds),
			},
		},
	);
}

/** Thrown by the scope gate; route adapters map it to `rateLimitedResponse`. */
export class RateLimitExceededError extends Error {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super("rate limit exceeded");
		this.name = "RateLimitExceededError";
		this.retryAfterSeconds =
			Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 1
				? Math.ceil(retryAfterSeconds)
				: 1;
	}
}

export type EnforceRateLimitInput = {
	limiter: RateLimitCounter;
	key: string;
	limit: number;
	windowSeconds: number;
	/** Test seam: the instant the window is judged against. */
	now?: Date;
};

/**
 * Consumes one unit. Returns `null` when the call may proceed, otherwise the
 * fixed 429. Validation (key shape, limit, window) belongs to the repository
 * normalizers, so a bad key throws instead of silently checking nothing.
 */
export async function enforceRateLimit(
	input: EnforceRateLimitInput,
): Promise<Response | null> {
	const consumed = await input.limiter.consume({
		key: input.key,
		limit: input.limit,
		windowSeconds: input.windowSeconds,
		...(input.now === undefined ? {} : { now: input.now }),
	});
	return consumed.allowed
		? null
		: rateLimitedResponse(consumed.retryAfterSeconds);
}

export type UserRateLimitGate = {
	/** Throws `RateLimitExceededError`; resolves when the call may proceed. */
	enforce(userId: string, action: UserRateLimitAction): Promise<void>;
};

/**
 * Per-user gate for the session routes. Call it AFTER `resolveCallerScope` and
 * the capability check: an unauthenticated or forbidden caller never spends a
 * signed-in user's quota.
 */
export function createUserRateLimitGate(
	limiter: RateLimitCounter,
	windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): UserRateLimitGate {
	return {
		async enforce(userId, action) {
			const consumed = await limiter.consume({
				key: userRateLimitKey(userId, action),
				limit: USER_RATE_LIMITS[action],
				windowSeconds,
			});
			if (!consumed.allowed) {
				throw new RateLimitExceededError(consumed.retryAfterSeconds);
			}
		},
	};
}
