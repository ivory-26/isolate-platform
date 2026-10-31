import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceRevokeRoute } from "../server/device-registration.server";

/**
 * Device revocation: `POST /api/device/revoke` with `{ deviceId }`.
 *
 * Owner/admin only, tenant-scoped and idempotent. A revoked token can no longer
 * poll and the device's credentials stop resolving for the broker. Server-only.
 */
export const Route = createFileRoute("/api/device/revoke")({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceRevokeRoute(request),
		},
	},
});
