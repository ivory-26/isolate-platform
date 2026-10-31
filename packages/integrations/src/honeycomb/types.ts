import type { ErrorCode } from "@isolate/shared";
import type {
	HoneycombContextItem,
	HoneycombQueryKind,
	HoneycombTriggerSnapshot,
} from "./schemas";

/**
 * Honeycomb connector contracts. The API key and webhook token live only in
 * trusted server code; no type here carries a secret into a prompt, tool
 * argument, sandbox environment, log or error.
 */

export type HoneycombWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type HoneycombWebhookVerificationFailure =
	| "body_too_large"
	| "not_bridge_verified"
	| "malformed_headers";

export type HoneycombWebhookVerification =
	| {
			ok: true;
			/**
			 * Honeycomb sends no signature. This is always `"unsigned"`; a
			 * caller must not present it as a vendor-verified delivery.
			 */
			status: "unsigned";
			signedByVendor: false;
			/** Set only by the bridge after its constant-time token check. */
			bridgeVerified: true;
			deliveryId: string | null;
	  }
	| { ok: false; reason: HoneycombWebhookVerificationFailure };

export type HoneycombWebhookVerificationInput = {
	/** Raw bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: HoneycombWebhookHeaders;
	/** Trusted bridge verdict; the only accepted proof of token verification. */
	bridgeVerified: boolean;
	maxBodyBytes?: number;
};

/** Receipt metadata supplied by trusted code, never by the payload. */
export type HoneycombIncidentDelivery = {
	readonly receivedAt?: string;
	/** Trusted clock in epoch milliseconds; defaults to wall clock. */
	readonly nowMs?: number;
	/** Traceability only; never part of the fingerprint. */
	readonly deliveryId?: string;
};

/** Injectable fetch shape; avoids Bun's extended global type in tests. */
export type HoneycombFetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type HoneycombContextDependencies = {
	/** Environment-scoped configuration key; never an ingest key. */
	readonly apiKey: string;
	readonly dataset: string;
	/** US default; EU environments inject their environment-specific host. */
	readonly apiBaseUrl?: string;
	/** Optional, so a leaked token can still be scrubbed from provider text. */
	readonly webhookToken?: string;
	readonly fetchImpl?: HoneycombFetchLike;
	readonly now?: () => number;
	readonly timeoutMs?: number;
	/** Clamped to the connector caps (8 items, 4,000 chars). */
	readonly maxItems?: number;
	readonly maxExcerptChars?: number;
	/** Trigger metadata captured from the incident; no API call is made. */
	readonly trigger?: HoneycombTriggerSnapshot | null;
};

export type HoneycombContextInput = {
	readonly incidentFingerprint: string;
	readonly service: string;
	readonly kind?: HoneycombQueryKind;
	readonly windowMinutes?: number;
};

export type HoneycombEvidenceFailure =
	| "none"
	| "denied"
	| "missing"
	| "failed"
	| "malformed";

/** One bounded evidence item plus the degradation reason, if any. */
export type HoneycombEvidence = {
	readonly item: HoneycombContextItem | null;
	readonly truncated: boolean;
	readonly failure: HoneycombEvidenceFailure;
};

export type HoneycombToolName =
	| "honeycomb.run_query"
	| "honeycomb.get_trigger"
	| "honeycomb.list_slos";
export type HoneycombToolRisk = "read_only";

export type HoneycombToolErrorCode = Extract<
	ErrorCode,
	| "VALIDATION_FAILED"
	| "NOT_FOUND"
	| "POLICY_DENIED"
	| "RATE_LIMITED"
	| "INTEGRATION_UNAVAILABLE"
>;

export type HoneycombToolSuccess = {
	ok: true;
	tool: HoneycombToolName;
	risk: HoneycombToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: HoneycombContextItem | null;
	truncated: boolean;
};

export type HoneycombToolFailure = {
	ok: false;
	tool: HoneycombToolName;
	risk: HoneycombToolRisk;
	code: HoneycombToolErrorCode;
	/** Bounded, redacted; no key, URL or provider body. */
	message: string;
};

export type HoneycombToolResult = HoneycombToolSuccess | HoneycombToolFailure;

export const HONEYCOMB_TOOL_NAMES = [
	"honeycomb.run_query",
	"honeycomb.get_trigger",
	"honeycomb.list_slos",
] as const satisfies readonly HoneycombToolName[];

/** Tool dependencies are the same reader configuration; no write surface. */
export type HoneycombToolDependencies = HoneycombContextDependencies;
