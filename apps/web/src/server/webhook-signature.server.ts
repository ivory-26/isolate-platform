import "@tanstack/react-start/server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Generic signed-webhook transport (H12-4).
 *
 * HMAC-SHA256 over `${timestamp}.${rawBody}`. The secret is server-only and
 * never leaves this module; neither the secret, the signature nor the raw body
 * is ever logged or echoed. Verification fails closed and returns a bounded
 * reason code, never an exception with payload text.
 */
export const WEBHOOK_TIMESTAMP_HEADER = "x-isolate-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "x-isolate-signature";
export const WEBHOOK_SIGNATURE_PREFIX = "sha256=";
/** 64 KiB is the whole body cap; the receiver rejects before parsing. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Signed timestamps outside this window are refused as stale. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
/** A webhook secret shorter than this is treated as not configured. */
export const WEBHOOK_MIN_SECRET_LENGTH = 32;

export type WebhookVerificationFailure =
	| "not_configured"
	| "body_too_large"
	| "missing_headers"
	| "malformed_timestamp"
	| "stale_timestamp"
	| "malformed_signature"
	| "invalid_signature";

export type WebhookVerification =
	| { ok: true; timestamp: number }
	| { ok: false; reason: WebhookVerificationFailure };

export type WebhookVerificationInput = {
	rawBody: string | Uint8Array;
	timestamp: string | null | undefined;
	signature: string | null | undefined;
	secret: string | null | undefined;
	/** Clock seam; defaults to wall clock. */
	now?: Date | number;
	toleranceSeconds?: number;
	maxBodyBytes?: number;
};

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;

function toBytes(body: string | Uint8Array): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

function nowSeconds(now: Date | number | undefined): number {
	if (now === undefined) return Math.floor(Date.now() / 1000);
	const millis = typeof now === "number" ? now : now.getTime();
	return Math.floor(millis / 1000);
}

/**
 * Verifies one delivery. Order matters: configuration and body size first so a
 * misconfigured receiver cannot be probed with a huge body, then headers, then
 * freshness, then the constant-time digest comparison.
 */
export function verifyWebhookSignature(
	input: WebhookVerificationInput,
): WebhookVerification {
	const secret = input.secret;
	if (typeof secret !== "string" || secret.length < WEBHOOK_MIN_SECRET_LENGTH)
		return { ok: false, reason: "not_configured" };

	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes)
		return { ok: false, reason: "body_too_large" };

	if (
		typeof input.timestamp !== "string" ||
		input.timestamp.length === 0 ||
		typeof input.signature !== "string" ||
		input.signature.length === 0
	)
		return { ok: false, reason: "missing_headers" };

	if (!TIMESTAMP_PATTERN.test(input.timestamp))
		return { ok: false, reason: "malformed_timestamp" };
	const timestamp = Number(input.timestamp);
	const tolerance =
		input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
	if (Math.abs(nowSeconds(input.now) - timestamp) > tolerance)
		return { ok: false, reason: "stale_timestamp" };

	const signature = input.signature;
	if (!signature.startsWith(WEBHOOK_SIGNATURE_PREFIX))
		return { ok: false, reason: "malformed_signature" };
	const providedHex = signature.slice(WEBHOOK_SIGNATURE_PREFIX.length);
	if (!SIGNATURE_HEX_PATTERN.test(providedHex))
		return { ok: false, reason: "malformed_signature" };

	const expected = createHmac("sha256", secret)
		.update(`${input.timestamp}.`)
		.update(body)
		.digest();
	const provided = Buffer.from(providedHex, "hex");
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	)
		return { ok: false, reason: "invalid_signature" };

	return { ok: true, timestamp };
}

/** Header access that works with a `Headers` instance or a plain record. */
export function readWebhookHeader(
	headers: Headers | Readonly<Record<string, string | null | undefined>>,
	name: string,
): string | null {
	if (headers instanceof Headers) return headers.get(name);
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers))
		if (key.toLowerCase() === wanted) return value ?? null;
	return null;
}

/** Raised by the receiver when a delivery exceeds the body cap. */
export class WebhookBodyTooLargeError extends Error {
	constructor() {
		super("webhook body exceeds the size cap");
		this.name = "WebhookBodyTooLargeError";
	}
}

/**
 * Reads a request body up to `maxBytes` without buffering an unbounded stream.
 * A declared `content-length` above the cap is refused before reading; the
 * streamed total is checked again because the header is advisory.
 */
export async function readBoundedWebhookBody(
	request: Request,
	maxBytes: number = WEBHOOK_MAX_BODY_BYTES,
): Promise<Uint8Array> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > maxBytes)
			throw new WebhookBodyTooLargeError();
	}
	if (request.body === null) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let finished = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				finished = true;
				break;
			}
			total += next.value.byteLength;
			if (total > maxBytes) throw new WebhookBodyTooLargeError();
			chunks.push(next.value);
		}
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
