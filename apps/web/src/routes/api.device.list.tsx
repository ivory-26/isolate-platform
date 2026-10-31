import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceListRoute } from "../server/device-registration.server";

/**
 * Tenant device list: `GET /api/device/list`.
 *
 * Caller-scoped summaries only: id, display name, status and last seen time.
 * No token, no token hash, no cross-tenant row. Server-only.
 */
export const Route = createFileRoute("/api/device/list")({
	server: {
		handlers: {
			GET: ({ request }) => handleDeviceListRoute(request),
		},
	},
});
