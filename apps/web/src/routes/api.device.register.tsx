import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceRegisterRoute } from "../server/device-registration.server";

/**
 * Device registration: `POST /api/device/register` with `{ displayName }`.
 *
 * Owner/admin only. The server generates the device token, stores only its
 * sha256 hash and returns `{ deviceId, token }` exactly once with
 * `Cache-Control: no-store`. Server-only: no component, no client import.
 */
export const Route = createFileRoute("/api/device/register")({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceRegisterRoute(request),
		},
	},
});
