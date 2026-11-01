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
import { latestTasksOptions } from "@/features/tasks/queries";
import { shortId } from "@/lib/format";

export const Route = createFileRoute("/_app/runs")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		requireSession(state);
		return context.queryClient.ensureQueryData(latestTasksOptions());
	},
	component: RunsPage,
});

function RunsPage() {
	const query = useSuspenseQuery(latestTasksOptions());
	const tasks = query.data.ok ? query.data.value : [];
	const active = tasks.filter(
		(task) =>
			!["completed", "failed", "cancelled", "blocked"].includes(task.status),
	).length;
	const waiting = tasks.filter(
		(task) => task.status === "awaiting_approval",
	).length;
	const failed = tasks.filter((task) => task.status === "failed").length;
	const ready = tasks.filter((task) =>
		["review_ready", "pull_request_created", "completed"].includes(task.status),
	).length;

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Runs"
				description="The latest tasks for the active organization, newest first. A run appears only after a worker creates one."
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

			<MetricStrip>
				<Metric label="Active" value={active} hint="Not in a terminal state" />
				<Metric
					label="Awaiting approval"
					value={waiting}
					tone={waiting > 0 ? "orange" : "default"}
					hint="Needs a human decision"
				/>
				<Metric
					label="Failed"
					value={failed}
					tone={failed > 0 ? "danger" : "default"}
					hint="Latest 25 tasks"
				/>
				<Metric
					label="Review ready"
					value={ready}
					tone="success"
					hint="Diff or PR available"
				/>
			</MetricStrip>

			{query.isRefetchError ? (
				<output className="block rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
					Refresh failed. The rows below may be stale.
				</output>
			) : null}

			{!query.data.ok ? (
				<ErrorState
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			) : tasks.length === 0 ? (
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
				<div className="overflow-x-auto rounded-lg border border-line-subtle">
					<Table>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead className="w-[220px]">Task</TableHead>
								<TableHead>Branch</TableHead>
								<TableHead className="w-[180px]">Status</TableHead>
								<TableHead className="w-[180px]">Latest run</TableHead>
								<TableHead className="w-[170px]">Created</TableHead>
								<TableHead className="w-[140px]">Updated</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{tasks.map((task) => (
								<TableRow key={task.id} className="border-line-subtle">
									<TableCell>
										<Link
											to="/runs/$taskId"
											params={{ taskId: task.id }}
											className="font-mono text-xs text-brand transition-colors hover:text-info"
										>
											{shortId(task.id, 12)}
										</Link>
										<p className="mt-0.5 font-mono text-[11px] text-ink-muted">
											{shortId(task.repositoryId, 12)}
										</p>
									</TableCell>
									<TableCell className="max-w-[220px] truncate font-mono text-xs text-ink-secondary">
										{task.branch}
									</TableCell>
									<TableCell>
										<StatusBadge status={task.status} />
									</TableCell>
									<TableCell>
										{task.latestRun ? (
											<div className="space-y-1">
												<StatusBadge status={task.latestRun.status} />
												<p className="text-[11px] text-ink-muted">
													<RelativeTime value={task.latestRun.startedAt} />
												</p>
											</div>
										) : (
											<span className="text-xs text-ink-muted">
												Not started
											</span>
										)}
									</TableCell>
									<TableCell className="text-xs text-ink-secondary">
										<RelativeTime value={task.createdAt} />
									</TableCell>
									<TableCell className="text-xs text-ink-muted">
										<RelativeTime value={task.updatedAt} />
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
