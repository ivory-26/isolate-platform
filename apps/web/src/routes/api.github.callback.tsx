import { createFileRoute } from "@tanstack/react-router";
import { handleGitHubCallbackRoute } from "../server/github-install.server";

/**
 * GitHub App setup callback: `GET /api/github/callback?state=…&installation_id=…`.
 *
 * Verifies the signed state, re-resolves the caller's membership, fetches the
 * installation's account metadata with the App JWT and stores the
 * tenant-scoped installation. Success and fixed failures redirect back to
 * `/repositories`; no state, token or provider body appears in the redirect.
 */
export const Route = createFileRoute("/api/github/callback")({
	server: {
		handlers: {
			GET: ({ request }) => handleGitHubCallbackRoute(request),
		},
	},
});
