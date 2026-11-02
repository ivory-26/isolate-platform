import { createFileRoute } from "@tanstack/react-router";
import { handleDevicePairingCompleteRoute } from "../server/device-pairing.server";

/**
 * Relay completes a pairing: `POST /api/device/pairing/complete` with a Bearer
 * device token and `{ pairingId }`.
 *
 * Creates (or reuses) the metadata-only `connector_credentials` row as
 * `pending_validation`, marks the pairing completed and returns the credential
 * id. The relay never submits the secret here. Server-only.
 */
export const Route = createFileRoute("/api/device/pairing/complete")({
	server: {
		handlers: {
			POST: ({ request }) => handleDevicePairingCompleteRoute(request),
		},
	},
});
