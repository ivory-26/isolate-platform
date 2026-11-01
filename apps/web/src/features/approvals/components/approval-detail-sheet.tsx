import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { KeyValue } from "@/components/common/key-value";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { TriangleAlertIcon } from "@/components/icons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ApprovalItem } from "../contracts";
import { approvalActionLabel } from "../contracts";
import { ApprovalRiskBadge } from "./risk-badge";

type Decision = "approved" | "rejected";

/**
 * Trust-critical detail view. Approve and Reject are separate actions, and a
 * high-impact decision is confirmed in an alert dialog that states the
 * consequence before anything is submitted.
 */
export function ApprovalDetailSheet({
	item,
	open,
	onOpenChange,
	canDecide,
	pending,
	error,
	onDecide,
}: {
	item: ApprovalItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canDecide: boolean;
	pending: boolean;
	error: string | null;
	onDecide: (decision: Decision) => void;
}) {
	const [confirm, setConfirm] = useState<Decision | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (!next) setConfirm(null);
		onOpenChange(next);
	};

	const requestDecision = (decision: Decision) => {
		if (item === null) return;
		if (item.risk.requiresConfirmation) setConfirm(decision);
		else onDecide(decision);
	};

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
				{item ? (
					<>
						<SheetHeader className="gap-2 border-b border-line-subtle pr-12">
							<div className="flex flex-wrap items-center gap-2">
								<ApprovalRiskBadge risk={item.risk} />
								<StatusBadge status={item.status} />
							</div>
							<SheetTitle className="text-lg">{item.actionLabel}</SheetTitle>
							<SheetDescription>{item.target.summary}</SheetDescription>
						</SheetHeader>

						<div className="flex-1 space-y-5 overflow-y-auto p-4">
							<div
								role="note"
								className={cn(
									"rounded-md border px-3 py-2.5",
									item.risk.level === "high"
										? "border-orange/30 bg-orange/5"
										: "border-line-subtle bg-elevated",
								)}
							>
								<p className="flex items-center gap-1.5 text-xs font-medium text-ink">
									<TriangleAlertIcon
										size={13}
										className={
											item.risk.level === "high"
												? "text-orange"
												: "text-ink-muted"
										}
									/>
									Impact: {item.risk.label}
								</p>
								<p className="mt-1 text-xs leading-5 text-ink-secondary">
									{item.risk.consequence}
								</p>
							</div>

							<KeyValue
								columns={1}
								items={[
									{
										label: "Task",
										value: (
											<span className="flex flex-wrap items-center gap-2">
												<Link
													to="/runs/$taskId"
													params={{ taskId: item.taskId }}
													className="font-mono text-[13px] text-brand hover:underline"
												>
													{shortId(item.taskId, 12)}
												</Link>
												<StatusBadge status={item.taskStatus} />
											</span>
										),
									},
									{
										label: "Repository",
										value: item.target.repositoryName,
										mono: true,
									},
									{
										label: "Task branch",
										value: item.target.branch,
										mono: true,
									},
									...(item.target.baseBranch
										? [
												{
													label: "Proposed change",
													value: `${item.target.headBranch} → ${item.target.baseBranch}`,
													mono: true,
												},
											]
										: []),
									...(item.target.headSha
										? [
												{
													label: "Commit",
													value: shortId(item.target.headSha, 12),
													mono: true,
												},
											]
										: []),
									{ label: "Requested by", value: item.requestedBy },
									{
										label: "Created",
										value: (
											<span className="flex flex-col gap-0.5">
												<RelativeTime value={item.createdAt} />
												<span className="text-[11px] text-ink-muted">
													{formatDateTime(item.createdAt)}
												</span>
											</span>
										),
									},
									{
										label: "Expires",
										value: (
											<span className="flex flex-col gap-0.5">
												<RelativeTime value={item.expiresAt} />
												<span className="text-[11px] text-ink-muted">
													{formatDateTime(item.expiresAt)}
												</span>
											</span>
										),
									},
									...(item.decidedAt
										? [
												{
													label: "Decided",
													value: (
														<span className="flex flex-col gap-0.5">
															<span>
																{item.decidedBy ?? "Unknown"}{" "}
																{item.rawStatus === "approved"
																	? "approved"
																	: item.rawStatus === "rejected"
																		? "rejected"
																		: item.rawStatus}
															</span>
															<span className="text-[11px] text-ink-muted">
																{formatDateTime(item.decidedAt)}
															</span>
														</span>
													),
												},
											]
										: []),
								]}
							/>

							<div className="space-y-1">
								<p className="text-xs text-ink-muted">
									Payload SHA-256 (the decision authorizes this exact payload)
								</p>
								<div className="flex items-center justify-between gap-2 rounded-md border border-line-subtle bg-canvas px-3 py-2">
									<code className="truncate font-mono text-[11px] text-ink-secondary">
										{item.payloadSha256}
									</code>
									<CopyButton
										value={item.payloadSha256}
										label="Copy payload hash"
									/>
								</div>
							</div>

							{error ? (
								<p
									role="alert"
									className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger"
								>
									{error}
								</p>
							) : null}
						</div>

						<SheetFooter className="border-t border-line-subtle">
							{!canDecide ? (
								<p className="text-xs leading-5 text-ink-muted">
									Your role can review this approval but cannot decide it. Ask
									an owner, admin or member.
								</p>
							) : item.status === "pending" ? (
								<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
									<Button
										type="button"
										variant="outline"
										disabled={pending}
										onClick={() => requestDecision("rejected")}
									>
										Reject
									</Button>
									<Button
										type="button"
										disabled={pending}
										onClick={() => requestDecision("approved")}
									>
										{pending
											? "Submitting…"
											: `Approve ${item.actionLabel.toLowerCase()}`}
									</Button>
								</div>
							) : (
								<div className="space-y-2">
									<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
										<Button type="button" variant="outline" disabled>
											Reject
										</Button>
										<Button type="button" disabled>
											Approve
										</Button>
									</div>
									<p className="text-xs leading-5 text-ink-muted">
										{item.status === "expired"
											? "This approval expired before a decision and can no longer change the task."
											: `This approval was ${item.rawStatus}${item.decidedBy ? ` by ${item.decidedBy}` : ""}. It can no longer change the task.`}
									</p>
								</div>
							)}
						</SheetFooter>
					</>
				) : null}
			</SheetContent>

			<AlertDialog
				open={confirm !== null}
				onOpenChange={(next) => {
					if (!next) setConfirm(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogMedia className="bg-orange/10 text-orange">
							<TriangleAlertIcon />
						</AlertDialogMedia>
						<AlertDialogTitle>
							{item && confirm === "approved"
								? `Approve ${approvalActionLabel(item.action).toLowerCase()}?`
								: item
									? `Reject ${approvalActionLabel(item.action).toLowerCase()}?`
									: "Confirm decision"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{item
								? confirm === "approved"
									? item.risk.consequence
									: "Rejecting stops this action and the task will not continue past this gate."
								: null}
							{item ? (
								<span className="mt-2 block text-xs text-ink-secondary">
									Target: {item.target.summary}
								</span>
							) : null}
							{item ? (
								<span className="mt-1 block font-mono text-[11px] text-ink-muted">
									Payload {shortId(item.payloadSha256, 16)}
								</span>
							) : null}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant={confirm === "rejected" ? "outline" : "default"}
							disabled={pending}
							onClick={() => {
								if (confirm !== null) onDecide(confirm);
								setConfirm(null);
							}}
						>
							{confirm === "rejected"
								? "Reject approval"
								: "Approve and continue"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Sheet>
	);
}
