import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Layout for `/runs` and `/runs/$taskId`.
 *
 * The list lives in `_app.runs.index.tsx`; this file only renders the active
 * child. Without the Outlet the detail route never mounted and every run link
 * silently showed the list instead.
 */
export const Route = createFileRoute("/_app/runs")({
	component: RunsLayout,
});

function RunsLayout() {
	return <Outlet />;
}
