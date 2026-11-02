import { createFileRoute } from "@tanstack/react-router";
import { handleGitHubInstallRoute } from "../server/github-install.server";

/**
 * Start the per-organization GitHub App installation:
 * `GET /api/github/install` → 302 to GitHub's `installations/new` page with a
 * signed, 10-minute, tenant-bound `state` query parameter.
 *
 * Owner/admin only. A missing App configuration is a fixed
 * `GITHUB_APP_NOT_CONFIGURED` response; no key, state or token is logged.
 */
export const Route = createFileRoute("/api/github/install")({
	server: {
		handlers: {
			GET: ({ request }) => handleGitHubInstallRoute(request),
		},
	},
});
