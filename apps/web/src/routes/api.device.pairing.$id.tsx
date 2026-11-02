import { createFileRoute } from "@tanstack/react-router";
import { handleDevicePairingStatusRoute } from "../server/device-pairing.server";

/**
 * Pairing status: `GET /api/device/pairing/{id}` for the signed-in owner/admin.
 *
 * Returns the bounded status and, once the relay completes, the credential id.
 * An elapsed session is reported (and marked) `expired`. Server-only.
 */
export const Route = createFileRoute("/api/device/pairing/$id")({
	server: {
		handlers: {
			GET: ({ request }) => handleDevicePairingStatusRoute(request),
		},
	},
});
