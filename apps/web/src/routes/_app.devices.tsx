import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Devices moved under Integrations → Relays in wave 23. The route stays as a
 * redirect so an older bookmark lands on the single relay surface instead of a
 * duplicate page.
 */
export const Route = createFileRoute("/_app/devices")({
	loader: () => {
		throw redirect({ to: "/integrations", search: { tab: "relays" } });
	},
	component: () => null,
});
