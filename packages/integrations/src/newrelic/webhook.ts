import {
	NEWRELIC_WEBHOOK_MAX_BODY_BYTES,
	type NewRelicAlertPayload,
	parseNewRelicAlertPayload,
} from "./schemas";

/**
 * New Relic webhook transport (`docs/connectors/newrelic.md` §4).
 *
 * New Relic documents **no HMAC signature** for workflow webhook destinations.
 * A custom header is a shared secret, not a signature: it proves the sender
 * knows the value, not that the body was unmodified. Accepting the body
 * directly would therefore be an unauthenticated task source.
 *
 * The adapter never claims a vendor signature. It returns an explicit
 * `unsigned` result, and the only way to reach `bridge_verified` is for the
 * trusted generic signed bridge (`X-Isolate-Signature` over the raw bytes) to
 * say so. A caller that ignores `bridgeVerified` accepts unauthenticated
 * input; this module cannot make that safe by itself.
 *
 * Failures are a closed union. No failure path echoes the body, a header value
 * or any provider text. Freshness (`createdAt`, 15 minutes) is enforced in
 * `normalize.ts`, where the payload is parsed; verification only caps bytes.
 */

export type NewRelicWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type NewRelicWebhookVerificationFailure = "body_too_large";

export type NewRelicWebhookVerification =
	| {
			ok: true;
			/** New Relic itself never signs a workflow webhook. */
			vendorSignature: "none";
			status: "unsigned";
			/** True only after the generic signed bridge verified raw bytes. */
			bridgeVerified: false;
			/** A custom header arrived; it is a shared secret, not proof. */
			customHeaderPresent: boolean;
	  }
	| {
			ok: true;
			vendorSignature: "none";
			status: "bridge_verified";
			/** The generic bridge verified the raw bytes before forwarding. */
			bridgeVerified: true;
	  }
	| { ok: false; reason: NewRelicWebhookVerificationFailure };

export type NewRelicWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	/** Headers are inspected only for presence; never trusted as a signature. */
	headers?: NewRelicWebhookHeaders;
	/** Set by the trusted signed bridge after an HMAC check over raw bytes. */
	bridgeVerified?: boolean;
	maxBodyBytes?: number;
	/** Operator-configured custom header name (shared secret), if any. */
	customHeader?: string | null;
};

const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function toBytes(body: string | Uint8Array): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** Case-insensitive header lookup for `Headers` or a plain record. */
export function readNewRelicHeader(
	headers: NewRelicWebhookHeaders | undefined,
	name: string,
): string | null {
	if (headers === undefined) return null;
	if (headers instanceof Headers) return headers.get(name);
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return typeof value === "string" ? value : null;
		}
	}
	return null;
}

/**
 * Verifies one delivery as far as the vendor allows.
 *
 * Order: body cap, then the bridge attestation. A short or empty custom header
 * is not evidence and is never treated as one; the result is always
 * `unsigned`. `bridgeVerified` is trusted only because it is produced by
 * server-side bridge code that verified the raw bytes itself.
 */
export function verifyNewRelicWebhook(
	input: NewRelicWebhookVerificationInput,
): NewRelicWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? NEWRELIC_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}

	if (input.bridgeVerified === true) {
		return {
			ok: true,
			vendorSignature: "none",
			status: "bridge_verified",
			bridgeVerified: true,
		};
	}

	let customHeaderPresent = false;
	const customHeader = input.customHeader;
	if (typeof customHeader === "string" && customHeader.length > 0) {
		if (!HEADER_NAME_PATTERN.test(customHeader.trim())) {
			// A malformed configured name cannot match anything; it is not a signature.
			customHeaderPresent = false;
		} else {
			const value = readNewRelicHeader(
				input.headers,
				customHeader.trim().toLowerCase(),
			);
			customHeaderPresent = value !== null && value.trim().length > 0;
		}
	}

	return {
		ok: true,
		vendorSignature: "none",
		status: "unsigned",
		bridgeVerified: false,
		customHeaderPresent,
	};
}

/**
 * Parses a verified delivery's body with the strict pinned template. The
 * `bridge_verified` flag changes trust, not shape: unsigned and bridged
 * payloads are parsed identically. Returns `null` for anything that is not the
 * exact template.
 */
export function parseNewRelicVerifiedPayload(
	rawBody: string | Uint8Array,
): NewRelicAlertPayload | null {
	const bytes = toBytes(rawBody);
	if (bytes.byteLength > NEWRELIC_WEBHOOK_MAX_BODY_BYTES) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	return parseNewRelicAlertPayload(text);
}
