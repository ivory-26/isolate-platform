import { createFileRoute } from "@tanstack/react-router";
import { handleTaskTraceRoute } from "../server/trace-read.server";

/**
 * Tenant-scoped task trace: `GET /api/traces/{taskId}`.
 *
 * Server-derived session scope only, `task:read` required, fixed
 * 400/401/403/404/503 bodies and `Cache-Control: no-store`. The payload holds
 * identifiers, counts, outcomes and a tool-argument digest — never a payload or
 * credential. Server-only: no component, no client import.
 */
export const Route = createFileRoute("/api/traces/$taskId")({
	server: {
		handlers: {
			GET: ({ request }) => handleTaskTraceRoute(request),
		},
	},
});
