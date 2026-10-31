import { createFileRoute } from "@tanstack/react-router";
import { handleConnectorConnectRoute } from "../server/connector-connect.server";

/**
 * Connect a vendor: `POST /api/connectors/connect`.
 *
 * The body is metadata only (`deviceId`, `connectorId`, `displayName`,
 * `authKind`, `credentialRef`, scopes, free-tier profile, metadata). The
 * provider secret is written on the device keychain and never submitted here.
 * Server-only: no component, no client import, no secret handling in the
 * bundle.
 */
export const Route = createFileRoute("/api/connectors/connect")({
	server: {
		handlers: {
			POST: ({ request }) => handleConnectorConnectRoute(request),
		},
	},
});
