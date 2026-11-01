import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageContainer } from "../../components/common/page-container";
import { AppShell } from "../../components/shell/app-shell";
import { requireSession } from "../../features/auth/guard";
import { authStateOptions } from "../../features/auth/queries";

export const Route = createFileRoute("/organizations")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: OrganizationsLayout,
	errorComponent: () => (
		<AppShell>
			<PageContainer>
				<div
					role="alert"
					className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-ink-secondary"
				>
					Organizations could not be loaded. Retry in a moment.
				</div>
			</PageContainer>
		</AppShell>
	),
});

function OrganizationsLayout() {
	return (
		<AppShell>
			<Outlet />
		</AppShell>
	);
}
