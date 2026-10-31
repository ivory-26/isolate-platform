import { PlatformError } from "@isolate/shared";

/**
 * Bounded HTTP surface shared by the Sentry reader and tools.
 *
 * One fixed origin, one Authorization header, one timeout and a hard response
 * cap. Provider bodies never leave this module except as parsed JSON; error
 * messages are built from fixed step labels and never include the URL, the
 * token or provider text.
 */

export const SENTRY_DEFAULT_BASE_URL = "https://sentry.io";
export const SENTRY_DEFAULT_TIMEOUT_MS = 10_000;
export const SENTRY_MIN_TIMEOUT_MS = 1_000;
export const SENTRY_MAX_TIMEOUT_MS = 30_000;
export const SENTRY_MAX_RESPONSE_BYTES = 256 * 1024;
export const SENTRY_REQUEST_USER_AGENT = "isolate-platform";
export const SENTRY_API_PREFIX = "/api/0/";

export type SentryCallOutcome =
	| { kind: "ok"; body: unknown }
	| { kind: "missing" }
	| { kind: "denied" }
	| { kind: "skipped" };

export type SentryHttpClient = {
	readonly baseUrl: string;
	call(path: string, step: string): Promise<SentryCallOutcome>;
};

export type SentryHttpOptions = {
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
};

const encoder = new TextEncoder();

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** https origin only: no credentials, query, fragment or path prefix. */
export function normalizeSentryBaseUrl(value: string | undefined): string {
	const candidate = value ?? SENTRY_DEFAULT_BASE_URL;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new PlatformError("VALIDATION_FAILED", "sentry base url is invalid");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new PlatformError("VALIDATION_FAILED", "sentry base url is invalid");
	}
	return url.origin;
}

export function clampTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return SENTRY_DEFAULT_TIMEOUT_MS;
	return Math.min(
		SENTRY_MAX_TIMEOUT_MS,
		Math.max(SENTRY_MIN_TIMEOUT_MS, Math.trunc(timeoutMs)),
	);
}

/**
 * Creates the client. An empty or whitespace token is a configuration failure,
 * not a request: nothing is sent and no value is echoed.
 */
export function createSentryHttpClient(
	options: SentryHttpOptions,
): SentryHttpClient {
	const token = typeof options.token === "string" ? options.token.trim() : "";
	if (token.length === 0) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"sentry credential is not configured",
		);
	}
	const baseUrl = normalizeSentryBaseUrl(options.baseUrl);
	const timeoutMs = clampTimeout(options.timeoutMs);
	const fetchImpl =
		options.fetchImpl ?? ((request, init) => fetch(request, init));
	const headers = {
		Accept: "application/json",
		"User-Agent": SENTRY_REQUEST_USER_AGENT,
		Authorization: `Bearer ${token}`,
	};

	return {
		baseUrl,
		async call(path, step) {
			if (!path.startsWith(SENTRY_API_PREFIX)) {
				throw new PlatformError(
					"INTERNAL",
					"sentry reader rejected a non-api path",
				);
			}
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
					`${step} failed to reach sentry`,
				);
			}
			if (response.status === 429) {
				throw new PlatformError(
					"RATE_LIMITED",
					`${step} was rate limited by sentry`,
				);
			}
			if (response.status === 401) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} was rejected by sentry (status 401)`,
				);
			}
			if (response.status === 403) return { kind: "denied" };
			if (response.status === 404) return { kind: "missing" };
			if (!response.ok) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`${step} failed at sentry (status ${response.status})`,
				);
			}
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > SENTRY_MAX_RESPONSE_BYTES) {
				return { kind: "skipped" };
			}
			let text: string;
			try {
				text = await response.text();
			} catch {
				return { kind: "skipped" };
			}
			if (encoder.encode(text).byteLength > SENTRY_MAX_RESPONSE_BYTES) {
				return { kind: "skipped" };
			}
			const body = parseJson(text);
			if (body === undefined) return { kind: "skipped" };
			return { kind: "ok", body };
		},
	};
}

export async function sentrySha256Hex(text: string): Promise<string> {
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
