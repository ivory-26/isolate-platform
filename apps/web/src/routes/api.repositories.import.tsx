import { createFileRoute } from "@tanstack/react-router";
import { handleRepositoryImportRoute } from "../server/github-install.server";

/**
 * Import selected installation repositories:
 * `POST /api/repositories/import` with `{ fullNames: string[] }` (<= 25).
 *
 * Owner/admin only. Each name must be visible to this tenant's active
 * installation; duplicates and unknown names are reported as `skipped`.
 */
export const Route = createFileRoute("/api/repositories/import")({
	server: {
		handlers: {
			POST: ({ request }) => handleRepositoryImportRoute(request),
		},
	},
});
