import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceRotateRoute } from "../server/device-registration.server";

/**
 * Device token rotation: `POST /api/device/rotate` with `{ deviceId }`.
 *
 * Owner/admin only, tenant-scoped. The server mints a fresh 256-bit token,
 * stores only its sha256 hash with a renewed 90-day expiry and returns
 * `{ deviceId, token, expiresAt }` exactly once. The previous token stops
 * authenticating immediately. Server-only: no component, no client import.
 */
export const Route = createFileRoute("/api/device/rotate")({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceRotateRoute(request),
		},
	},
});
