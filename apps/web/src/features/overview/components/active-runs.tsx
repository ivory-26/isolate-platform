import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import {
	ApprovalsIcon,
	ArrowRightIcon,
	ShieldCheckIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ApprovalRiskBadge } from "@/features/approvals/components/risk-badge";
import { shortId } from "@/lib/format";
import type { ActiveRunSummary, PendingApprovalPreview } from "../contracts";

export function ActiveRunsSection({ runs }: { runs: ActiveRunSummary[] }) {
	return (
		<Section
			title="Active runs"
			description="Work in flight for this organization, newest update first."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/runs">
						All runs
						<ArrowRightIcon />
					</Link>
				</Button>
			}
			contentClassName="p-0"
		>
			{runs.length === 0 ? (
				<div className="p-4">
					<EmptyState
						icon={ShieldCheckIcon}
						title="No active runs"
						description="Nothing is executing right now. Queued tasks appear here once a worker claims them."
						action={
							<Button asChild size="sm" variant="outline">
								<Link to="/submit">Submit a task</Link>
							</Button>
						}
					/>
				</div>
			) : (
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead className="w-[110px] pl-5">Task</TableHead>
								<TableHead>Repository and branch</TableHead>
								<TableHead className="w-[160px]">Status</TableHead>
								<TableHead className="w-[170px]">Latest stage</TableHead>
								<TableHead className="w-[110px] pr-5">Updated</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => (
								<TableRow key={run.taskId} className="border-line-subtle">
									<TableCell className="pl-5">
										<Link
											to="/runs/$taskId"
											params={{ taskId: run.taskId }}
											className="font-mono text-xs text-brand transition-colors hover:text-info"
										>
											{shortId(run.taskId, 12)}
										</Link>
									</TableCell>
									<TableCell className="max-w-[240px]">
										<p className="truncate text-xs text-ink-secondary">
											{run.repositoryName}
										</p>
										<p className="truncate font-mono text-[11px] text-ink-muted">
											{run.branch}
										</p>
									</TableCell>
									<TableCell>
										<StatusBadge status={run.status} />
									</TableCell>
									<TableCell className="max-w-[170px]">
										<p className="truncate text-xs text-ink-secondary">
											{run.stageLabel}
										</p>
										{run.runStatus ? (
											<p className="text-[11px] text-ink-muted">
												Run {run.runStatus}
											</p>
										) : null}
									</TableCell>
									<TableCell className="pr-5 text-xs text-ink-muted">
										<RelativeTime value={run.latestUpdateAt} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</Section>
	);
}

export function PendingApprovalsPreview({
	approvals,
}: {
	approvals: PendingApprovalPreview[];
}) {
	return (
		<Section
			title="Pending approvals"
			description="Sensitive actions paused for a person."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/approvals">
						Review all
						<ArrowRightIcon />
					</Link>
				</Button>
			}
			contentClassName="p-0"
		>
			{approvals.length === 0 ? (
				<div className="p-4">
					<EmptyState
						icon={ApprovalsIcon}
						title="No approvals waiting"
						description="When a run reaches a sensitive action it pauses here for an explicit decision."
					/>
				</div>
			) : (
				<ul className="divide-y divide-line-subtle">
					{approvals.map((approval) => (
						<li key={approval.approvalId} className="space-y-2 px-5 py-4">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="text-sm font-medium text-ink">
									{approval.actionLabel}
								</span>
								<ApprovalRiskBadge risk={approval.risk} />
							</div>
							<p className="truncate text-xs text-ink-secondary">
								{approval.repositoryName}{" "}
								<span className="font-mono text-[11px] text-ink-muted">
									{approval.branch}
								</span>
							</p>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
								<Link
									to="/runs/$taskId"
									params={{ taskId: approval.taskId }}
									className="font-mono text-brand transition-colors hover:text-info"
								>
									{shortId(approval.taskId, 12)}
								</Link>
								<span>by {approval.requestedBy}</span>
								<span>
									waiting <RelativeTime value={approval.createdAt} />
								</span>
								<span>
									expires <RelativeTime value={approval.expiresAt} />
								</span>
							</div>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}
