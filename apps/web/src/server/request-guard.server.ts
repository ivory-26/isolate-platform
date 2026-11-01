import "@tanstack/react-start/server-only";

/**
 * Request-boundary guards for state-changing web routes (W18).
 *
 * Three independent checks a route must run before it reads or trusts a
 * request:
 * 1. `assertSameOrigin` — an unsafe method must carry an `Origin` that matches
 *    the request `Host` (or a configured allowlist), and `Sec-Fetch-Site` may
 *    never report `cross-site`, `same-site` or `opaque`. This is the CSRF
 *    boundary for cookie-authenticated routes.
 * 2. `assertJsonRequest` — a JSON body must declare `application/json`
 *    (parameters such as `charset` are allowed) and, when `Content-Length` is
 *    present, stay within the byte cap.
 * 3. `clientIp` — the client address is a constant unless the deployment
 *    explicitly trusts proxy headers, so a forged `x-forwarded-for` cannot
 *    move a caller into someone else's rate-limit bucket.
 *
 * Failures throw a `RequestGuardError` with a fixed message: header and body
 * values, including a rejected `Origin`, are never echoed into the error.
 */

/** Whole-body cap for a JSON request; matches the webhook receiver. */
export const REQUEST_GUARD_MAX_JSON_BYTES = 64 * 1024;

/**
 * Bucket key used when the address cannot be trusted (proxy headers disabled
 * or malformed). Every untrusted caller shares this constant bucket.
 */
export const UNTRUSTED_CLIENT_IP = "unknown";

/** Methods that never carry a request body. */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Methods whose body must be JSON when the guard is applied. */
const JSON_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

export type RequestGuardCode =
	| "ORIGIN_REJECTED"
	| "UNSUPPORTED_MEDIA_TYPE"
	| "PAYLOAD_TOO_LARGE"
	| "INVALID_CONTENT_LENGTH";

/** The fixed response status a guard failure maps to. */
const STATUS_FOR_CODE: Readonly<Record<RequestGuardCode, number>> = {
	ORIGIN_REJECTED: 403,
	UNSUPPORTED_MEDIA_TYPE: 415,
	PAYLOAD_TOO_LARGE: 413,
	INVALID_CONTENT_LENGTH: 400,
};

/**
 * Fixed, value-free guard failure. The message is the same for every origin
 * rejection so a caller cannot learn which comparison failed, and the
 * `code`/`status` are stable for logging and responses.
 */
export class RequestGuardError extends Error {
	readonly code: RequestGuardCode;
	readonly status: number;

	constructor(code: RequestGuardCode) {
		super("request rejected");
		this.name = "RequestGuardError";
		this.code = code;
		this.status = STATUS_FOR_CODE[code];
	}
}

function reject(code: RequestGuardCode): never {
	throw new RequestGuardError(code);
}

/** Parses one origin, rejecting `null`, opaque and non-http(s) values. */
function parseOrigin(value: string): string | null {
	if (value.length === 0 || value.length > 512) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		// An `Origin` header is exactly a serialized origin: no path or query.
		if (url.origin.toLowerCase() !== value.toLowerCase()) return null;
		return url.origin.toLowerCase();
	} catch {
		return null;
	}
}

/** The request's own host, from `Host` or the request URL as a fallback. */
function requestHost(request: Request): string | null {
	const header = request.headers.get("host");
	if (header !== null && header.length > 0 && header.length <= 255) {
		return header.toLowerCase();
	}
	try {
		return new URL(request.url).host.toLowerCase();
	} catch {
		return null;
	}
}

export type SameOriginOptions = {
	/**
	 * Exact origins to accept. When present (including an empty list) it is
	 * authoritative and `Host` is not consulted; otherwise the request is
	 * same-origin only.
	 */
	allowedOrigins?: readonly string[];
};

/**
 * Refuses a cross-site or opaque request, and any unsafe method without an
 * `Origin`. Safe methods may omit `Origin` (top-level navigation), but when
 * one is present it is still checked.
 */
export function assertSameOrigin(
	request: Request,
	options: SameOriginOptions = {},
): void {
	const method = request.method.toUpperCase();
	const unsafe = !SAFE_METHODS.has(method);

	const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
	if (
		fetchSite !== undefined &&
		fetchSite.length > 0 &&
		fetchSite !== "same-origin" &&
		fetchSite !== "none"
	) {
		// Same-site is still cross-origin: another subdomain may be attacker-held,
		// and an opaque/deprecated value cannot be verified.
		reject("ORIGIN_REJECTED");
	}

	const originHeader = request.headers.get("origin");
	if (originHeader === null) {
		// An unsafe method must prove its origin; a browser always sends it.
		if (unsafe) reject("ORIGIN_REJECTED");
		return;
	}
	const rawOrigin = originHeader.trim();
	// Multiple `Origin` values are joined with ", " and cannot be trusted.
	if (rawOrigin.includes(",")) reject("ORIGIN_REJECTED");
	// `Origin: null` is an opaque origin (sandboxed frame, file://).
	if (rawOrigin.toLowerCase() === "null") reject("ORIGIN_REJECTED");
	// A stated opaque fetch cannot also present a concrete origin.
	if (fetchSite === "none") reject("ORIGIN_REJECTED");

	const origin = parseOrigin(rawOrigin);
	if (origin === null) reject("ORIGIN_REJECTED");

	if (options.allowedOrigins !== undefined) {
		const allowed = new Set<string>();
		for (const entry of options.allowedOrigins) {
			const parsed = parseOrigin(entry.trim());
			if (parsed !== null) allowed.add(parsed);
		}
		if (!allowed.has(origin)) reject("ORIGIN_REJECTED");
		return;
	}

	const host = requestHost(request);
	const originUrl = new URL(origin);
	if (host === null || originUrl.host.toLowerCase() !== host) {
		reject("ORIGIN_REJECTED");
	}
	// Never accept a downgraded origin for a TLS request. A plain-http request
	// URL behind a TLS-terminating proxy cannot prove the scheme, so it accepts
	// either scheme as long as the host matches.
	const requestProtocol = requestProtocolOf(request);
	if (requestProtocol === "https:" && originUrl.protocol !== "https:") {
		reject("ORIGIN_REJECTED");
	}
}

function requestProtocolOf(request: Request): string | null {
	try {
		return new URL(request.url).protocol;
	} catch {
		return null;
	}
}

export type JsonRequestOptions = {
	/** Maximum accepted body size; defaults to 64 KiB. */
	maxBytes?: number;
};

/**
 * Requires a JSON media type for methods that carry a body and bounds a
 * declared `Content-Length`. A missing header is allowed here (a chunked body
 * has none); the reader must still stop at `maxBytes` while streaming.
 */
export function assertJsonRequest(
	request: Request,
	options: JsonRequestOptions = {},
): void {
	const method = request.method.toUpperCase();
	if (!JSON_METHODS.has(method)) return;

	const contentType = request.headers.get("content-type");
	if (contentType === null) reject("UNSUPPORTED_MEDIA_TYPE");
	// `application/json; charset=utf-8` is the same media type.
	const [mediaType] = contentType.split(";", 1);
	if (mediaType.trim().toLowerCase() !== "application/json") {
		reject("UNSUPPORTED_MEDIA_TYPE");
	}

	const maxBytes = options.maxBytes ?? REQUEST_GUARD_MAX_JSON_BYTES;
	const lengthHeader = request.headers.get("content-length");
	if (lengthHeader === null) return;
	const trimmed = lengthHeader.trim();
	// Duplicate headers arrive joined as "1, 2"; a sign or unit is also invalid.
	if (!/^[0-9]{1,15}$/.test(trimmed)) reject("INVALID_CONTENT_LENGTH");
	const declared = Number(trimmed);
	if (!Number.isSafeInteger(declared) || declared > maxBytes) {
		reject("PAYLOAD_TOO_LARGE");
	}
}

const IPV4_PATTERN =
	/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const IPV6_PATTERN =
	/^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%[A-Za-z0-9._-]{1,32})?$/i;

/** True for a plain IPv4/IPv6 literal; ports, zones and names are refused. */
function normalizeIpLiteral(value: string): string | null {
	if (IPV4_PATTERN.test(value)) return value;
	const unwrapped =
		value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	if (!unwrapped.includes(":")) return null;
	return IPV6_PATTERN.test(unwrapped) ? unwrapped : null;
}

export type ClientIpOptions = {
	/** Only a deployment that terminates its own proxy may enable this. */
	trustProxy?: boolean;
};

/**
 * The caller's address, or the shared `UNTRUSTED_CLIENT_IP` constant. Header
 * trust is opt-in (`TRUST_PROXY_HEADERS`), so a direct caller cannot spoof a
 * bucket by sending `x-forwarded-for` itself.
 */
export function clientIp(
	request: Request,
	options: ClientIpOptions = {},
): string {
	if (options.trustProxy !== true) return UNTRUSTED_CLIENT_IP;
	const header = request.headers.get("x-forwarded-for");
	if (header === null) return UNTRUSTED_CLIENT_IP;
	const first = header.split(",", 1)[0]?.trim() ?? "";
	return normalizeIpLiteral(first) ?? UNTRUSTED_CLIENT_IP;
}
