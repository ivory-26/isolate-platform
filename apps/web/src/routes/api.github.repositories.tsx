import { createFileRoute } from "@tanstack/react-router";
import { handleGitHubRepositoriesRoute } from "../server/github-install.server";

/**
 * List the active installation's repositories:
 * `GET /api/github/repositories` → bounded `{ repositories, truncated }`.
 *
 * Owner/admin only, tenant-scoped, no token in the response.
 */
export const Route = createFileRoute("/api/github/repositories")({
	server: {
		handlers: {
			GET: ({ request }) => handleGitHubRepositoriesRoute(request),
		},
	},
});
