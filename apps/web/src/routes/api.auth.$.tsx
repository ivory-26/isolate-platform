import { createFileRoute } from "@tanstack/react-router";
import { handleNeonAuthProxyRequest } from "../server/neon-auth.server";
import { getNeonAuthProxySettings } from "../server/runtime.server";

/**
 * The upstream auth API, mounted on this origin.
 *
 * The browser never talks to the auth host directly: cookies stay first-party
 * and the auth SDK never enters the client bundle. The route carries only a
 * `server` property, so the router plugin keeps it out of the client tree.
 */
export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => proxy(request),
			POST: ({ request }) => proxy(request),
		},
	},
});

function proxy(request: Request): Promise<Response> {
	try {
		return handleNeonAuthProxyRequest(
			request,
			authSubPath(request),
			getNeonAuthProxySettings(),
		);
	} catch {
		return Promise.resolve(
			Response.json(
				{
					error: "Authentication is not configured.",
					code: "AUTH_UNAVAILABLE",
				},
				{ status: 503 },
			),
		);
	}
}

/** The path below `/api/auth/`, as the upstream auth host expects it. */
function authSubPath(request: Request): string {
	const pathname = new URL(request.url).pathname;
	const marker = "/api/auth/";
	const index = pathname.indexOf(marker);
	if (index < 0) return "";
	return pathname.slice(index + marker.length);
}
