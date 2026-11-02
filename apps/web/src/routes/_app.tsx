import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { PageContainer } from "@/components/common/page-container";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";
import { shouldStartOnboarding } from "@/features/onboarding/contracts";
import { setupStateOptions } from "@/features/onboarding/queries";

export const Route = createFileRoute("/_app")({
	loader: async ({ context, location }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		const session = requireSession(state);
		const path = location.pathname;
		// Setup itself, settings and organization management must always be
		// reachable; a redirect loop would make them impossible to use.
		if (
			path === "/onboarding" ||
			path.startsWith("/settings") ||
			path.startsWith("/organizations")
		) {
			return session;
		}
		const setup = await context.queryClient.ensureQueryData(
			setupStateOptions(),
		);
		// Only an empty workspace is sent through onboarding. An existing
		// repository, relay, connection or task means the caller already has a
		// workspace and must never be forced back into setup.
		if (setup.ok && shouldStartOnboarding(setup.value)) {
			throw redirect({ to: "/onboarding" });
		}
		return session;
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
