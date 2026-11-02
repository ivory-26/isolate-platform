import { createFileRoute } from "@tanstack/react-router";
import { handleRelayInstallRequest } from "../server/relay-install.server";

/**
 * One-line relay installer: `GET /api/install/relay`.
 *
 * The response is a static, auditable shell script. The device token is passed
 * by the copyable command as an argument, never embedded in this route or its
 * cache. Server-only: no component, no client import.
 */
export const Route = createFileRoute("/api/install/relay")({
	server: {
		handlers: {
			GET: () => handleRelayInstallRequest(),
		},
	},
});
