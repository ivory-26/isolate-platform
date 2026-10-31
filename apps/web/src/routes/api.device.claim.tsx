import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceClaimRoute } from "../server/device-gateway.server";

/**
 * Device poll: `POST /api/device/claim` with a Bearer device token.
 *
 * The generated route tree is refreshed by the coordinator after merge; until
 * then the unregistered literal is widened so this file type-checks on its own.
 * Server-only: no component, no client import, no token handling in the bundle.
 */
export const Route = createFileRoute("/api/device/claim")({
	server: {
		handlers: {
			POST: ({ request }) => handleDeviceClaimRoute(request),
		},
	},
});
