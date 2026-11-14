import { createFileRoute } from "@tanstack/react-router";
import { handleArtifactPayloadRoute } from "../server/artifacts-read.server";

/**
 * Tenant-scoped artifact payload: `GET /api/artifacts/{artifactId}`.
 *
 * Server-derived session scope only, `task:read` required, UUID-scoped artifact
 * lookup in the caller's organization, and bytes from the bounded blob store
 * only. Fixed 400/401/403/404/405/503 bodies, forced attachment download and
 * `Cache-Control: no-store`. Server-only: no component, no client import.
 */
export const Route = createFileRoute("/api/artifacts/$artifactId")({
	server: {
		handlers: {
			GET: ({ request }) => handleArtifactPayloadRoute(request),
		},
	},
});
