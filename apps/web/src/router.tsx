import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { WORKSPACE_SCROLL_ROUTER_OPTIONS } from "@/lib/workspace-scroll";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 10_000, retry: false },
			mutations: { retry: false },
		},
	});
	const router = createRouter({
		routeTree,
		context: { queryClient },
		...WORKSPACE_SCROLL_ROUTER_OPTIONS,
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});
	setupRouterSsrQueryIntegration({ router, queryClient });
	return router;
}
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
