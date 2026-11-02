import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { ArrowRightIcon, PlayIcon } from "@/components/icons";
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
import { inboxSourceLabel } from "@/features/inbox/contracts";
import { shortId } from "@/lib/format";
import type { ActiveRunSummary, PendingApprovalPreview } from "../contracts";

/**
 * "Running now": work a worker is actively holding. Event-created tasks show
 * their source and autonomy level; a manually delegated task shows "Manual".
 */
export function RunningNowSection({ runs }: { runs: ActiveRunSummary[] }) {
	return (
		<ConsoleSection
			id="home-running-now"
			title="Running now"
			description="Tasks a worker is holding right now, newest update first."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/runs">
						All runs
						<ArrowRightIcon />
					</Link>
				</Button>
			}
		>
			{runs.length === 0 ? (
				<EmptyRow
					title="Nothing is running"
					description="A connected source creates a task automatically when its trigger rule matches. Manual work can be delegated from the topbar."
					action={
						<Button asChild variant="outline" size="sm">
							<Link to="/submit">Delegate a task</Link>
						</Button>
					}
				/>
			) : (
				<div className="-mx-5 border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Tasks currently held by a worker, with their source, repository,
							status, latest stage and last update.
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col" className="w-[110px]">
									Task
								</TableHead>
								<TableHead scope="col" className="min-w-[200px]">
									Repository and branch
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Origin
								</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Status
								</TableHead>
								<TableHead scope="col" className="min-w-[170px]">
									Latest stage
								</TableHead>
								<TableHead scope="col" className="w-[90px] text-right">
									Updated
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{runs.map((run) => (
								<TableRow
									key={run.taskId}
									className="border-line-subtle/70 hover:bg-elevated/50"
								>
									<TableCell className="py-3">
										<Link
											to="/runs/$taskId"
											params={{ taskId: run.taskId }}
											className="font-mono text-[11px] text-brand transition-colors hover:text-info"
										>
											{shortId(run.taskId, 12)}
										</Link>
									</TableCell>
									<TableCell className="max-w-[280px] py-3">
										<p className="truncate text-[13px] text-ink">
											{run.repositoryName}
										</p>
										<p className="truncate font-mono text-[10px] text-ink-muted">
											{run.branch}
										</p>
									</TableCell>
									<TableCell className="py-3">
										<p className="truncate text-[12px] text-ink-secondary">
											{run.incidentSource === null
												? "Manual"
												: inboxSourceLabel(run.incidentSource)}
										</p>
										{run.autonomyLevel ? (
											<p className="font-mono text-[10px] text-ink-muted">
												{run.autonomyLevel}
											</p>
										) : null}
									</TableCell>
									<TableCell className="py-3">
										<StatusBadge status={run.status} />
									</TableCell>
									<TableCell className="max-w-[180px] py-3">
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
		</ConsoleSection>
	);
}

/**
 * Approval rows without their own section header: Home lists these first
 * inside "Needs you", the approvals page reuses them with its own framing.
 */
export function ApprovalRows({
	approvals,
}: {
	approvals: readonly PendingApprovalPreview[];
}) {
	return (
		<ul className="divide-y divide-line-subtle/70 border-y border-line-subtle">
			{approvals.map((approval) => (
				<li key={approval.approvalId} className="space-y-1.5 px-1 py-3.5">
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
	);
}

/** A quiet row for the "needs you" empty state; no illustration or card. */
export function QuietEmptyRow({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<output className="flex items-start gap-3 border-y border-line-subtle py-6">
			<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-line-subtle text-ink-muted">
				<PlayIcon size={12} />
			</span>
			<span className="block space-y-1">
				<span className="block text-sm text-ink-secondary">{title}</span>
				<span className="block max-w-xl text-xs leading-5 text-ink-muted">
					{description}
				</span>
			</span>
		</output>
	);
}
