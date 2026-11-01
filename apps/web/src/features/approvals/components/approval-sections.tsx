import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { shortId } from "@/lib/format";
import type { ApprovalItem } from "../contracts";
import { ApprovalRiskBadge } from "./risk-badge";

export function PendingApprovalsSection({
	items,
	onReview,
}: {
	items: ApprovalItem[];
	onReview: (item: ApprovalItem) => void;
}) {
	return (
		<ConsoleSection
			id="pending-approvals"
			title="Waiting for a decision"
			description={
				items.length === 0
					? "Sensitive actions pause here until a person approves or rejects them."
					: `${items.length} approval${items.length === 1 ? "" : "s"} waiting. Open one to review its exact scope.`
			}
		>
			{items.length === 0 ? (
				<EmptyRow
					title="No approvals waiting"
					description="Runs pause at approval gates before pushing a branch or opening a pull request."
				/>
			) : (
				<ul className="divide-y divide-line-subtle border-y border-line-subtle">
					{items.map((item) => (
						<li
							key={item.id}
							className="grid gap-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
						>
							<div className="min-w-0 space-y-2">
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<p className="text-sm font-medium text-ink">
										{item.actionLabel}
									</p>
									<ApprovalRiskBadge risk={item.risk} />
									<StatusMark status={item.status} />
								</div>
								<p className="truncate text-xs text-ink-secondary">
									{item.target.summary}
								</p>
								<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-muted">
									<Link
										to="/runs/$taskId"
										params={{ taskId: item.taskId }}
										className="font-mono text-brand transition-colors hover:text-info"
									>
										{shortId(item.taskId, 12)}
									</Link>
									<span>by {item.requestedBy}</span>
									<span>
										waiting <RelativeTime value={item.createdAt} />
									</span>
									<span>
										expires <RelativeTime value={item.expiresAt} />
									</span>
								</div>
							</div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="justify-self-start md:justify-self-end"
								onClick={() => onReview(item)}
							>
								Review approval
								<ArrowRightIcon />
							</Button>
						</li>
					))}
				</ul>
			)}
		</ConsoleSection>
	);
}

export function DecidedApprovalsSection({
	items,
	onReview,
}: {
	items: ApprovalItem[];
	onReview: (item: ApprovalItem) => void;
}) {
	return (
		<ConsoleSection
			id="decided-approvals"
			title="Decided and expired"
			description="Recent decisions, plus approvals that expired before anyone decided."
		>
			{items.length === 0 ? (
				<EmptyRow
					title="No decisions yet"
					description="Approved, rejected and expired approvals are kept here with their decision record."
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Decided and expired approvals with their task, target, status and
							decision time.
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col">Action</TableHead>
								<TableHead scope="col">Task</TableHead>
								<TableHead scope="col">Target</TableHead>
								<TableHead scope="col" className="w-[130px]">
									Status
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Closed
								</TableHead>
								<TableHead scope="col" className="w-[100px] text-right">
									<span className="sr-only">Review</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{items.map((item) => (
								<TableRow key={item.id} className="h-11 border-line-subtle">
									<TableCell className="py-1">
										<p className="text-xs font-medium text-ink">
											{item.actionLabel}
										</p>
										<p className="text-[11px] text-ink-muted">
											{item.decidedBy ?? "No decided-by record"}
										</p>
									</TableCell>
									<TableCell className="py-1">
										<Link
											to="/runs/$taskId"
											params={{ taskId: item.taskId }}
											className="font-mono text-xs text-brand transition-colors hover:text-info"
										>
											{shortId(item.taskId, 12)}
										</Link>
									</TableCell>
									<TableCell className="max-w-[260px] py-1">
										<p className="truncate text-xs text-ink-secondary">
											{item.target.repositoryName}
										</p>
										<p className="truncate font-mono text-[11px] text-ink-muted">
											{item.target.branch}
										</p>
									</TableCell>
									<TableCell className="py-1">
										<StatusMark status={item.status} />
									</TableCell>
									<TableCell className="py-1 text-xs text-ink-muted">
										<RelativeTime value={item.decidedAt ?? item.expiresAt} />
									</TableCell>
									<TableCell className="py-1 text-right">
										<Button
											type="button"
											variant="ghost"
											size="xs"
											onClick={() => onReview(item)}
										>
											Review
										</Button>
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
