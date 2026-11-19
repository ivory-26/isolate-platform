import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { workspaceScrollRouterOptions } from "@/lib/workspace-scroll";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 10_000, retry: false },
			mutations: { retry: false },
		},
	});
	// The scroll predicate runs after the router exists (on render and while
	// generating the SSR restoration script), so hand it a late-bound reader
	// rather than referencing `router` inside its own initializer.
	let readMatches: () => ReadonlyArray<{ routeId: string }> = () => [];
	const router = createRouter({
		routeTree,
		context: { queryClient },
		// Only layouts that mount the reading pane suppress the router's own
		// document scrolling; public pages keep native router restoration.
		...workspaceScrollRouterOptions(() => readMatches()),
		defaultPreload: "intent",
		defaultPreloadStaleTime: 0,
	});
	readMatches = () => router.state.matches;
	setupRouterSsrQueryIntegration({ router, queryClient });
	return router;
}
declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
