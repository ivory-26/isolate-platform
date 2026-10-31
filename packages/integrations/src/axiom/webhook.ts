import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AXIOM_WEBHOOK_MAX_BODY_BYTES } from "./schemas";

/**
 * Axiom webhook transport verification (`docs/connectors/axiom.md` §4).
 *
 * Signing is **not implemented** and this module does not pretend otherwise:
 * the vendor documents **no HMAC** for the custom webhook notifier, so every
 * successful result is explicitly `status: "unsigned"`. A notifier may send an
 * operator-configured header (`AXIOM_WEBHOOK_HEADER`) carrying
 * `AXIOM_WEBHOOK_SECRET`; that is a shared secret used as authentication, not a
 * signature. The verifier compares it in constant time and reports whether it
 * was present and valid.
 *
 * Because nothing is signed, the caller must treat an accepted delivery as
 * unauthenticated evidence: re-fetch dataset/monitor state through the API
 * before creating a task, enforce the ±15 minute freshness window
 * (`isAxiomAlertFresh`) and dedupe by fingerprint. `docs/connectors/README.md`
 * routes a genuinely signed deployment through the generic signed bridge.
 *
 * Failures are a closed union. No failure path echoes the body, the header
 * value, the secret or any provider text.
 */

export const AXIOM_WEBHOOK_HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** A shared secret shorter than this is treated as misconfigured. */
export const AXIOM_WEBHOOK_MIN_SECRET_LENGTH = 16;
export const MAX_AXIOM_WEBHOOK_HEADER_VALUE_CHARS = 512;
/** Replay control per the connector page: alerts older than 15 minutes die. */
export const AXIOM_REPLAY_WINDOW_MS = 15 * 60 * 1000;

export type AxiomWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type AxiomWebhookVerificationFailure =
	| "body_too_large"
	| "not_configured"
	| "missing_headers"
	| "malformed_headers"
	| "invalid_header";

/**
 * `status: "unsigned"` is the only success shape. `signed: false` and
 * `signature: "none"` make an accidental "verified" reading impossible.
 */
export type AxiomWebhookVerification =
	| {
			ok: true;
			status: "unsigned";
			signed: false;
			signature: "none";
			/** True when the configured shared-header value was supplied. */
			sharedHeaderPresent: boolean;
			/** `null` when no shared header is configured. */
			sharedHeaderValid: boolean | null;
	  }
	| { ok: false; reason: AxiomWebhookVerificationFailure };

export type AxiomWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: AxiomWebhookHeaders;
	/** `AXIOM_WEBHOOK_HEADER`; absent means no shared header is configured. */
	headerName?: string | null;
	/** `AXIOM_WEBHOOK_SECRET`; never logged or returned. */
	secret?: string | null;
	maxBodyBytes?: number;
};

/** Case-insensitive header lookup for `Headers` or a plain record. */
export function readAxiomHeader(
	headers: AxiomWebhookHeaders,
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

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies one delivery. Order: body cap, header-name configuration, shared
 * secret shape, header presence and shape, constant-time comparison.
 *
 * The body is capped but **not parsed or authenticated** here; normalization
 * parses it strictly and freshness is checked against its unsigned timestamp.
 */
export function verifyAxiomWebhook(
	input: AxiomWebhookVerificationInput,
): AxiomWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? AXIOM_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const configuredName =
		typeof input.headerName === "string" ? input.headerName.trim() : "";
	const secret = typeof input.secret === "string" ? input.secret : "";

	if (configuredName.length === 0) {
		// No shared header: nothing can be authenticated. A configured secret
		// without a header name is a misconfiguration, not a silent downgrade.
		if (secret.length > 0) {
			return { ok: false, reason: "not_configured" };
		}
		return {
			ok: true,
			status: "unsigned",
			signed: false,
			signature: "none",
			sharedHeaderPresent: false,
			sharedHeaderValid: null,
		};
	}

	const headerName = configuredName.toLowerCase();
	if (!AXIOM_WEBHOOK_HEADER_PATTERN.test(headerName)) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (secret.length < AXIOM_WEBHOOK_MIN_SECRET_LENGTH) {
		return { ok: false, reason: "not_configured" };
	}

	const provided = readAxiomHeader(input.headers, headerName);
	if (provided === null || provided.length === 0) {
		return { ok: false, reason: "missing_headers" };
	}
	if (
		provided.length > MAX_AXIOM_WEBHOOK_HEADER_VALUE_CHARS ||
		!/^[\x20-\x7E]+$/.test(provided)
	) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (!constantTimeEquals(provided, secret)) {
		return { ok: false, reason: "invalid_header" };
	}

	return {
		ok: true,
		status: "unsigned",
		signed: false,
		signature: "none",
		sharedHeaderPresent: true,
		sharedHeaderValid: true,
	};
}

/**
 * Freshness is not covered by anything: Axiom sends no signature and its
 * timestamp is unsigned data. A trusted caller compares it with its own clock
 * and rejects deliveries outside ±`windowMs`; an unparsable timestamp is stale.
 */
export function isAxiomAlertFresh(
	timestamp: string,
	nowMs: number,
	windowMs: number = AXIOM_REPLAY_WINDOW_MS,
): boolean {
	if (typeof timestamp !== "string") return false;
	const parsed = z.iso.datetime({ offset: true }).safeParse(timestamp);
	if (!parsed.success) return false;
	const timestampMs = Date.parse(parsed.data);
	if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return false;
	return Math.abs(nowMs - timestampMs) <= windowMs;
}
