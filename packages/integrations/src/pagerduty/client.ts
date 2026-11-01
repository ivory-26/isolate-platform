import { PlatformError } from "@isolate/shared";
import { readBoundedJson } from "../http/bounded-body";

/**
 * Shared PagerDuty REST v2 transport.
 *
 * One least-privilege read token (`Authorization: Token token=<key>`), a fixed
 * base URL, a per-call deadline, a response cap and a hard call budget. The
 * model never authors a URL: callers pass allowlisted path templates only.
 *
 * Error mapping is fail-closed and fixed-text: `401`/transport →
 * `INTEGRATION_UNAVAILABLE`, `429` → `RATE_LIMITED`; `403` and `404` return
 * typed results so the caller can drop an optional resource (partial bundle) or
 * fail the mandatory one. No error path echoes the URL, token or body.
 */

export const PAGERDUTY_API_BASE = "https://api.pagerduty.com";
export const PAGERDUTY_DEFAULT_TIMEOUT_MS = 10_000;
export const PAGERDUTY_MAX_TIMEOUT_MS = 30_000;
export const PAGERDUTY_MAX_RESPONSE_BYTES = 256 * 1024;
export const PAGERDUTY_MAX_CONTEXT_CALLS = 4;
export const PAGERDUTY_USER_AGENT = "isolate-platform";
export const PAGERDUTY_ACCEPT = "application/vnd.pagerduty+json;version=2";
export const PAGERDUTY_MIN_TOKEN_LENGTH = 8;

const MAX_TOKEN_LENGTH = 512;
const MAX_FROM_EMAIL_LENGTH = 254;
const FROM_EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export type PagerDutyFetch = typeof fetch;

export type PagerDutyCallResult =
	| { kind: "ok"; body: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "skipped" }
	| { kind: "budget" };

export type PagerDutyReadCaller = {
	call(path: string, step: string): Promise<PagerDutyCallResult>;
	markIncomplete(): void;
	isIncomplete(): boolean;
	readonly calls: number;
};

export type PagerDutyReadCallerDependencies = {
	token: string;
	baseUrl?: string;
	/** Optional `From` header; the address never reaches a prompt, log or error. */
	fromEmail?: string;
	fetchImpl?: PagerDutyFetch;
	timeoutMs?: number;
	maxCalls?: number;
};

/**
 * Validates the injected base URL. https only, no embedded credentials, no
 * path, query or fragment: one origin, one API surface.
 */
export function normalizePagerDutyBaseUrl(value?: string): string {
	const candidate = value === undefined ? PAGERDUTY_API_BASE : value;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty baseUrl must be an https origin",
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty baseUrl must be an https origin",
		);
	}
	return url.origin;
}

/** A missing or implausible read token is an integration outage, not a 401. */
export function requirePagerDutyReadToken(token: unknown): string {
	if (
		typeof token !== "string" ||
		token.trim().length < PAGERDUTY_MIN_TOKEN_LENGTH ||
		token.length > MAX_TOKEN_LENGTH
	) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty read credential is not configured",
		);
	}
	return token.trim();
}

/** Write credentials are a separate `incidents.write` token. */
export function requirePagerDutyWriteToken(token: unknown): string {
	if (
		typeof token !== "string" ||
		token.trim().length < PAGERDUTY_MIN_TOKEN_LENGTH ||
		token.length > MAX_TOKEN_LENGTH
	) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"pagerduty write credential is not configured",
		);
	}
	return token.trim();
}

/** The `From` address is a write credential; it is never echoed in an error. */
export function requirePagerDutyFromEmail(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > MAX_FROM_EMAIL_LENGTH ||
		!FROM_EMAIL_PATTERN.test(value)
	) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"pagerduty From address is not configured",
		);
	}
	return value;
}

function boundedTimeout(value: number | undefined): number {
	if (value === undefined) return PAGERDUTY_DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value)) return PAGERDUTY_DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(1, Math.floor(value)), PAGERDUTY_MAX_TIMEOUT_MS);
}

/**
 * Builds a caller with a hard call budget. Optional-resource failures set the
 * incomplete flag; the caller decides whether a mandatory resource fails the
 * whole bundle.
 */
export function createPagerDutyReadCaller(
	dependencies: PagerDutyReadCallerDependencies,
): PagerDutyReadCaller {
	const baseUrl = normalizePagerDutyBaseUrl(dependencies.baseUrl);
	const token = requirePagerDutyReadToken(dependencies.token);
	const fromEmail =
		dependencies.fromEmail === undefined
			? null
			: requirePagerDutyFromEmail(dependencies.fromEmail);
	const fetchImpl =
		dependencies.fetchImpl ?? ((request, init) => fetch(request, init));
	const timeoutMs = boundedTimeout(dependencies.timeoutMs);
	const maxCalls = Math.max(
		1,
		Math.min(dependencies.maxCalls ?? PAGERDUTY_MAX_CONTEXT_CALLS, 64),
	);
	let calls = 0;
	let incomplete = false;

	const headers: Record<string, string> = {
		Accept: PAGERDUTY_ACCEPT,
		"User-Agent": PAGERDUTY_USER_AGENT,
		Authorization: `Token token=${token}`,
	};
	if (fromEmail !== null) headers.From = fromEmail;

	return {
		get calls() {
			return calls;
		},
		markIncomplete() {
			incomplete = true;
		},
		isIncomplete() {
			return incomplete;
		},
		async call(path: string, step: string): Promise<PagerDutyCallResult> {
			if (!path.startsWith("/")) {
				return { kind: "skipped" };
			}
			if (calls >= maxCalls) {
				incomplete = true;
				return { kind: "budget" };
			}
			calls += 1;

			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}${path}`, {
					method: "GET",
					headers,
					// Refuse redirects: a provider hop must not forward the key.
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed to reach pagerduty`,
				);
			}

			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by pagerduty`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by pagerduty (status 401)`,
				);
			}
			if (response.status === 404) return { kind: "missing" };
			if (response.status === 403) {
				incomplete = true;
				return { kind: "denied" };
			}
			if (!response.ok) {
				incomplete = true;
				return { kind: "skipped" };
			}

			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > PAGERDUTY_MAX_RESPONSE_BYTES
			) {
				incomplete = true;
				return { kind: "skipped" };
			}

			// Chunked read: an oversized stream is abandoned at the cap, never buffered.
			const read = await readBoundedJson(response, {
				maxBytes: PAGERDUTY_MAX_RESPONSE_BYTES,
			});
			if (!read.ok) {
				incomplete = true;
				return { kind: "skipped" };
			}
			return { kind: "ok", body: read.data };
		},
	};
}
