import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceHeartbeatRoute } from "../server/device-gateway.server";

/**
 * Device heartbeat: `POST /api/device/heartbeat` with a Bearer token.
 *
 * Touches `last_seen_at` and returns `{ ok: true }`; it carries no work and no
 * provider material. Server-only.
 */
export const Route = createFileRoute("/api/device/heartbeat")({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceHeartbeatRoute(request),
		},
	},
});
