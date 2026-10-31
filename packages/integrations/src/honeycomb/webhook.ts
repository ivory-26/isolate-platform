import { createHash, timingSafeEqual } from "node:crypto";
import type {
	HoneycombWebhookHeaders,
	HoneycombWebhookVerification,
	HoneycombWebhookVerificationInput,
} from "./types";

/**
 * Honeycomb webhook transport (`docs/connectors/honeycomb.md` §4).
 *
 * Honeycomb sends **no HMAC signature** for webhook triggers. The
 * per-recipient `X-Honeycomb-Webhook-Token` is authentication, not message
 * signing, and this module cannot verify it without the shared token. A
 * trusted bridge performs the constant-time token check and passes
 * `bridgeVerified: true`; this verifier then reports the exact truth:
 * `status: "unsigned"`, `signedByVendor: false`. A missing or false bridge flag
 * is a closed failure (`not_bridge_verified`), never an implicit success.
 *
 * The body cap is enforced before anything else. No path echoes the body,
 * token, headers or provider text.
 */

export const HONEYCOMB_WEBHOOK_TOKEN_HEADER = "x-honeycomb-webhook-token";
export const HONEYCOMB_DELIVERY_HEADER = "x-honeycomb-webhook-delivery-id";
export const HONEYCOMB_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const HONEYCOMB_WEBHOOK_MIN_TOKEN_LENGTH = 16;

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/** Case-insensitive header lookup for a `Headers` instance or a plain record. */
export function readHoneycombHeader(
	headers: HoneycombWebhookHeaders,
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

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time comparison of the shared webhook token. The bridge calls this
 * before it sets `bridgeVerified`; the verifier itself never sees the token.
 * Hashing both values keeps the comparison fixed-width and length-independent.
 */
export function verifyHoneycombWebhookToken(
	provided: string | null | undefined,
	expected: string | null | undefined,
): boolean {
	if (
		typeof expected !== "string" ||
		expected.length < HONEYCOMB_WEBHOOK_MIN_TOKEN_LENGTH
	) {
		return false;
	}
	if (typeof provided !== "string" || provided.length === 0) return false;
	return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Verifies one delivery's transport envelope. The caller supplies the bridge
 * verdict, because only the bridge holds the shared token; this function never
 * pretends a vendor signature exists.
 */
export function verifyHoneycombDelivery(
	input: HoneycombWebhookVerificationInput,
): HoneycombWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? HONEYCOMB_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}
	if (input.bridgeVerified !== true) {
		return { ok: false, reason: "not_bridge_verified" };
	}

	const deliveryId = readHoneycombHeader(
		input.headers,
		HONEYCOMB_DELIVERY_HEADER,
	);
	if (deliveryId !== null && !DELIVERY_ID_PATTERN.test(deliveryId)) {
		return { ok: false, reason: "malformed_headers" };
	}

	return {
		ok: true,
		status: "unsigned",
		signedByVendor: false,
		bridgeVerified: true,
		deliveryId,
	};
}
