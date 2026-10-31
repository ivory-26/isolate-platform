import "@tanstack/react-start/server-only";
import {
	normalizeSentryIncident,
	verifySentryWebhook,
} from "@isolate/integrations";
import {
	type ConnectorIntakeOutcome,
	type ConnectorWebhookHeaders,
	parseWebhookJson,
	receivedAtFrom,
} from "./incident-intake-adapter.server";

/**
 * Sentry inbound trigger (docs/connectors/sentry.md §4).
 *
 * Mode selection is header-only: `sentry-hook-signature` or
 * `sentry-hook-resource` present means this verifier, and no other mode's
 * secret is ever tried. The adapter verifies the HMAC over the exact raw body
 * and its own ±300 s timestamp window; the normalizer then decides whether the
 * delivery is an incident (`null` for resolved/assigned/archived/unsupported).
 *
 * A missing or short `WEBHOOK_SENTRY_SECRET` fails closed with
 * `not_configured` (503 at the route); it never falls through to generic mode.
 */

export type SentryIntakeInput = {
	rawBody: string | Uint8Array;
	headers: ConnectorWebhookHeaders;
	/** Server-only `WEBHOOK_SENTRY_SECRET`; never read from the body. */
	secret: string | null | undefined;
	/** Trusted clock in epoch milliseconds (Sentry signs no freshness). */
	nowMs: number;
};

export function verifyAndNormalizeSentry(
	input: SentryIntakeInput,
): ConnectorIntakeOutcome {
	const verification = verifySentryWebhook({
		rawBody: input.rawBody,
		headers: input.headers,
		secret: input.secret,
		nowMs: input.nowMs,
	});
	if (!verification.ok) {
		switch (verification.reason) {
			case "not_configured":
				return { ok: false, reason: "not_configured" };
			case "body_too_large":
				return { ok: false, reason: "body_too_large" };
			// Malformed, unsupported resource, stale or invalid signature: all
			// unauthenticated, with no provider detail in the result.
			default:
				return { ok: false, reason: "unauthorized" };
		}
	}

	const body = parseWebhookJson(input.rawBody);
	if (!body.ok) return { ok: false, reason: "invalid_input" };

	// The adapter is the policy: `null` (resolved, unsupported action or a
	// malformed envelope) means "no task", never a 400.
	const signal = normalizeSentryIncident(body.value, {
		receivedAt: receivedAtFrom(input.nowMs),
	});
	return { ok: true, signal };
}
