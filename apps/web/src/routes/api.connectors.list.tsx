import { createFileRoute } from "@tanstack/react-router";
import { handleConnectorListRoute } from "../server/connector-connect.server";

/**
 * List connected connector metadata: `GET /api/connectors/list`.
 *
 * Tenant-scoped summaries only; the optional `?deviceId=` filter is bounded to
 * one UUID. `credentialRef` is an opaque device-side name, never a secret.
 * Server-only.
 */
export const Route = createFileRoute("/api/connectors/list")({
	server: {
		handlers: {
			GET: ({ request }) => handleConnectorListRoute(request),
		},
	},
});
