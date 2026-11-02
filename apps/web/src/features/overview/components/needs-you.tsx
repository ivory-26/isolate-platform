import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { ArrowRightIcon, RetryIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { shortId } from "@/lib/format";
import type { PendingApprovalPreview, RetryableFailure } from "../contracts";
import { ApprovalRows, QuietEmptyRow } from "./active-runs";

/**
 * "Needs you": the one place on Home that asks for a human decision.
 * Approvals come first because they block work already in flight; retryable
 * failures follow because they only need a rerun. Both empty renders one quiet
 * row, not an empty card.
 */
export function NeedsYouSection({
	approvals,
	failures,
}: {
	approvals: readonly PendingApprovalPreview[];
	failures: readonly RetryableFailure[];
}) {
	const total = approvals.length + failures.length;
	return (
		<ConsoleSection
			id="home-needs-you"
			title={
				<span className="flex items-baseline gap-2">
					Needs you
					{total > 0 ? (
						<span className="font-mono text-[11px] text-orange tabular-nums">
							{total}
						</span>
					) : null}
				</span>
			}
			description="Decisions and reruns that are waiting on a person. Everything else runs without you."
			action={
				total > 0 ? (
					<Button asChild variant="ghost" size="sm">
						<Link to="/approvals">
							Approvals
							<ArrowRightIcon />
						</Link>
					</Button>
				) : null
			}
		>
			{total === 0 ? (
				<QuietEmptyRow
					title="Nothing needs you"
					description="No approval is waiting and no failed run is inside the retry cap. A source event that matches an enabled trigger becomes a task on its own."
				/>
			) : (
				<div className="space-y-5">
					{approvals.length > 0 ? (
						<div className="space-y-2">
							<p className="text-[11px] font-medium tracking-wide text-ink-muted uppercase">
								Approvals
							</p>
							<ApprovalRows approvals={approvals} />
						</div>
					) : null}
					{failures.length > 0 ? (
						<div className="space-y-2">
							<p className="text-[11px] font-medium tracking-wide text-ink-muted uppercase">
								Retryable failures
							</p>
							<ul className="divide-y divide-line-subtle/70 border-y border-line-subtle">
								{failures.map((failure) => (
									<li
										key={failure.taskId}
										className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 py-3"
									>
										<div className="min-w-0 space-y-1">
											<div className="flex min-w-0 flex-wrap items-center gap-2">
												<Link
													to="/runs/$taskId"
													params={{ taskId: failure.taskId }}
													className="font-mono text-[11px] text-brand transition-colors hover:text-info"
												>
													{shortId(failure.taskId, 12)}
												</Link>
												<StatusMark status={failure.status} />
											</div>
											<p className="truncate text-[12px] text-ink-secondary">
												{failure.repositoryName}{" "}
												<span className="font-mono text-[10px] text-ink-muted">
													{failure.branch}
												</span>
											</p>
										</div>
										<div className="flex items-center gap-3 text-[10px] text-ink-muted">
											<span>
												attempt {failure.retryDepth + 1} of{" "}
												{failure.maxRetryDepth + 1}
											</span>
											<span>
												failed <RelativeTime value={failure.failedAt} />
											</span>
											<Button asChild variant="outline" size="xs">
												<Link
													to="/runs/$taskId"
													params={{ taskId: failure.taskId }}
												>
													<RetryIcon />
													Open run
												</Link>
											</Button>
										</div>
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			)}
		</ConsoleSection>
	);
}
