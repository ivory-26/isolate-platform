import { createFileRoute } from "@tanstack/react-router";
import { handleDevicePairingCreateRoute } from "../server/device-pairing.server";

/**
 * Start a browser pairing: `POST /api/device/pairing`.
 *
 * Owner/admin only. The body is metadata only (`relayId`, `connectorId`,
 * `displayName`, `authKind`, `credentialRef`, scopes); the provider secret is
 * entered on the relay's localhost page and never reaches this server. The
 * response carries the one-time code and local URL with `Cache-Control:
 * no-store`. Server-only.
 *
 * The trailing underscore keeps this route a sibling of `/pairing/claim`,
 * `/pairing/complete`, `/pairing/cancel` and `/pairing/$id` instead of turning
 * it into a layout parent; the URL is still `/api/device/pairing`.
 */
export const Route = createFileRoute("/api/device/pairing_")({
	server: {
		handlers: {
			POST: ({ request }) => handleDevicePairingCreateRoute(request),
		},
	},
});
