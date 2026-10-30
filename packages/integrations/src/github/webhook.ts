import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook transport verification (wave 13, docs §3.1.2).
 *
 * GitHub signs the **raw** request body with HMAC-SHA256 and sends the digest in
 * `X-Hub-Signature-256` as `sha256=<hex>`. Unlike the generic receiver there is
 * no signed timestamp, so replay control is the delivery id plus the incident
 * fingerprint, never a freshness window.
 *
 * Verification is fail-closed and returns a closed reason union. No failure
 * path echoes the body, the signature, the secret or any provider text.
 */

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
export const GITHUB_EVENT_HEADER = "x-github-event";
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";
export const GITHUB_SIGNATURE_PREFIX = "sha256=";
/** Whole-body cap; the route refuses before parsing JSON. */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** A webhook secret shorter than this is treated as not configured. */
export const GITHUB_WEBHOOK_MIN_SECRET_LENGTH = 32;

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const LEGACY_SHA1_PREFIX = "sha1=";

export type GitHubWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type GitHubWebhookVerificationFailure =
	| "not_configured"
	| "body_too_large"
	| "missing_headers"
	| "malformed_headers"
	| "unsupported_algorithm"
	| "malformed_signature"
	| "invalid_signature";

export type GitHubWebhookVerification =
	| { ok: true; event: string; delivery: string }
	| { ok: false; reason: GitHubWebhookVerificationFailure };

export type GitHubWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: GitHubWebhookHeaders;
	secret: string | null | undefined;
	maxBodyBytes?: number;
};

/** Case-insensitive header lookup for a `Headers` instance or a plain record. */
export function readGitHubHeader(
	headers: GitHubWebhookHeaders,
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
 * Verifies one delivery. Order matters: configuration and size first so a
 * misconfigured receiver cannot be probed with a huge body, then the required
 * headers, then signature shape, then the constant-time digest comparison.
 */
export function verifyGitHubWebhook(
	input: GitHubWebhookVerificationInput,
): GitHubWebhookVerification {
	const secret = input.secret;
	if (
		typeof secret !== "string" ||
		secret.length < GITHUB_WEBHOOK_MIN_SECRET_LENGTH
	) {
		return { ok: false, reason: "not_configured" };
	}

	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? GITHUB_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const event = readGitHubHeader(input.headers, GITHUB_EVENT_HEADER);
	const delivery = readGitHubHeader(input.headers, GITHUB_DELIVERY_HEADER);
	const signature = readGitHubHeader(input.headers, GITHUB_SIGNATURE_HEADER);
	if (
		event === null ||
		event.length === 0 ||
		delivery === null ||
		delivery.length === 0 ||
		signature === null ||
		signature.length === 0
	) {
		return { ok: false, reason: "missing_headers" };
	}
	if (!EVENT_NAME_PATTERN.test(event) || !DELIVERY_ID_PATTERN.test(delivery)) {
		return { ok: false, reason: "malformed_headers" };
	}

	if (signature.startsWith(LEGACY_SHA1_PREFIX)) {
		// GitHub's deprecated SHA-1 header is not accepted, ever.
		return { ok: false, reason: "unsupported_algorithm" };
	}
	if (!signature.startsWith(GITHUB_SIGNATURE_PREFIX)) {
		return { ok: false, reason: "malformed_signature" };
	}
	const providedHex = signature.slice(GITHUB_SIGNATURE_PREFIX.length);
	if (!SIGNATURE_HEX_PATTERN.test(providedHex)) {
		return { ok: false, reason: "malformed_signature" };
	}

	const expected = createHmac("sha256", secret).update(body).digest();
	const provided = Buffer.from(providedHex, "hex");
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	) {
		return { ok: false, reason: "invalid_signature" };
	}

	return { ok: true, event, delivery };
}
