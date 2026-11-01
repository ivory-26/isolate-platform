import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import { ApprovalsIcon, ArrowRightIcon } from "@/components/icons";
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
		<Section
			title="Waiting for a decision"
			description={
				items.length === 0
					? "Sensitive actions pause here until a person approves or rejects them."
					: `${items.length} approval${items.length === 1 ? "" : "s"} waiting. Open one to review its exact scope.`
			}
		>
			{items.length === 0 ? (
				<EmptyState
					icon={ApprovalsIcon}
					title="No approvals waiting"
					description="Runs pause at approval gates before pushing a branch or opening a pull request."
				/>
			) : (
				<ul className="grid gap-3 lg:grid-cols-2">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-col gap-3 rounded-md border border-line-subtle bg-elevated/40 p-4"
						>
							<div className="flex flex-wrap items-start justify-between gap-2">
								<div className="min-w-0">
									<p className="text-sm font-medium text-ink">
										{item.actionLabel}
									</p>
									<p className="mt-0.5 truncate text-xs text-ink-secondary">
										{item.target.summary}
									</p>
								</div>
								<div className="flex flex-wrap items-center justify-end gap-2">
									<StatusBadge status={item.status} />
									<ApprovalRiskBadge risk={item.risk} />
								</div>
							</div>
							<dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
								<div className="min-w-0">
									<dt className="text-ink-muted">Task</dt>
									<dd>
										<Link
											to="/runs/$taskId"
											params={{ taskId: item.taskId }}
											className="font-mono text-brand transition-colors hover:text-info"
										>
											{shortId(item.taskId, 12)}
										</Link>
									</dd>
								</div>
								<div className="min-w-0">
									<dt className="text-ink-muted">Requested by</dt>
									<dd className="truncate text-ink-secondary">
										{item.requestedBy}
									</dd>
								</div>
								<div className="min-w-0">
									<dt className="text-ink-muted">Waiting</dt>
									<dd className="text-ink-secondary">
										<RelativeTime value={item.createdAt} />
									</dd>
								</div>
								<div className="min-w-0">
									<dt className="text-ink-muted">Expires</dt>
									<dd className="text-ink-secondary">
										<RelativeTime value={item.expiresAt} />
									</dd>
								</div>
							</dl>
							<div className="mt-auto flex justify-end">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => onReview(item)}
								>
									Review approval
									<ArrowRightIcon />
								</Button>
							</div>
						</li>
					))}
				</ul>
			)}
		</Section>
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
		<Section
			title="Decided and expired"
			description="Recent decisions, plus approvals that expired before anyone decided."
			contentClassName="p-0"
		>
			{items.length === 0 ? (
				<div className="p-4">
					<EmptyState
						icon={ApprovalsIcon}
						title="No decisions yet"
						description="Approved, rejected and expired approvals are kept here with their decision record."
					/>
				</div>
			) : (
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead className="pl-5">Action</TableHead>
								<TableHead>Task</TableHead>
								<TableHead>Target</TableHead>
								<TableHead className="w-[130px]">Status</TableHead>
								<TableHead className="w-[150px]">Closed</TableHead>
								<TableHead className="w-[110px] pr-5">
									<span className="sr-only">Review</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{items.map((item) => (
								<TableRow key={item.id} className="border-line-subtle">
									<TableCell className="pl-5">
										<p className="text-xs font-medium text-ink">
											{item.actionLabel}
										</p>
										<p className="text-[11px] text-ink-muted">
											{item.decidedBy ?? "No decided-by record"}
										</p>
									</TableCell>
									<TableCell>
										<Link
											to="/runs/$taskId"
											params={{ taskId: item.taskId }}
											className="font-mono text-xs text-brand transition-colors hover:text-info"
										>
											{shortId(item.taskId, 12)}
										</Link>
									</TableCell>
									<TableCell className="max-w-[260px]">
										<p className="truncate text-xs text-ink-secondary">
											{item.target.repositoryName}
										</p>
										<p className="truncate font-mono text-[11px] text-ink-muted">
											{item.target.branch}
										</p>
									</TableCell>
									<TableCell>
										<StatusBadge status={item.status} />
									</TableCell>
									<TableCell className="text-xs text-ink-muted">
										<RelativeTime value={item.decidedAt ?? item.expiresAt} />
									</TableCell>
									<TableCell className="pr-5 text-right">
										<Button
											type="button"
											variant="ghost"
											size="sm"
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
		</Section>
	);
}
