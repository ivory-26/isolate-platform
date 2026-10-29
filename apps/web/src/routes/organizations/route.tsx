import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireSession } from "../../features/auth/guard";
import { authStateOptions } from "../../features/auth/queries";

export const Route = createFileRoute("/organizations")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: OrganizationsLayout,
});

function OrganizationsLayout() {
	return <Outlet />;
}
