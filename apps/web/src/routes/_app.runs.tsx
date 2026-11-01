import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { Metric, MetricStrip } from "@/components/common/metric";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { RetryIcon, RunsIcon, SubmitIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";
import { RunsFilterBar } from "@/features/runs/components/runs-filter-bar";
import {
	parseRunsSearch,
	RUN_MAX_RETRY_DEPTH,
	RUNS_SEARCH_DEFAULTS,
	type RunsSearch,
} from "@/features/runs/contracts";
import { runsListOptions } from "@/features/runs/queries";
import { shortId } from "@/lib/format";

export const Route = createFileRoute("/_app/runs")({
	// The Partial return type keeps `/runs/$taskId` links valid without
	// repeating the filter state; the loader and page normalise with defaults.
	validateSearch: (search): Partial<RunsSearch> =>
		parseRunsSearch(search as Record<string, unknown>),
	loaderDeps: ({ search }) => parseRunsSearch(search),
	loader: async ({ context, deps }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		requireSession(state);
		return context.queryClient.ensureQueryData(runsListOptions(deps));
	},
	component: RunsPage,
	pendingComponent: RunsListPending,
	errorComponent: RunsListError,
});

const EMPTY_SUMMARY = {
	total: 0,
	active: 0,
	awaitingApproval: 0,
	failed: 0,
	reviewReady: 0,
};

const SKELETON_SLOTS = ["metric-a", "metric-b", "metric-c", "metric-d"];

function isFiltered(search: RunsSearch): boolean {
	return (
		search.status !== RUNS_SEARCH_DEFAULTS.status ||
		search.repo !== RUNS_SEARCH_DEFAULTS.repo ||
		search.q !== RUNS_SEARCH_DEFAULTS.q ||
		search.sort !== RUNS_SEARCH_DEFAULTS.sort
	);
}

function RunsListPending() {
	return (
		<PageContainer>
			<div className="h-9 w-40 animate-pulse rounded-md bg-elevated" />
			<div className="grid gap-px overflow-hidden rounded-lg border border-line-subtle bg-line-subtle sm:grid-cols-2 lg:grid-cols-4">
				{SKELETON_SLOTS.map((slot) => (
					<div key={slot} className="h-[92px] bg-surface/60" />
				))}
			</div>
			<div className="h-[52px] animate-pulse rounded-lg border border-line-subtle bg-surface/40" />
			<div className="h-[320px] animate-pulse rounded-lg border border-line-subtle bg-surface/40" />
		</PageContainer>
	);
}

function RunsListError({ reset }: { reset: () => void }) {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Runs"
				description="Execution history for the active organization."
			/>
			<ErrorState
				title="Runs could not be loaded"
				message="The runs list is unavailable right now. Retry to read it again; no execution state has changed."
				onRetry={reset}
			/>
		</PageContainer>
	);
}

function RunsPage() {
	const search = parseRunsSearch(Route.useSearch());
	const navigate = Route.useNavigate();
	const query = useSuspenseQuery(runsListOptions(search));
	const data = query.data.ok ? query.data.value : null;
	const summary = data?.summary ?? EMPTY_SUMMARY;
	const filtered = isFiltered(search);

	const updateSearch = (patch: Partial<RunsSearch>) => {
		void navigate({
			search: (previous) => ({ ...previous, ...patch }),
			resetScroll: false,
		});
	};
	const resetSearch = () => {
		void navigate({ search: RUNS_SEARCH_DEFAULTS, resetScroll: false });
	};

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Runs"
				description="Every task in the active organization with its latest workflow run. Filter, sort and open a run to inspect its timeline, tool decisions, usage and approvals."
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
			/>

			{data ? (
				<MetricStrip>
					<Metric
						label="Active"
						value={summary.active}
						hint="Not in a terminal state"
					/>
					<Metric
						label="Awaiting approval"
						value={summary.awaitingApproval}
						tone={summary.awaitingApproval > 0 ? "orange" : "default"}
						hint="Needs a human decision"
					/>
					<Metric
						label="Failed"
						value={summary.failed}
						tone={summary.failed > 0 ? "danger" : "default"}
						hint="Retry when depth allows"
					/>
					<Metric
						label="Review ready"
						value={summary.reviewReady}
						tone="success"
						hint="Diff, PR or completion"
					/>
				</MetricStrip>
			) : null}

			<RunsFilterBar
				repositories={data?.repositories ?? []}
				search={search}
				onSearchChange={updateSearch}
				onReset={resetSearch}
				disabled={query.isFetching}
			/>

			{query.isRefetchError ? (
				<output className="block rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
					Refresh failed. The rows below may be stale; retry before acting on
					them.
				</output>
			) : null}

			{!query.data.ok ? (
				<ErrorState
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			) : !data || data.rows.length === 0 ? (
				summary.total === 0 && !filtered ? (
					<EmptyState
						icon={RunsIcon}
						title="No tasks yet"
						description="Submit a bounded task to create the first run. Workers execute it in an isolated sandbox."
						action={
							<Button asChild size="sm">
								<Link to="/submit">
									<SubmitIcon />
									Submit a task
								</Link>
							</Button>
						}
					/>
				) : (
					<EmptyState
						icon={RunsIcon}
						title="No runs match these filters"
						description="Adjust the status, repository or search text, or clear the filters to see every task in this organization."
						action={
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={resetSearch}
							>
								Clear filters
							</Button>
						}
					/>
				)
			) : (
				<div className="overflow-x-auto rounded-lg border border-line-subtle">
					<Table>
						<caption className="sr-only">
							Tasks in the active organization, newest first
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead className="w-[260px] pl-4">Task</TableHead>
								<TableHead>Branch</TableHead>
								<TableHead className="w-[180px]">Status</TableHead>
								<TableHead className="w-[180px]">Latest run</TableHead>
								<TableHead className="w-[110px]">Retry depth</TableHead>
								<TableHead className="w-[160px]">Created</TableHead>
								<TableHead className="w-[160px] pr-4">Updated</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.rows.map((row) => (
								<TableRow key={row.taskId} className="border-line-subtle">
									<TableCell className="max-w-[320px] pl-2">
										<Link
											to="/runs/$taskId"
											params={{ taskId: row.taskId }}
											aria-label={`Open run ${row.taskId}`}
											className="group inline-flex max-w-full flex-col rounded-sm px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
										>
											<span className="font-mono text-xs text-brand transition-colors group-hover:text-info">
												{shortId(row.taskId, 12)}
											</span>
											<span className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
												{row.repository.fullName}
											</span>
										</Link>
									</TableCell>
									<TableCell className="max-w-[220px] truncate font-mono text-xs text-ink-secondary">
										{row.branch}
									</TableCell>
									<TableCell>
										<StatusBadge status={row.status} />
									</TableCell>
									<TableCell>
										{row.latestRun ? (
											<div className="space-y-1">
												<StatusBadge status={row.latestRun.status} />
												<p className="text-[11px] text-ink-muted">
													<RelativeTime value={row.latestRun.startedAt} />
												</p>
											</div>
										) : (
											<span className="text-xs text-ink-muted">
												Not started
											</span>
										)}
									</TableCell>
									<TableCell className="font-mono text-xs tabular-nums">
										<span
											className={
												row.retryDepth > 0 ? "text-orange" : "text-ink-muted"
											}
										>
											{row.retryDepth} / {RUN_MAX_RETRY_DEPTH}
										</span>
									</TableCell>
									<TableCell className="text-xs text-ink-secondary">
										<RelativeTime value={row.createdAt} />
									</TableCell>
									<TableCell className="pr-4 text-xs text-ink-muted">
										<RelativeTime value={row.updatedAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</PageContainer>
	);
}
