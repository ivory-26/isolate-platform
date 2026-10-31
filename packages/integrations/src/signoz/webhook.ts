import { createHash, timingSafeEqual } from "node:crypto";
import {
	MAX_SIGNOZ_WEBHOOK_BODY_BYTES,
	parseSignozWebhookPayload,
	type SignozWebhookPayload,
} from "./schemas";

/**
 * SigNoz webhook transport verification (`docs/connectors/signoz.md` §4).
 *
 * SigNoz documents **no HMAC and no signed timestamp** for a webhook
 * notification channel [S2]. The channel authenticates the sender with Basic
 * auth in the channel configuration; an operator may instead place a shared
 * token in a header in front of SigNoz. Both are sender authentication, not a
 * body signature: the body is still untrusted and the alert/rule state must be
 * re-fetched before creating a task.
 *
 * This module therefore returns an explicit `authenticated: "basic" | "token"`
 * result. There is no "verified body" claim and no code path that treats a
 * missing credential as verified.
 *
 * Freshness: `startsAt`/`endsAt` are payload data, not a signed timestamp. The
 * delivery check still rejects a firing alert whose newest `startsAt` is older
 * than 15 minutes (the documented replay window) and a payload with no firing
 * alert at all.
 *
 * Failures are a closed union. No failure path echoes the body, the
 * Authorization value, the token or any provider text; comparisons are
 * constant-time over SHA-256 digests so a length difference is not a signal.
 */

export const SIGNOZ_AUTHORIZATION_HEADER = "authorization";
/** Default shared-token header; operators may rename it via config. */
export const SIGNOZ_WEBHOOK_TOKEN_HEADER = "x-signoz-webhook-token";
export const SIGNOZ_WEBHOOK_MAX_BODY_BYTES = MAX_SIGNOZ_WEBHOOK_BODY_BYTES;
/** Documented replay control: reject alerts older than 15 minutes. */
export const SIGNOZ_WEBHOOK_REPLAY_WINDOW_SECONDS = 15 * 60;
/** A password or token shorter than this is treated as misconfigured. */
export const SIGNOZ_WEBHOOK_MIN_CREDENTIAL_LENGTH = 16;
/** A `startsAt` further in the future than this is a malformed delivery. */
export const SIGNOZ_WEBHOOK_MAX_FUTURE_SKEW_SECONDS = 300;

const BASIC_PREFIX = /^basic\s+/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_AUTHORIZATION_CHARS = 1024;
const MAX_TOKEN_CHARS = 512;
const MAX_BASIC_DECODED_CHARS = 512;
const MAX_BASIC_USER_CHARS = 128;
const MAX_BASIC_PASSWORD_CHARS = 256;

export type SignozWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type SignozWebhookCredentials = {
	basicUser?: string | null;
	basicPassword?: string | null;
	/** Shared token alternative; never logged, never echoed. */
	token?: string | null;
	/** Header carrying `token`; defaults to `x-signoz-webhook-token`. */
	tokenHeader?: string | null;
};

export type SignozWebhookVerificationFailure =
	| "body_too_large"
	| "not_configured"
	| "missing_headers"
	| "malformed_headers"
	| "invalid_credentials"
	| "malformed_payload"
	| "stale_alert"
	| "no_firing_alert";

export type SignozWebhookVerification =
	| { ok: true; authenticated: "basic" | "token" }
	| { ok: false; reason: SignozWebhookVerificationFailure };

export type SignozWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: SignozWebhookHeaders;
	credentials: SignozWebhookCredentials;
	maxBodyBytes?: number;
};

export type SignozDeliveryVerificationInput = SignozWebhookVerificationInput & {
	/** Injected clock; defaults to the wall clock. */
	nowMs?: number;
	replayWindowSeconds?: number;
};

export type SignozDeliveryVerification =
	| {
			ok: true;
			authenticated: "basic" | "token";
			/** Strictly parsed; still untrusted data. */
			payload: SignozWebhookPayload;
	  }
	| { ok: false; reason: SignozWebhookVerificationFailure };

/** Case-insensitive header lookup for `Headers` or a plain record. */
export function readSignozHeader(
	headers: SignozWebhookHeaders,
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

/** Constant-time comparison; digesting hides the operand lengths. */
function constantTimeEquals(left: string, right: string): boolean {
	const leftDigest = createHash("sha256").update(left, "utf8").digest();
	const rightDigest = createHash("sha256").update(right, "utf8").digest();
	return timingSafeEqual(leftDigest, rightDigest);
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

type ResolvedCredentials = {
	basicUser: string | null;
	basicPassword: string | null;
	token: string | null;
	tokenHeader: string;
};

function resolveCredentials(
	credentials: SignozWebhookCredentials,
): ResolvedCredentials | null {
	const tokenHeader = (
		nonEmpty(credentials.tokenHeader) ?? SIGNOZ_WEBHOOK_TOKEN_HEADER
	).toLowerCase();
	if (!HEADER_NAME_PATTERN.test(tokenHeader)) return null;

	const basicUser = nonEmpty(credentials.basicUser);
	const basicPassword = nonEmpty(credentials.basicPassword);
	const token = nonEmpty(credentials.token);

	const basicConfigured =
		basicUser !== null &&
		basicPassword !== null &&
		basicPassword.length >= SIGNOZ_WEBHOOK_MIN_CREDENTIAL_LENGTH;
	const tokenConfigured =
		token !== null && token.length >= SIGNOZ_WEBHOOK_MIN_CREDENTIAL_LENGTH;
	if (!basicConfigured && !tokenConfigured) return null;

	return {
		basicUser: basicConfigured ? basicUser : null,
		basicPassword: basicConfigured ? basicPassword : null,
		token: tokenConfigured ? token : null,
		tokenHeader,
	};
}

function decodeBasic(
	authorization: string,
): { user: string; password: string } | null {
	const match = BASIC_PREFIX.exec(authorization);
	if (match === null) return null;
	const encoded = authorization.slice(match[0].length).trim();
	if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(encoded, "base64").toString("utf8");
	} catch {
		return null;
	}
	if (decoded.length === 0 || decoded.length > MAX_BASIC_DECODED_CHARS) {
		return null;
	}
	const separator = decoded.indexOf(":");
	if (separator <= 0 || separator === decoded.length - 1) return null;
	const user = decoded.slice(0, separator);
	const password = decoded.slice(separator + 1);
	if (
		user.length > MAX_BASIC_USER_CHARS ||
		password.length > MAX_BASIC_PASSWORD_CHARS
	) {
		return null;
	}
	return { user, password };
}

/**
 * Verifies the sender credential only. Order: body cap, configuration, then
 * Basic (when an `Authorization` header is present) or the configured token
 * header. A configured-but-unusable secret fails closed as `not_configured`.
 */
export function verifySignozWebhook(
	input: SignozWebhookVerificationInput,
): SignozWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? SIGNOZ_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	const tokenHeaderName = (
		nonEmpty(input.credentials.tokenHeader) ?? SIGNOZ_WEBHOOK_TOKEN_HEADER
	).toLowerCase();
	if (!HEADER_NAME_PATTERN.test(tokenHeaderName)) {
		return { ok: false, reason: "malformed_headers" };
	}
	const credentials = resolveCredentials(input.credentials);
	if (credentials === null) {
		return { ok: false, reason: "not_configured" };
	}

	const authorization = readSignozHeader(
		input.headers,
		SIGNOZ_AUTHORIZATION_HEADER,
	);
	if (authorization !== null && authorization.trim().length > 0) {
		if (authorization.length > MAX_AUTHORIZATION_CHARS) {
			return { ok: false, reason: "malformed_headers" };
		}
		if (credentials.basicUser === null || credentials.basicPassword === null) {
			// A Basic header arrived but Basic auth is not the configured scheme.
			return { ok: false, reason: "invalid_credentials" };
		}
		const decoded = decodeBasic(authorization.trim());
		if (decoded === null) {
			return { ok: false, reason: "malformed_headers" };
		}
		const userOk = constantTimeEquals(decoded.user, credentials.basicUser);
		const passwordOk = constantTimeEquals(
			decoded.password,
			credentials.basicPassword,
		);
		if (!userOk || !passwordOk) {
			return { ok: false, reason: "invalid_credentials" };
		}
		return { ok: true, authenticated: "basic" };
	}

	const token = readSignozHeader(input.headers, credentials.tokenHeader);
	if (token === null || token.trim().length === 0) {
		return { ok: false, reason: "missing_headers" };
	}
	if (token.length > MAX_TOKEN_CHARS) {
		return { ok: false, reason: "malformed_headers" };
	}
	if (credentials.token === null) {
		return { ok: false, reason: "invalid_credentials" };
	}
	if (!constantTimeEquals(token.trim(), credentials.token)) {
		return { ok: false, reason: "invalid_credentials" };
	}
	return { ok: true, authenticated: "token" };
}

/**
 * Intake dedupe key (`docs/connectors/signoz.md` §4):
 * `signoz:<rule-id>:<alert-fingerprint>:<state>`. The delivery id (when one
 * exists) is traceability only and participates in neither.
 */
export function signozDedupeKey(input: {
	ruleId: string;
	alertFingerprint: string;
	state: string;
}): string {
	return `signoz:${input.ruleId}:${input.alertFingerprint}:${input.state}`;
}

function decodeBody(rawBody: string | Uint8Array): string | null {
	if (typeof rawBody === "string") return rawBody;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
	} catch {
		return null;
	}
}

/**
 * Full delivery verification: sender credential, strict payload, then
 * freshness. Returns the parsed payload so the caller does not parse twice;
 * normalization still runs separately and re-validates.
 */
export function verifySignozDelivery(
	input: SignozDeliveryVerificationInput,
): SignozDeliveryVerification {
	const auth = verifySignozWebhook(input);
	if (!auth.ok) return auth;

	const text = decodeBody(input.rawBody);
	if (text === null) return { ok: false, reason: "malformed_payload" };
	const payload = parseSignozWebhookPayload(text);
	if (payload === null) return { ok: false, reason: "malformed_payload" };

	const firing = payload.alerts.filter(
		(alert) => (alert.status ?? payload.status ?? "firing") === "firing",
	);
	if (firing.length === 0) {
		return { ok: false, reason: "no_firing_alert" };
	}

	const nowMs = input.nowMs ?? Date.now();
	if (!Number.isFinite(nowMs)) {
		return { ok: false, reason: "malformed_payload" };
	}
	const windowSeconds =
		input.replayWindowSeconds ?? SIGNOZ_WEBHOOK_REPLAY_WINDOW_SECONDS;
	const startsAtMs: number[] = [];
	for (const alert of firing) {
		if (alert.startsAt === undefined) continue;
		const parsed = Date.parse(alert.startsAt);
		if (Number.isFinite(parsed)) startsAtMs.push(parsed);
	}
	if (startsAtMs.length === 0) {
		// Freshness cannot be established without `startsAt`: fail closed.
		return { ok: false, reason: "malformed_payload" };
	}
	const newestStart = Math.max(...startsAtMs);
	if (newestStart > nowMs + SIGNOZ_WEBHOOK_MAX_FUTURE_SKEW_SECONDS * 1000) {
		return { ok: false, reason: "malformed_payload" };
	}
	if (newestStart < nowMs - windowSeconds * 1000) {
		return { ok: false, reason: "stale_alert" };
	}

	return { ok: true, authenticated: auth.authenticated, payload };
}
