import type { ErrorCode } from "@isolate/shared";
import type { SentryLevel } from "./schemas";

/**
 * Sentry connector contracts. Credentials are resolved in trusted code and
 * appear only in the Authorization header; no type here carries a secret and
 * no output type carries unbounded provider text.
 */

export type SentryWebhookHeaders =
	| Headers
	| Readonly<Record<string, string | null | undefined>>;

export type SentryWebhookVerificationFailure =
	| "not_configured"
	| "body_too_large"
	| "missing_headers"
	| "malformed_headers"
	| "unsupported_resource"
	| "malformed_signature"
	| "stale_timestamp"
	| "invalid_signature";

export type SentryWebhookVerification =
	| { ok: true; resource: "issue"; timestamp: number }
	| { ok: false; reason: SentryWebhookVerificationFailure };

export type SentryWebhookVerificationInput = {
	/** Exact bytes as received; never a re-serialized object. */
	rawBody: string | Uint8Array;
	headers: SentryWebhookHeaders;
	secret: string | null | undefined;
	maxBodyBytes?: number;
	/** Trusted clock in epoch milliseconds; defaults to wall clock. */
	nowMs?: number;
	/** Replay window on the unsigned `Sentry-Hook-Timestamp`; default 300 s. */
	maxSkewSeconds?: number;
};

/** Receipt metadata supplied by trusted code, never by the payload. */
export type SentryIncidentDelivery = {
	readonly receivedAt?: string;
	readonly deliveryId?: string;
};

export type SentryContextDependencies = {
	/** Organization auth token with event/project/org/release read scopes. */
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly now?: () => number;
	readonly timeoutMs?: number;
	/** Clamped to the connector caps. */
	readonly maxItems?: number;
	readonly maxExcerptChars?: number;
};

export type SentryContextInput = {
	readonly issueId: string;
	readonly orgSlug: string;
	/** Optional environment filter on the issue endpoint. */
	readonly environment?: string;
	/** Signal fingerprint this bundle answers; derived when omitted. */
	readonly incidentFingerprint?: string;
};

export type SentryToolDependencies = {
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
};

export type SentryToolErrorCode = Extract<
	ErrorCode,
	| "VALIDATION_FAILED"
	| "NOT_FOUND"
	| "POLICY_DENIED"
	| "RATE_LIMITED"
	| "INTEGRATION_UNAVAILABLE"
>;

/** Bounded, credential-free tool result; never a provider body. */
export type SentryToolResult<T> =
	| { ok: true; data: T }
	| { ok: false; code: SentryToolErrorCode };

export type SentryIssueSummary = {
	id: string;
	shortId: string | null;
	title: string;
	level: SentryLevel | null;
	status: string | null;
	count: number | null;
	lastSeen: string | null;
	projectSlug: string | null;
	permalink: string | null;
};

export type SentryEventSummary = {
	eventId: string;
	message: string;
	culprit: string | null;
	level: SentryLevel | null;
	releaseVersion: string | null;
	tags: Record<string, string>;
	frames: string[];
};

export const SENTRY_TOOL_NAMES = [
	"sentry.list_issues",
	"sentry.get_issue",
	"sentry.latest_event",
] as const;
export type SentryToolName = (typeof SENTRY_TOOL_NAMES)[number];
