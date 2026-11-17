import { useSuspenseQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Outlet,
	useNavigate,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { ConnectorsIcon, RetryIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectedIntegrationsPanel } from "@/features/integrations/components/connected-integrations";
import { IntegrationCatalogPanel } from "@/features/integrations/components/integration-catalog";
import { RelaysPanel } from "@/features/integrations/components/relays-panel";
import {
	type IntegrationTab,
	parseIntegrationsSearch,
} from "@/features/integrations/contracts";
import { integrationsOptions } from "@/features/integrations/queries";

export const Route = createFileRoute("/_app/integrations")({
	validateSearch: (search: Record<string, unknown>) =>
		parseIntegrationsSearch(search),
	loader: async ({ context }) => {
		await context.queryClient.ensureQueryData(integrationsOptions());
	},
	component: IntegrationsPage,
	pendingComponent: IntegrationsSkeleton,
	errorComponent: IntegrationsError,
});

function IntegrationsSkeleton() {
	return (
		<PageContainer>
			<div className="h-8 w-48 rounded bg-elevated/60" />
			<Skeleton className="h-9 w-full" />
			<Skeleton className="h-64 w-full" />
		</PageContainer>
	);
}

function IntegrationsError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader
				title="Integrations"
				description="Catalog, connected sources and relays for the active organization."
			/>
			<ErrorState
				message="Integrations could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function IntegrationsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const isDetailRoute = useRouterState({
		select: (state) => state.location.pathname !== "/integrations",
	});
	const query = useSuspenseQuery(integrationsOptions());
	const data = query.data.ok ? query.data.value : null;
	const integrations = data?.integrations ?? [];
	const connectedCount = integrations.filter(
		(summary) => summary.connection !== null,
	).length;

	const setTab = (tab: IntegrationTab) => {
		void navigate({ to: "/integrations", search: { tab }, replace: true });
	};

	if (isDetailRoute) {
		return <Outlet />;
	}

	return (
		<PageContainer>
			<PageHeader
				title="Integrations"
				description="One catalog, three separate capabilities. Events can start a task; context tools read evidence; actions stay approval-gated. Provider secrets live on your relay."
				actions={
					<>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							<RetryIcon />
							{query.isFetching ? "Refreshing…" : "Refresh"}
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() =>
								setTab(search.tab === "catalog" ? "connected" : "catalog")
							}
						>
							<ConnectorsIcon />
							{search.tab === "catalog"
								? "Connected sources"
								: "Browse catalog"}
						</Button>
					</>
				}
			/>

			{!query.data.ok ? (
				<ErrorState
					title="Integrations unavailable"
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			) : (
				<Tabs
					value={search.tab}
					onValueChange={(value) => setTab(value as IntegrationTab)}
				>
					<TabsList
						variant="line"
						aria-label="Integration sections"
						className="w-full justify-start gap-6 border-b border-line-subtle p-0"
					>
						<TabsTrigger
							value="catalog"
							className="flex-none px-0 pb-2 after:bottom-[-1px] after:bg-brand"
						>
							Catalog
							<span className="font-mono text-[11px] text-ink-muted tabular-nums">
								{integrations.length}
							</span>
						</TabsTrigger>
						<TabsTrigger
							value="connected"
							className="flex-none px-0 pb-2 after:bottom-[-1px] after:bg-brand"
						>
							Connected
							<span className="font-mono text-[11px] text-ink-muted tabular-nums">
								{connectedCount}
							</span>
						</TabsTrigger>
						<TabsTrigger
							value="relays"
							className="flex-none px-0 pb-2 after:bottom-[-1px] after:bg-brand"
						>
							Relays
						</TabsTrigger>
					</TabsList>

					<TabsContent value="catalog" className="mt-4">
						<IntegrationCatalogPanel integrations={integrations} />
					</TabsContent>
					<TabsContent value="connected" className="mt-4">
						<ConnectedIntegrationsPanel
							integrations={integrations}
							canManage={data?.canManage ?? false}
							onChanged={() => void query.refetch()}
						/>
					</TabsContent>
					<TabsContent value="relays" className="mt-4">
						<RelaysPanel canManage={data?.canManage ?? false} />
					</TabsContent>
				</Tabs>
			)}
		</PageContainer>
	);
}
