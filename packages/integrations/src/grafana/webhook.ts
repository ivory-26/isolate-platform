import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Grafana webhook transport verification (`docs/connectors/grafana.md` §4).
 *
 * Grafana signs the notification with HMAC-SHA256, hex-encoded, in a header
 * that defaults to `X-Grafana-Alerting-Signature`. When the contact point also
 * configures a timestamp header, the signed string is
 * `<timestamp-header-value>:<rawBody>`; otherwise it is the raw body alone.
 *
 * There is no default timestamp header: without one there is no replay
 * protection, and the result says so (`signedString: "body"`). A missing
 * secret never yields a valid result — it yields `status: "unsigned"`, which a
 * caller must treat as "not verified", never as "verified".
 *
 * Failures are a closed union. No failure path echoes the body, signature,
 * timestamp, secret or any provider text.
 */

export const GRAFANA_SIGNATURE_HEADER = "x-grafana-alerting-signature";
export const GRAFANA_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const GRAFANA_WEBHOOK_REPLAY_WINDOW_SECONDS = 300;
/** A webhook secret shorter than this is treated as misconfigured. */
export const GRAFANA_WEBHOOK_MIN_SECRET_LENGTH = 32;

const SIGNATURE_VALUE_PATTERN = /^(?:sha256=)?([0-9a-fA-F]{64})$/i;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const EPOCH_SECONDS_PATTERN = /^[0-9]{10}$/;
const EPOCH_MILLIS_PATTERN = /^[0-9]{13}$/;
const ISO_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type GrafanaWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type GrafanaWebhookVerificationFailure =
	| "body_too_large"
	| "not_configured"
	| "missing_headers"
	| "malformed_headers"
	| "malformed_signature"
	| "stale_timestamp"
	| "invalid_signature";

export type GrafanaWebhookVerification =
	| {
			ok: true;
			status: "signed";
			/** `timestamp_body` only when a timestamp header was configured. */
			signedString: "timestamp_body" | "body";
			timestampMs: number | null;
			timestampHeader: string | null;
			signatureHeader: string;
	  }
	| {
			ok: true;
			status: "unsigned";
			/** A signature header arrived, but no secret is configured. */
			signaturePresent: boolean;
	  }
	| { ok: false; reason: GrafanaWebhookVerificationFailure };

export type GrafanaWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: GrafanaWebhookHeaders;
	secret?: string | null;
	/** Operator-supplied header name; no default, so no replay protection. */
	timestampHeader?: string | null;
	/** Defaults to `x-grafana-alerting-signature`. */
	signatureHeader?: string;
	/** Injected clock; defaults to wall clock. */
	nowMs?: number;
	maxBodyBytes?: number;
	replayWindowSeconds?: number;
};

/** Case-insensitive header lookup for `Headers` or a plain record. */
export function readGrafanaHeader(
	headers: GrafanaWebhookHeaders,
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
 * Parses a configured timestamp header. Accepts epoch seconds, epoch
 * milliseconds or an ISO-8601 instant with an explicit zone. Returns
 * `undefined` for anything else; the caller maps that to `malformed_headers`.
 */
export function parseGrafanaTimestamp(value: string): number | undefined {
	if (EPOCH_SECONDS_PATTERN.test(value)) {
		return Number(value) * 1000;
	}
	if (EPOCH_MILLIS_PATTERN.test(value)) {
		return Number(value);
	}
	if (!ISO_TIMESTAMP_PATTERN.test(value)) return undefined;
	const parsed = z.iso.datetime({ offset: true }).safeParse(value);
	if (!parsed.success) return undefined;
	const millis = Date.parse(parsed.data);
	return Number.isFinite(millis) ? millis : undefined;
}

/**
 * Verifies one delivery.
 *
 * Order: body cap, configuration, timestamp header (freshness), signature
 * shape, then the constant-time digest comparison. A short secret fails
 * closed; a missing secret is explicitly `unsigned`.
 */
export function verifyGrafanaWebhook(
	input: GrafanaWebhookVerificationInput,
): GrafanaWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? GRAFANA_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const configuredSignatureHeader =
		input.signatureHeader === undefined
			? GRAFANA_SIGNATURE_HEADER
			: input.signatureHeader.trim().toLowerCase();
	if (!HEADER_NAME_PATTERN.test(configuredSignatureHeader)) {
		return { ok: false, reason: "malformed_headers" };
	}

	const signature = readGrafanaHeader(input.headers, configuredSignatureHeader);
	const secret = input.secret;
	if (secret === null || secret === undefined || secret.length === 0) {
		return {
			ok: true,
			status: "unsigned",
			signaturePresent: signature !== null && signature.trim().length > 0,
		};
	}
	if (secret.length < GRAFANA_WEBHOOK_MIN_SECRET_LENGTH) {
		return { ok: false, reason: "not_configured" };
	}

	const timestampHeaderName =
		input.timestampHeader === null || input.timestampHeader === undefined
			? null
			: input.timestampHeader.trim().toLowerCase();
	if (timestampHeaderName !== null && timestampHeaderName.length === 0) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (
		timestampHeaderName !== null &&
		!HEADER_NAME_PATTERN.test(timestampHeaderName)
	) {
		return { ok: false, reason: "malformed_headers" };
	}

	let timestampValue: string | null = null;
	let timestampMs: number | null = null;
	if (timestampHeaderName !== null) {
		timestampValue = readGrafanaHeader(input.headers, timestampHeaderName);
		if (timestampValue === null || timestampValue.trim().length === 0) {
			return { ok: false, reason: "missing_headers" };
		}
		if (
			timestampValue.length > 64 ||
			!/^[0-9A-Za-z:.+-]+$/.test(timestampValue)
		) {
			return { ok: false, reason: "malformed_headers" };
		}
		const parsed = parseGrafanaTimestamp(timestampValue);
		if (parsed === undefined) {
			return { ok: false, reason: "malformed_headers" };
		}
		const nowMs = input.nowMs ?? Date.now();
		const windowSeconds =
			input.replayWindowSeconds ?? GRAFANA_WEBHOOK_REPLAY_WINDOW_SECONDS;
		if (!Number.isFinite(nowMs) || !Number.isFinite(parsed)) {
			return { ok: false, reason: "malformed_headers" };
		}
		if (Math.abs(nowMs - parsed) > windowSeconds * 1000) {
			return { ok: false, reason: "stale_timestamp" };
		}
		timestampMs = parsed;
	}

	if (signature === null || signature.trim().length === 0) {
		return { ok: false, reason: "missing_headers" };
	}
	const signatureMatch = SIGNATURE_VALUE_PATTERN.exec(signature.trim());
	if (signatureMatch === null) {
		return { ok: false, reason: "malformed_signature" };
	}
	const providedHex = signatureMatch[1];
	if (providedHex === undefined) {
		return { ok: false, reason: "malformed_signature" };
	}

	const mac = createHmac("sha256", secret);
	if (timestampValue !== null) {
		// The signature covers the exact header value, not a normalized epoch.
		mac.update(new TextEncoder().encode(`${timestampValue}:`));
	}
	mac.update(body);
	const expected = mac.digest();
	let provided: Buffer;
	try {
		provided = Buffer.from(providedHex, "hex");
	} catch {
		return { ok: false, reason: "malformed_signature" };
	}
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	) {
		return { ok: false, reason: "invalid_signature" };
	}

	return {
		ok: true,
		status: "signed",
		signedString: timestampValue === null ? "body" : "timestamp_body",
		timestampMs,
		timestampHeader: timestampHeaderName,
		signatureHeader: configuredSignatureHeader,
	};
}
