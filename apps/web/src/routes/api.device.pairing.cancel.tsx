import { createFileRoute } from "@tanstack/react-router";
import { handleDevicePairingCancelRoute } from "../server/device-pairing.server";

/**
 * Cancel a pending pairing: `POST /api/device/pairing/cancel` with
 * `{ pairingId }`.
 *
 * Owner/admin and tenant-scoped. A completed or expired session is a fixed 409;
 * repeating a cancel is harmless. Server-only.
 */
export const Route = createFileRoute("/api/device/pairing/cancel")({
	server: {
		handlers: {
			POST: ({ request }) => handleDevicePairingCancelRoute(request),
		},
	},
});
