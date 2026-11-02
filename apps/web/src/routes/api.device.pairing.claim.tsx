import { createFileRoute } from "@tanstack/react-router";
import { handleDevicePairingClaimRoute } from "../server/device-pairing.server";

/**
 * Relay claims a pairing code: `POST /api/device/pairing/claim` with a Bearer
 * device token and `{ code }`.
 *
 * The code is hashed and claimed atomically for this device only; the response
 * is bounded pairing metadata and never a provider secret. Server-only.
 */
export const Route = createFileRoute("/api/device/pairing/claim")({
	server: {
		handlers: {
			POST: ({ request }) => handleDevicePairingClaimRoute(request),
		},
	},
});
