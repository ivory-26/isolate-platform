import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSession } from "@/components/auth/SessionProvider";
import { ErrorState } from "@/components/common/error-state";
import { Metric, MetricStrip } from "@/components/common/metric";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RelativeTime } from "@/components/common/relative-time";
import { RetryIcon, SubmitIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SetupChecklist } from "@/features/onboarding/components/setup-checklist";
import { RunningNowSection } from "@/features/overview/components/active-runs";
import { HomeInboxPreview } from "@/features/overview/components/home-inbox-preview";
import { NeedsYouSection } from "@/features/overview/components/needs-you";
import { OrganizationContextLine } from "@/features/overview/components/org-context";
import { OverviewSkeleton } from "@/features/overview/components/overview-skeleton";
import { HomeSourcesSection } from "@/features/overview/components/sources";
import {
	type HomeSnapshot,
	homePrimaryAction,
	showsSetupBanner,
} from "@/features/overview/contracts";
import { overviewOptions } from "@/features/overview/queries";

/**
 * Home is event-first: what needs a person, what is running, the newest
 * deliveries and where events come from. Manual delegation is a secondary
 * action; connected sources are the primary way work starts.
 */
export const Route = createFileRoute("/_app/overview")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(overviewOptions()),
	component: OverviewPage,
	pendingComponent: OverviewSkeleton,
});

function OverviewPage() {
	const query = useSuspenseQuery(overviewOptions());
	const session = useSession();
	const result = query.data;
	const snapshot = result.ok ? result.value : null;

	return (
		<PageContainer>
			{snapshot === null ? (
				<>
					<PageHeader
						title="Home"
						description="What needs you, what is running, and where events come from."
					/>
					<ErrorState
						title="Home unavailable"
						message={
							result.ok ? "Home could not be loaded." : result.error.message
						}
						onRetry={() => void query.refetch()}
					/>
				</>
			) : (
				<HomeContent
					snapshot={snapshot}
					session={session}
					isFetching={query.isFetching}
					isRefetchError={query.isRefetchError}
					onRefresh={() => void query.refetch()}
				/>
			)}
		</PageContainer>
	);
}

function HomeContent({
	snapshot,
	session,
	isFetching,
	isRefetchError,
	onRefresh,
}: {
	snapshot: HomeSnapshot;
	session: ReturnType<typeof useSession>;
	isFetching: boolean;
	isRefetchError: boolean;
	onRefresh: () => void;
}) {
	const primary = homePrimaryAction({
		pendingApprovals: snapshot.pendingApprovals.length,
		retryableFailures: snapshot.retryableFailures.length,
	});
	const { metrics } = snapshot;

	return (
		<>
			<PageHeader
				title="Home"
				description="Connected sources create tasks on their own. This page shows what needs a person, what is running, and what just arrived."
				actions={
					<>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isFetching}
							onClick={onRefresh}
						>
							<RetryIcon />
							{isFetching ? "Refreshing…" : "Refresh"}
						</Button>
						<Button asChild variant="ghost" size="sm">
							<Link to="/submit">
								<SubmitIcon />
								Delegate task
							</Link>
						</Button>
						<Button asChild size="sm">
							{primary === "approvals" ? (
								<Link to="/approvals">Review approvals</Link>
							) : (
								<Link to="/inbox">Open inbox</Link>
							)}
						</Button>
					</>
				}
			>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
					<OrganizationContextLine session={session} />
					<span className="text-xs text-ink-muted">
						Snapshot <RelativeTime value={snapshot.generatedAt} />
					</span>
				</div>
			</PageHeader>

			{isRefetchError ? (
				<output className="block border-l-2 border-warning/60 py-2 pl-3 text-xs text-warning">
					Refresh failed. The data below may be stale.
				</output>
			) : null}

			{showsSetupBanner(snapshot.setup) ? (
				<SetupChecklist
					state={snapshot.setup}
					title="Finish setup"
					description="Home fills in as soon as GitHub, a relay, one source and a default trigger exist."
				/>
			) : null}

			<MetricStrip variant="bare">
				<Metric
					label="Needs you"
					value={metrics.needsYou}
					tone={metrics.needsYou > 0 ? "orange" : "default"}
					hint="Approvals plus retryable failures"
				/>
				<Metric
					label="Running now"
					value={metrics.running}
					tone={metrics.running > 0 ? "brand" : "default"}
					hint="Held by a worker"
				/>
				<Metric
					label="Events"
					value={metrics.events24h}
					hint={`Deliveries in the last ${metrics.windowHours}h`}
				/>
				<Metric
					label="Autonomous tasks"
					value={metrics.autonomousTasks24h}
					hint={`Created by sources in the last ${metrics.windowHours}h`}
				/>
			</MetricStrip>

			<NeedsYouSection
				approvals={snapshot.pendingApprovals}
				failures={snapshot.retryableFailures}
			/>

			<RunningNowSection runs={snapshot.activeRuns} />

			<HomeInboxPreview items={snapshot.inbox} />

			<HomeSourcesSection sources={snapshot.sources} />
		</>
	);
}
