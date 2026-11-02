import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PageContainer } from "@/components/common/page-container";
import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";

/**
 * Shell-shaped pending state. The sidebar and topbar dimensions match
 * {@link AppShell} (240px aside, 56px bar) so resolving the loader does not
 * move the content; only the main column is a placeholder.
 */
function AppPending() {
	return (
		<div className="min-h-dvh bg-canvas text-ink">
			<div className="flex min-h-dvh">
				<div
					aria-hidden="true"
					className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line-subtle bg-elevated lg:block"
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<div
						aria-hidden="true"
						className="h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 border-b border-line-subtle bg-canvas"
					/>
					<main className="min-w-0 flex-1">
						<PageContainer>
							<output aria-busy="true" className="flex flex-col gap-6">
								<span className="sr-only">Loading workspace</span>
								<div className="space-y-3 border-b border-line-subtle pb-6">
									<div className="h-[26px] w-44 rounded bg-elevated/60" />
									<div className="h-4 w-full max-w-xl rounded bg-elevated/30" />
								</div>
								<div className="grid border-y border-line-subtle sm:grid-cols-2 lg:grid-cols-4">
									{["a", "b", "c", "d"].map((key) => (
										<div key={key} className="flex flex-col gap-1 px-5 py-4">
											<div className="h-3 w-24 rounded bg-elevated/40" />
											<div className="h-7 w-16 rounded bg-elevated/60" />
											<div className="h-3 w-32 rounded bg-elevated/30" />
										</div>
									))}
								</div>
								<div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
									<div className="h-72 rounded bg-elevated/25" />
									<div className="h-72 rounded bg-elevated/25" />
								</div>
							</output>
						</PageContainer>
					</main>
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/_app")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: AppLayout,
	pendingComponent: AppPending,
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
