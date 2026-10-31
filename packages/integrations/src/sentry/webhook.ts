import { createHmac, timingSafeEqual } from "node:crypto";
import type {
	SentryWebhookHeaders,
	SentryWebhookVerification,
	SentryWebhookVerificationInput,
} from "./types";

/**
 * Sentry webhook transport verification (docs/connectors/sentry.md §4).
 *
 * Sentry signs the exact raw request body with HMAC-SHA256 and sends the hex
 * digest in `Sentry-Hook-Signature`. The timestamp is **not** covered by the
 * signature, so a captured body can be replayed; the receiver therefore
 * enforces its own ±300 s window on `Sentry-Hook-Timestamp` in addition to the
 * fingerprint dedupe.
 *
 * Fail-closed with a closed reason union. No failure path echoes the body,
 * signature, secret or provider text. The resource header selects this
 * verifier; it is never inferred from the body.
 */

export const SENTRY_SIGNATURE_HEADER = "sentry-hook-signature";
export const SENTRY_TIMESTAMP_HEADER = "sentry-hook-timestamp";
export const SENTRY_RESOURCE_HEADER = "sentry-hook-resource";
export const SENTRY_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const SENTRY_WEBHOOK_MIN_SECRET_LENGTH = 16;
export const SENTRY_WEBHOOK_MAX_SKEW_SECONDS = 300;
export const SENTRY_SUPPORTED_RESOURCES = ["issue"] as const;

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const RESOURCE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;

/** Case-insensitive header lookup for a `Headers` instance or a plain record. */
export function readSentryHeader(
	headers: SentryWebhookHeaders,
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
 * Order matters: configuration and size first, then required headers, then
 * resource allowlist, then signature shape, then the constant-time digest,
 * and only then the unsigned timestamp window.
 */
export function verifySentryWebhook(
	input: SentryWebhookVerificationInput,
): SentryWebhookVerification {
	const secret = input.secret;
	if (
		typeof secret !== "string" ||
		secret.length < SENTRY_WEBHOOK_MIN_SECRET_LENGTH
	) {
		return { ok: false, reason: "not_configured" };
	}

	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? SENTRY_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const signature = readSentryHeader(input.headers, SENTRY_SIGNATURE_HEADER);
	const timestamp = readSentryHeader(input.headers, SENTRY_TIMESTAMP_HEADER);
	const resource = readSentryHeader(input.headers, SENTRY_RESOURCE_HEADER);
	if (
		signature === null ||
		signature.length === 0 ||
		timestamp === null ||
		timestamp.length === 0 ||
		resource === null ||
		resource.length === 0
	) {
		return { ok: false, reason: "missing_headers" };
	}
	if (!TIMESTAMP_PATTERN.test(timestamp) || !RESOURCE_PATTERN.test(resource)) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (!(SENTRY_SUPPORTED_RESOURCES as readonly string[]).includes(resource)) {
		return { ok: false, reason: "unsupported_resource" };
	}
	if (!SIGNATURE_HEX_PATTERN.test(signature)) {
		return { ok: false, reason: "malformed_signature" };
	}

	const expected = createHmac("sha256", secret).update(body).digest();
	const provided = Buffer.from(signature, "hex");
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	) {
		return { ok: false, reason: "invalid_signature" };
	}

	const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
	const maxSkew = input.maxSkewSeconds ?? SENTRY_WEBHOOK_MAX_SKEW_SECONDS;
	if (Math.abs(nowSeconds - Number(timestamp)) > maxSkew) {
		return { ok: false, reason: "stale_timestamp" };
	}

	return { ok: true, resource: "issue", timestamp: Number(timestamp) };
}
