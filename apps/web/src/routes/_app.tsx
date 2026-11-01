import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageContainer } from "@/components/common/page-container";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";

export const Route = createFileRoute("/_app")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: AppLayout,
	pendingComponent: () => (
		<PageContainer>
			<div className="h-8 w-48 rounded bg-elevated/60" />
			<div className="h-64 w-full rounded bg-elevated/20" />
		</PageContainer>
	),
	errorComponent: () => (
		<PageContainer>
			<div
				role="alert"
				className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-ink-secondary"
			>
				The workspace could not be loaded. Retry in a moment.
			</div>
		</PageContainer>
	),
});

function AppLayout() {
	return (
		<AppShell>
			<Outlet />
		</AppShell>
	);
}
