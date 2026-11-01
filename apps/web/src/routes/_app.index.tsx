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
import {
	ActiveRunsSection,
	PendingApprovalsPreview,
} from "@/features/overview/components/active-runs";
import { ActivityFeed } from "@/features/overview/components/activity-feed";
import { DeviceHealthSection } from "@/features/overview/components/device-health";
import { OrganizationContextLine } from "@/features/overview/components/org-context";
import { OverviewSkeleton } from "@/features/overview/components/overview-skeleton";
import { overviewOptions } from "@/features/overview/queries";

export const Route = createFileRoute("/_app/")({
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
			<PageHeader
				eyebrow="Operate"
				title="Overview"
				description="What is running, what is waiting for a person, and what changed recently in this organization."
				actions={
					<>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							<RetryIcon />
							{query.isFetching ? "Refreshing…" : "Refresh"}
						</Button>
						<Button asChild size="sm">
							<Link to="/submit">
								<SubmitIcon />
								New task
							</Link>
						</Button>
					</>
				}
			>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
					<OrganizationContextLine session={session} />
					{snapshot ? (
						<span className="text-xs text-ink-muted">
							Snapshot <RelativeTime value={snapshot.generatedAt} />
						</span>
					) : null}
				</div>
			</PageHeader>

			{snapshot === null ? (
				<ErrorState
					title="Overview unavailable"
					message={
						result.ok
							? "The overview could not be loaded."
							: result.error.message
					}
					onRetry={() => void query.refetch()}
				/>
			) : (
				<>
					{query.isRefetchError ? (
						<output className="block rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
							Refresh failed. The data below may be stale.
						</output>
					) : null}

					<MetricStrip>
						<Metric
							label="Active tasks"
							value={snapshot.metrics.activeTasks}
							tone={snapshot.metrics.activeTasks > 0 ? "brand" : "default"}
							hint="In flight, not queued"
						/>
						<Metric
							label="Queued"
							value={snapshot.metrics.queuedTasks}
							hint="Waiting for a worker"
						/>
						<Metric
							label="Pending approvals"
							value={snapshot.metrics.pendingApprovals}
							tone={
								snapshot.metrics.pendingApprovals > 0 ? "orange" : "default"
							}
							hint="Needs a human decision"
						/>
						<Metric
							label="Recent failures"
							value={snapshot.metrics.recentFailures}
							tone={snapshot.metrics.recentFailures > 0 ? "danger" : "default"}
							hint={`Failed in the last ${snapshot.metrics.failureWindowHours}h`}
						/>
					</MetricStrip>

					<div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
						<ActiveRunsSection runs={snapshot.activeRuns} />
						<PendingApprovalsPreview approvals={snapshot.pendingApprovals} />
					</div>

					<div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
						<ActivityFeed items={snapshot.activity} />
						<DeviceHealthSection devices={snapshot.devices} />
					</div>
				</>
			)}
		</PageContainer>
	);
}
