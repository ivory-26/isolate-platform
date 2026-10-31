import "@tanstack/react-start/server-only";
import {
	normalizeGrafanaIncident,
	verifyGrafanaWebhook,
} from "@isolate/integrations";
import {
	type ConnectorIntakeOutcome,
	type ConnectorWebhookHeaders,
	parseWebhookJson,
	receivedAtFrom,
} from "./incident-intake-adapter.server";

/**
 * Grafana inbound trigger (docs/connectors/grafana.md §4).
 *
 * Mode selection is header-only: `x-grafana-alerting-signature` or the
 * configured timestamp header (`GRAFANA_WEBHOOK_TIMESTAMP_HEADER`) selects this
 * verifier. The signed string is `<timestamp>:<rawBody>` when the timestamp
 * header is configured (the default), so the verifier also enforces its ±300 s
 * replay window.
 *
 * # Unsigned Grafana
 *
 * Grafana can be configured without a signing secret. That mode is accepted
 * only when the operator explicitly sets `WEBHOOK_GRAFANA_ALLOW_UNSIGNED=true`;
 * there is no implicit fallback from a missing `WEBHOOK_GRAFANA_SECRET`. The
 * 64 KiB body cap is still enforced by `verifyGrafanaWebhook` before anything
 * is parsed, and a delivery that *claims* a signature the server cannot verify
 * is rejected rather than treated as unsigned. Unsigned deliveries have no
 * replay window (nothing is signed), so the 30-minute fingerprint dedupe is the
 * only replay bound. An unsigned contact point must still send the configured
 * timestamp header, because mode selection is header-only; without it the
 * delivery is generic and the strict `IncidentSignal` schema rejects it.
 */

/** Grafana's documented timestamp header; overridable per deployment. */
export const GRAFANA_DEFAULT_TIMESTAMP_HEADER = "x-grafana-alerting-timestamp";

export type GrafanaIntakeInput = {
	rawBody: string | Uint8Array;
	headers: ConnectorWebhookHeaders;
	/** Server-only `WEBHOOK_GRAFANA_SECRET`; absent enables unsigned only. */
	secret: string | null | undefined;
	/** Configured timestamp header name, or null for a body-only signature. */
	timestampHeader: string | null;
	/** Explicit `WEBHOOK_GRAFANA_ALLOW_UNSIGNED=true` opt-in. */
	allowUnsigned: boolean;
	nowMs: number;
};

export function verifyAndNormalizeGrafana(
	input: GrafanaIntakeInput,
): ConnectorIntakeOutcome {
	const verification = verifyGrafanaWebhook({
		rawBody: input.rawBody,
		headers: input.headers,
		secret: input.secret,
		timestampHeader: input.timestampHeader,
		nowMs: input.nowMs,
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
	if (verification.status === "unsigned") {
		// Unsigned is an operator decision, never an inference from a missing key.
		if (!input.allowUnsigned) return { ok: false, reason: "not_configured" };
		// A signature we cannot check must not be silently downgraded.
		if (verification.signaturePresent)
			return { ok: false, reason: "unauthorized" };
	}

	const body = parseWebhookJson(input.rawBody);
	if (!body.ok) return { ok: false, reason: "invalid_input" };

	// Resolved, non-production, no-data and low/info alerts normalize to null;
	// each is an ignored delivery, never a task and never a 400.
	const signal = normalizeGrafanaIncident(body.value, {
		receivedAt: receivedAtFrom(input.nowMs),
	});
	return { ok: true, signal };
}
