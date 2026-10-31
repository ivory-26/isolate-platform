/**
 * Datadog webhook transport verification (`docs/connectors/datadog.md` §4).
 *
 * Datadog documents **no signature** over the webhook body. A custom header
 * only proves that the sender knows a shared string; it does not prove body
 * integrity. This module therefore never reports a delivery as `valid`:
 *
 * - without a bridge-verified flag it reports `unsigned`, which a caller must
 *   treat as "not verified";
 * - with an explicit `bridgeVerified: true` it reports `bridge_verified`, which
 *   says "the signed generic bridge admitted this delivery", not "Datadog
 *   signed it";
 * - an oversized body is refused before any parsing.
 *
 * A forged or unsigned payload can at most cause a canonical API re-fetch of
 * real monitor/incident state. It can never create a task from payload text
 * alone. No result echoes the body, a header, or a configured secret.
 */

export const DATADOG_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export type DatadogWebhookVerification =
	| {
			ok: true;
			status: "unsigned";
			bridgeVerified: false;
			reason: "no_signature";
	  }
	| {
			ok: true;
			status: "bridge_verified";
			bridgeVerified: true;
			reason: "bridge_verified";
	  }
	| { ok: false; reason: "body_too_large" };

export type DatadogWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	/**
	 * True only after the signed generic bridge verified the shared custom
	 * header server-side. Datadog never signs the body, so there is no
	 * per-delivery HMAC to check here.
	 */
	bridgeVerified?: boolean;
	maxBodyBytes?: number;
};

function toBytes(body: string | Uint8Array): Uint8Array {
	return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/**
 * Verifies one delivery. The only acceptance is `unsigned` or
 * `bridge_verified`; the word `valid` is never a status.
 */
export function verifyDatadogWebhook(
	input: DatadogWebhookVerificationInput,
): DatadogWebhookVerification {
	const body = toBytes(input.rawBody);
	const maxBodyBytes = input.maxBodyBytes ?? DATADOG_WEBHOOK_MAX_BODY_BYTES;
	if (body.byteLength > maxBodyBytes) {
		return { ok: false, reason: "body_too_large" };
	}
	if (input.bridgeVerified === true) {
		return {
			ok: true,
			status: "bridge_verified",
			bridgeVerified: true,
			reason: "bridge_verified",
		};
	}
	return {
		ok: true,
		status: "unsigned",
		bridgeVerified: false,
		reason: "no_signature",
	};
}

/** Document-name alias used by the connector spec (`verifyDatadogDelivery`). */
export const verifyDatadogDelivery = verifyDatadogWebhook;
