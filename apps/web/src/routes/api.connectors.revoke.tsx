import { createFileRoute } from "@tanstack/react-router";
import { handleConnectorRevokeRoute } from "../server/connector-connect.server";

/**
 * Disconnect a vendor: `POST /api/connectors/revoke` with `{ credentialId }`.
 *
 * Tenant-scoped, capability-checked and idempotent. The metadata row is kept as
 * `revoked`; the secret remains in the device keychain until the daemon deletes
 * it. Server-only.
 */
export const Route = createFileRoute("/api/connectors/revoke")({
	server: {
		handlers: {
			POST: ({ request }) => handleConnectorRevokeRoute(request),
		},
	},
});
