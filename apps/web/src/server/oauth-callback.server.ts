import "@tanstack/react-start/server-only";
import {
	type AuthMiddlewareConfig,
	processAuthMiddleware,
} from "@neondatabase/auth/server";
import type { NeonAuthSettings } from "./neon-auth.server";

/**
 * OAuth return path (framework-agnostic so it can be tested).
 *
 * Google sends the browser back with a `neon_auth_session_verifier` parameter
 * and the first-party challenge cookie set by the proxied sign-in call.
 * `processAuthMiddleware` exchanges the verifier for session cookies and
 * returns the callback URL with the verifier stripped. This module only
 * relays the SDK's decision: it never parses identity itself.
 */

export type MiddlewareDecision = Awaited<
	ReturnType<typeof processAuthMiddleware>
>;

export type ProcessMiddleware = (
	config: AuthMiddlewareConfig,
) => Promise<MiddlewareDecision>;

export function redirectTo(url: URL, cookies: readonly string[]): Response {
	const headers = new Headers({
		Location: url.toString(),
		"Cache-Control": "private, no-store",
	});
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

export async function completeOAuthCallback(
	request: Request,
	settings: NeonAuthSettings,
	process: ProcessMiddleware = processAuthMiddleware,
): Promise<Response> {
	try {
		const decision = await process({
			request,
			pathname: new URL(request.url).pathname,
			skipRoutes: [],
			loginUrl: "/login",
			baseUrl: settings.baseUrl,
			cookieSecret: settings.cookieSecret,
			sameSite: settings.sameSite,
			...(settings.domain === undefined ? {} : { domain: settings.domain }),
			...(settings.sessionDataTtl === undefined
				? {}
				: { sessionDataTtl: settings.sessionDataTtl }),
		});
		const cookies = decision.cookies ?? [];
		if (decision.action === "redirect_oauth") {
			return redirectTo(decision.redirectUrl, cookies);
		}
		if (decision.action === "allow") {
			return redirectTo(new URL("/", request.url), cookies);
		}
		return redirectTo(
			new URL("/login?authError=callback", request.url),
			cookies,
		);
	} catch {
		return redirectTo(new URL("/login?authError=callback", request.url), []);
	}
}
