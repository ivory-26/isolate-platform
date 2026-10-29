import "@tanstack/react-start/server-only";
import {
	type CookieOptions,
	createAuthServer,
	extractNeonAuthCookies,
	handleAuthProxyRequest,
	type NeonAuthServer,
	type RequestContext,
} from "@neondatabase/auth/server";
import {
	getRequestHeaders,
	getRequestUrl,
	setCookie,
} from "@tanstack/react-start/server";
import { z } from "zod";

/**
 * Neon Managed Better Auth (Neon Auth) server adapter.
 *
 * The browser never talks to the auth host. Every call is issued from the
 * server and the session cookies are rewritten onto this origin, so the
 * Better Auth client never enters the client bundle and no third-party cookie
 * is involved.
 */
export const NEON_AUTH_BASE_URL_VARIABLE = "NEON_AUTH_BASE_URL";
export const NEON_AUTH_COOKIE_SECRET_VARIABLE = "NEON_AUTH_COOKIE_SECRET";
export const NEON_AUTH_COOKIE_DOMAIN_VARIABLE = "NEON_AUTH_COOKIE_DOMAIN";
export const NEON_AUTH_COOKIE_SAME_SITE_VARIABLE = "NEON_AUTH_COOKIE_SAME_SITE";
export const NEON_AUTH_SESSION_TTL_VARIABLE = "NEON_AUTH_SESSION_TTL";

/** The SDK refuses shorter secrets; fail before the first request instead. */
export const NEON_AUTH_MINIMUM_SECRET_LENGTH = 32;

const settingsSchema = z.strictObject({
	baseUrl: z
		.url()
		.refine(
			(value) => value.startsWith("https://"),
			"auth base url must be https",
		),
	cookieSecret: z.string().min(NEON_AUTH_MINIMUM_SECRET_LENGTH),
	sameSite: z.enum(["strict", "lax", "none"]),
	domain: z.string().min(1).optional(),
	sessionDataTtl: z.number().int().positive().optional(),
});

export type NeonAuthSettings = {
	baseUrl: string;
	cookieSecret: string;
	sameSite: "strict" | "lax" | "none";
	domain?: string;
	sessionDataTtl?: number;
};

export type NeonAuthEnvironment = Record<string, string | undefined>;

/**
 * Read the auth settings from the environment. Returns null when the auth
 * host is not configured or the configuration is unusable, so callers fail
 * closed instead of serving an unauthenticated tenant.
 */
export function readNeonAuthSettings(
	env: NeonAuthEnvironment,
): NeonAuthSettings | null {
	const baseUrl = env[NEON_AUTH_BASE_URL_VARIABLE]?.trim();
	const cookieSecret = env[NEON_AUTH_COOKIE_SECRET_VARIABLE]?.trim();
	if (!baseUrl || !cookieSecret) return null;
	const domain = env[NEON_AUTH_COOKIE_DOMAIN_VARIABLE]?.trim();
	const ttl = env[NEON_AUTH_SESSION_TTL_VARIABLE]?.trim();
	const parsed = settingsSchema.safeParse({
		baseUrl,
		cookieSecret,
		sameSite: env[NEON_AUTH_COOKIE_SAME_SITE_VARIABLE]?.trim() || "lax",
		...(domain ? { domain } : {}),
		...(ttl ? { sessionDataTtl: Number(ttl) } : {}),
	});
	return parsed.success ? parsed.data : null;
}

function requestOrigin(): string {
	const headers = getRequestHeaders();
	const origin = headers.get("origin");
	if (origin) return origin;
	const referer = headers.get("referer");
	if (referer) {
		try {
			return new URL(referer).origin;
		} catch {
			// A malformed Referer is not an identity input; fall through.
		}
	}
	return getRequestUrl().origin;
}

/**
 * Adapt the SDK's framework-agnostic request contract to TanStack Start.
 * `getCookies` is restricted to the Neon Auth cookie prefix so unrelated
 * application cookies are never forwarded upstream.
 */
export function createNeonAuthRequestContext(): RequestContext {
	return {
		getCookies: () => extractNeonAuthCookies(getRequestHeaders()),
		setCookie: (name, value, options) => {
			setCookie(name, value, toCookieOptions(options));
		},
		getHeader: (name) => getRequestHeaders().get(name) ?? null,
		getOrigin: () => requestOrigin(),
		getFramework: () => "tanstack-start",
	};
}

function toCookieOptions(options: CookieOptions) {
	return {
		...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
		...(options.expires === undefined ? {} : { expires: options.expires }),
		path: options.path ?? "/",
		...(options.domain === undefined ? {} : { domain: options.domain }),
		secure: options.secure ?? true,
		httpOnly: options.httpOnly ?? true,
		...(options.sameSite === undefined ? {} : { sameSite: options.sameSite }),
	};
}

const servers = new WeakMap<NeonAuthSettings, NeonAuthServer>();

export function getNeonAuthServer(settings: NeonAuthSettings): NeonAuthServer {
	const existing = servers.get(settings);
	if (existing) return existing;
	const server = createAuthServer({
		baseUrl: settings.baseUrl,
		cookieSecret: settings.cookieSecret,
		context: createNeonAuthRequestContext,
		sameSite: settings.sameSite,
		...(settings.domain ? { domain: settings.domain } : {}),
		...(settings.sessionDataTtl
			? { sessionDataTtl: settings.sessionDataTtl }
			: {}),
	});
	servers.set(settings, server);
	return server;
}

/**
 * Mount the upstream auth API under this origin. The upstream path segment is
 * caller supplied and must stay inside the auth host's API surface.
 */
export async function handleNeonAuthProxyRequest(
	request: Request,
	path: string,
	settings: NeonAuthSettings,
): Promise<Response> {
	return handleAuthProxyRequest({
		request,
		path,
		baseUrl: settings.baseUrl,
		cookieSecret: settings.cookieSecret,
		sameSite: settings.sameSite,
		...(settings.domain ? { domain: settings.domain } : {}),
		...(settings.sessionDataTtl
			? { sessionDataTtl: settings.sessionDataTtl }
			: {}),
	});
}
