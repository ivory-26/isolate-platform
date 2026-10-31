import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PagerDuty v3 webhook verification.
 *
 * PagerDuty signs the **raw request body** with HMAC-SHA256 and sends
 * `X-PagerDuty-Signature: v1=<hex>`. Unlike the generic receiver there is no
 * timestamp in the signed string: the signature proves authorship, not
 * freshness. Replay control must therefore compare `event.occurred_at` against
 * a trusted clock (`isPagerDutyEventFresh`, ±300 s) in the route before the
 * task is submitted.
 *
 * During rotation the header may carry several signatures (space- or
 * comma-separated `v1=` values); verification accepts any value that matches
 * the configured secret. Verification is fail-closed, constant-time and returns
 * a closed reason union; no failure path echoes the body, signature or secret.
 */

export const PAGERDUTY_SIGNATURE_HEADER = "x-pagerduty-signature";
/** Whole-body cap; the route refuses before parsing JSON. */
export const PAGERDUTY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** A webhook secret shorter than this is treated as not configured. */
export const PAGERDUTY_WEBHOOK_MIN_SECRET_LENGTH = 32;
/** PagerDuty sends no signed timestamp; the route enforces this window. */
export const PAGERDUTY_REPLAY_WINDOW_MS = 300_000;

const MAX_SIGNATURE_HEADER_CHARS = 1024;
const MAX_SIGNATURE_VALUES = 8;
const SIGNATURE_VALUE_PATTERN = /^v1=([0-9a-fA-F]{64})$/;

export type PagerDutyWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type PagerDutyWebhookVerificationFailure =
	| "not_configured"
	| "body_too_large"
	| "missing_headers"
	| "malformed_headers"
	| "malformed_signature"
	| "invalid_signature";

export type PagerDutyWebhookVerification =
	| { ok: true }
	| { ok: false; reason: PagerDutyWebhookVerificationFailure };

export type PagerDutyWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: PagerDutyWebhookHeaders;
	secret: string | null | undefined;
	maxBodyBytes?: number;
};

/** Case-insensitive header lookup for a `Headers` instance or a plain record. */
export function readPagerDutyHeader(
	headers: PagerDutyWebhookHeaders,
	name: string,
): string | null {
	if (headers instanceof Headers) return headers.get(name);
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return typeof value === "string" ? value : null;
		}
	}
	return null;
}

function toBytes(body: string | Uint8Array): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * Verifies one delivery. Order: configuration and size first so a misconfigured
 * receiver cannot be probed with a large body, then the header shape, then the
 * constant-time digest comparison. Any non-`v1=` token rejects the delivery;
 * one matching `v1=` value accepts it.
 */
export function verifyPagerDutyWebhook(
	input: PagerDutyWebhookVerificationInput,
): PagerDutyWebhookVerification {
	const secret = input.secret;
	if (
		typeof secret !== "string" ||
		secret.length < PAGERDUTY_WEBHOOK_MIN_SECRET_LENGTH
	) {
		return { ok: false, reason: "not_configured" };
	}

	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? PAGERDUTY_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const header = readPagerDutyHeader(input.headers, PAGERDUTY_SIGNATURE_HEADER);
	if (header === null || header.length === 0) {
		return { ok: false, reason: "missing_headers" };
	}
	if (header.length > MAX_SIGNATURE_HEADER_CHARS) {
		return { ok: false, reason: "malformed_headers" };
	}

	const values = header
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (values.length === 0) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (values.length > MAX_SIGNATURE_VALUES) {
		return { ok: false, reason: "malformed_headers" };
	}

	const provided: Buffer[] = [];
	for (const value of values) {
		const match = SIGNATURE_VALUE_PATTERN.exec(value);
		if (match === null || match[1] === undefined) {
			return { ok: false, reason: "malformed_signature" };
		}
		provided.push(Buffer.from(match[1], "hex"));
	}

	const expected = createHmac("sha256", secret).update(body).digest();
	let matched = false;
	for (const candidate of provided) {
		// Every candidate has the expected length (64 hex chars = 32 bytes).
		if (
			candidate.length === expected.length &&
			timingSafeEqual(candidate, expected)
		) {
			matched = true;
		}
	}
	if (!matched) {
		return { ok: false, reason: "invalid_signature" };
	}
	return { ok: true };
}

/**
 * Freshness is not covered by the v3 signature. A trusted route compares the
 * unsigned `event.occurred_at` with its own clock and rejects events outside
 * ±`windowMs`; an unparsable timestamp is stale.
 */
export function isPagerDutyEventFresh(
	occurredAt: string,
	nowMs: number,
	windowMs: number = PAGERDUTY_REPLAY_WINDOW_MS,
): boolean {
	if (typeof occurredAt !== "string") return false;
	const occurredMs = Date.parse(occurredAt);
	if (!Number.isFinite(occurredMs) || !Number.isFinite(nowMs)) return false;
	return Math.abs(nowMs - occurredMs) <= windowMs;
}
