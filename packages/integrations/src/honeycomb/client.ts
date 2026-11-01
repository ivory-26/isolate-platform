import { PlatformError } from "@isolate/shared";
import { readBoundedJson } from "../http/bounded-body";
import type { HoneycombFetchLike } from "./types";

/**
 * Bounded HTTP surface shared by the Honeycomb reader and its read-only tools.
 *
 * One fixed https origin (US by default, EU injected), one
 * `X-Honeycomb-Team` header, one timeout and a hard response cap. Provider
 * bodies never leave this module except as parsed JSON; error messages are
 * built from fixed step labels and never include the URL, key or provider
 * text. There is no retry here: 429 is surfaced so the caller can stop.
 */

export const HONEYCOMB_DEFAULT_API_BASE = "https://api.honeycomb.io";
export const HONEYCOMB_API_KEY_HEADER = "X-Honeycomb-Team";
export const HONEYCOMB_DEFAULT_TIMEOUT_MS = 10_000;
export const HONEYCOMB_MIN_TIMEOUT_MS = 1_000;
export const HONEYCOMB_MAX_TIMEOUT_MS = 30_000;
export const HONEYCOMB_MAX_RESPONSE_BYTES = 256 * 1024;
export const HONEYCOMB_REQUEST_USER_AGENT = "isolate-platform";
export const HONEYCOMB_API_PREFIX = "/1/";

export type HoneycombCallOutcome =
	| { kind: "ok"; body: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "failed" };

export type HoneycombHttpOptions = {
	readonly apiKey: string;
	readonly apiBaseUrl?: string;
	readonly fetchImpl?: HoneycombFetchLike;
	readonly timeoutMs?: number;
};

export type HoneycombHttpCall = {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly body?: unknown;
	readonly step: string;
};

export type HoneycombHttpClient = {
	readonly baseUrl: string;
	call(call: HoneycombHttpCall): Promise<HoneycombCallOutcome>;
};

const encoder = new TextEncoder();

/** https origin only: no credentials, query, fragment or path prefix. */
export function normalizeHoneycombBaseUrl(value: string | undefined): string {
	const candidate = value ?? HONEYCOMB_DEFAULT_API_BASE;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"honeycomb api base url is invalid",
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
			"honeycomb api base url is invalid",
		);
	}
	return url.origin;
}

export function clampHoneycombTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return HONEYCOMB_DEFAULT_TIMEOUT_MS;
	return Math.min(
		HONEYCOMB_MAX_TIMEOUT_MS,
		Math.max(HONEYCOMB_MIN_TIMEOUT_MS, Math.trunc(timeoutMs)),
	);
}

/**
 * Creates the client. An empty key is a configuration failure, not a request:
 * nothing is sent and no value is echoed.
 */
export function createHoneycombHttpClient(
	options: HoneycombHttpOptions,
): HoneycombHttpClient {
	const apiKey =
		typeof options.apiKey === "string" ? options.apiKey.trim() : "";
	if (apiKey.length === 0) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"honeycomb credential is not configured",
		);
	}
	const baseUrl = normalizeHoneycombBaseUrl(options.apiBaseUrl);
	const timeoutMs = clampHoneycombTimeout(options.timeoutMs);
	const fetchImpl =
		options.fetchImpl ?? ((request, init) => fetch(request, init));
	const headers = {
		Accept: "application/json",
		"Content-Type": "application/json",
		"User-Agent": HONEYCOMB_REQUEST_USER_AGENT,
		[HONEYCOMB_API_KEY_HEADER]: apiKey,
	};

	return {
		baseUrl,
		async call(call) {
			if (
				!call.path.startsWith(HONEYCOMB_API_PREFIX) ||
				call.path.includes("?") ||
				call.path.includes("#") ||
				call.path.includes("..")
			) {
				throw new PlatformError(
					"INTERNAL",
					"honeycomb reader rejected a non-api path",
				);
			}
			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}${call.path}`, {
					method: call.method,
					headers,
					body: call.body === undefined ? undefined : JSON.stringify(call.body),
					// Refuse redirects: a provider hop must not forward the key.
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${call.step} failed to reach honeycomb`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${call.step} was rate limited by honeycomb`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${call.step} was rejected by honeycomb (status 401)`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) return { kind: "failed" };
			const declared = Number(response.headers.get("content-length"));
			if (
				Number.isFinite(declared) &&
				declared > HONEYCOMB_MAX_RESPONSE_BYTES
			) {
				return { kind: "failed" };
			}
			// Chunked read: an oversized stream is abandoned at the cap, never buffered.
			const read = await readBoundedJson(response, {
				maxBytes: HONEYCOMB_MAX_RESPONSE_BYTES,
			});
			if (!read.ok) return { kind: "failed" };
			return { kind: "ok", body: read.data };
		},
	};
}

export async function honeycombSha256Hex(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		encoder.encode(text),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Fixed-width bound used for every provider string that reaches an excerpt. */
export function boundText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Redact-then-truncate under both the character and byte budgets. The callers
 * pass an already-redacted string; the returned `truncated` flag drives
 * `truncated` on the bundle and the tool result.
 */
export function capHoneycombExcerpt(
	text: string,
	maxChars: number,
	maxBytes: number,
): { text: string; truncated: boolean } {
	let out = text;
	let truncated = false;
	if (out.length > maxChars) {
		out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
		truncated = true;
	}
	while (out.length > 1 && encoder.encode(out).byteLength > maxBytes) {
		const nextLength = Math.max(1, Math.floor(out.length * 0.9));
		out = out.slice(0, nextLength);
		truncated = true;
	}
	return { text: out, truncated };
}
