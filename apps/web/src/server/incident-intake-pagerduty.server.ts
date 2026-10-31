import "@tanstack/react-start/server-only";
import {
	isPagerDutyEventFresh,
	normalizePagerDutyIncident,
	pagerDutyWebhookEnvelopeSchema,
	verifyPagerDutyWebhook,
} from "@isolate/integrations";
import {
	type ConnectorIntakeOutcome,
	type ConnectorWebhookHeaders,
	parseWebhookJson,
	receivedAtFrom,
} from "./incident-intake-adapter.server";

/**
 * PagerDuty inbound trigger (docs/connectors/pagerduty.md §4).
 *
 * Mode selection is header-only: `x-pagerduty-signature` selects this verifier.
 * PagerDuty signs the raw body only, so the signature proves authorship, not
 * freshness. After a valid signature the envelope's `event.occurred_at` is
 * checked against the trusted clock (±300 s); a stale delivery is rejected as
 * unauthenticated (`unauthorized`) before normalization, so a captured body
 * cannot create a second task.
 *
 * The normalizer accepts only `incident.triggered`; every lifecycle event
 * (`acknowledged`, `resolved`, `escalated`, ...) returns null and is ignored.
 * A missing `WEBHOOK_PAGERDUTY_SECRET` fails closed; it never falls through to
 * the generic verifier.
 */

export type PagerDutyIntakeInput = {
	rawBody: string | Uint8Array;
	headers: ConnectorWebhookHeaders;
	/** Server-only `WEBHOOK_PAGERDUTY_SECRET`; never read from the body. */
	secret: string | null | undefined;
	/** Trusted clock in epoch milliseconds for the replay window. */
	nowMs: number;
};

export function verifyAndNormalizePagerDuty(
	input: PagerDutyIntakeInput,
): ConnectorIntakeOutcome {
	const verification = verifyPagerDutyWebhook({
		rawBody: input.rawBody,
		headers: input.headers,
		secret: input.secret,
	});
	if (!verification.ok) {
		switch (verification.reason) {
			case "not_configured":
				return { ok: false, reason: "not_configured" };
			case "body_too_large":
				return { ok: false, reason: "body_too_large" };
			default:
				return { ok: false, reason: "unauthorized" };
		}
	}

	const body = parseWebhookJson(input.rawBody);
	if (!body.ok) return { ok: false, reason: "invalid_input" };

	// Freshness is checked only on a well-formed envelope; a malformed one is
	// normalized to null below (ignored), exactly like a non-triggering event.
	const envelope = pagerDutyWebhookEnvelopeSchema.safeParse(body.value);
	if (
		envelope.success &&
		!isPagerDutyEventFresh(envelope.data.event.occurred_at, input.nowMs)
	) {
		return { ok: false, reason: "unauthorized" };
	}

	const signal = normalizePagerDutyIncident(
		body.value,
		receivedAtFrom(input.nowMs),
	);
	return { ok: true, signal };
}
