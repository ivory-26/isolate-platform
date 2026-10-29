import { createFileRoute } from "@tanstack/react-router";
import {
	completeOAuthCallback,
	redirectTo,
} from "../server/oauth-callback.server";
import { getNeonAuthProxySettings } from "../server/runtime.server";

/**
 * OAuth return path. The exchange and cookie relay live in
 * `oauth-callback.server.ts`; this route only supplies the configured auth
 * host and fails closed when it is absent.
 */
export const Route = createFileRoute("/auth/callback")({
	server: {
		handlers: {
			GET: ({ request }) => handleCallback(request),
		},
	},
});

function handleCallback(request: Request): Promise<Response> {
	let settings: ReturnType<typeof getNeonAuthProxySettings>;
	try {
		settings = getNeonAuthProxySettings();
	} catch {
		return Promise.resolve(
			redirectTo(new URL("/login?authError=unavailable", request.url), []),
		);
	}
	return completeOAuthCallback(request, settings);
}
