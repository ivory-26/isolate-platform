import "@tanstack/react-start/server-only";
import type { IncidentSignal } from "@isolate/shared";

/**
 * Shared glue for the first-batch inbound adapters (Sentry, Grafana,
 * PagerDuty).
 *
 * Each mode owns its verifier and normalizer in `@isolate/integrations`; this
 * module only defines the bounded outcome the intake pipeline consumes and the
 * raw-body JSON boundary. A mode never reads another mode's secret, and no
 * outcome carries the payload, the signature or the secret.
 */

/** Header container accepted by every adapter verifier. */
export type ConnectorWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

/** Failure reasons shared by the adapter glue; intake maps them to codes. */
export type ConnectorIntakeFailure =
	| "not_configured"
	| "body_too_large"
	| "unauthorized"
	| "invalid_input";

export type ConnectorIntakeOutcome =
	/** `signal: null` means the adapter classified the delivery as no incident. */
	| { ok: true; signal: IncidentSignal | null }
	| { ok: false; reason: ConnectorIntakeFailure };

export type ParsedWebhookJson = { ok: true; value: unknown } | { ok: false };

/**
 * Parses the exact raw bytes. A signed body that is not JSON is a 400; a body
 * that parses but does not match the adapter schema normalizes to `null` and
 * is reported as an ignored delivery instead.
 */
export function parseWebhookJson(
	rawBody: string | Uint8Array,
): ParsedWebhookJson {
	try {
		const text =
			typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false };
	}
}

/** Trusted receipt instant; a payload timestamp is never used for this. */
export function receivedAtFrom(nowMs: number): string {
	return new Date(nowMs).toISOString();
}
