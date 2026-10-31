import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceResultRoute } from "../server/device-gateway.server";

/**
 * Device result: `POST /api/device/calls/{id}/result` with a Bearer token.
 *
 * The call id is read from the bounded path by the gateway, so a malformed id
 * is a 404 and never reaches the database as a cast error. Server-only.
 */
export const Route = createFileRoute("/api/device/calls/$id/result" as never)({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceResultRoute(request),
		},
	},
});
