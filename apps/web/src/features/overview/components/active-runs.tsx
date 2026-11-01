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
			variant="plain"
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
				<div className="py-8">
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
								<TableHead className="h-9 w-[112px] pl-0 text-[10px] font-medium">
									Task
								</TableHead>
								<TableHead className="text-[10px] font-medium">
									Repository and branch
								</TableHead>
								<TableHead className="w-[150px] text-[10px] font-medium">
									Status
								</TableHead>
								<TableHead className="w-[170px] text-[10px] font-medium">
									Latest stage
								</TableHead>
								<TableHead className="w-[100px] text-[10px] font-medium [text-align:right]">
									Updated
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => (
								<TableRow
									key={run.taskId}
									className="group border-line-subtle/70 hover:bg-elevated/50"
								>
									<TableCell className="py-3 pl-0">
										<Link
											to="/runs/$taskId"
											params={{ taskId: run.taskId }}
											className="font-mono text-[11px] text-brand transition-colors hover:text-info"
										>
											{shortId(run.taskId, 12)}
										</Link>
									</TableCell>
									<TableCell className="max-w-[260px] py-3">
										<p className="truncate text-[13px] text-ink">
											{run.repositoryName}
										</p>
										<p className="truncate font-mono text-[10px] text-ink-muted">
											{run.branch}
										</p>
									</TableCell>
									<TableCell className="py-3">
										<StatusBadge status={run.status} />
									</TableCell>
									<TableCell className="max-w-[170px] py-3">
										<p className="truncate text-[12px] text-ink-secondary">
											{run.stageLabel}
										</p>
										{run.runStatus ? (
											<p className="text-[10px] text-ink-muted">
												Run {run.runStatus}
											</p>
										) : null}
									</TableCell>
									<TableCell className="py-3 text-right text-[11px] text-ink-muted">
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
			variant="plain"
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
				<div className="py-8">
					<EmptyState
						icon={ApprovalsIcon}
						title="No approvals waiting"
						description="When a run reaches a sensitive action it pauses here for an explicit decision."
					/>
				</div>
			) : (
				<ul className="divide-y divide-line-subtle/70">
					{approvals.map((approval) => (
						<li
							key={approval.approvalId}
							className="space-y-1.5 py-3.5 hover:bg-elevated/40"
						>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="text-[13px] font-medium text-ink">
									{approval.actionLabel}
								</span>
								<ApprovalRiskBadge risk={approval.risk} />
							</div>
							<p className="truncate text-[11px] text-ink-secondary">
								{approval.repositoryName}{" "}
								<span className="font-mono text-[10px] text-ink-muted">
									{approval.branch}
								</span>
							</p>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-muted">
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
