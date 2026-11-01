import { Link } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { ArrowRightIcon, LogsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { shortId } from "@/lib/format";
import type { ActivityItem } from "../contracts";

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
	return (
		<Section
			title="Recent activity"
			description="Newest durable run events across this organization."
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
			{items.length === 0 ? (
				<div className="p-4">
					<EmptyState
						icon={LogsIcon}
						title="No run events yet"
						description="Task lifecycle, agent turns and approvals write durable events here."
					/>
				</div>
			) : (
				<ol className="divide-y divide-line-subtle">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3"
						>
							<div className="flex min-w-0 items-center gap-2">
								<span className="size-1.5 shrink-0 rounded-full bg-line-strong" />
								<span className="truncate text-xs font-medium text-ink-secondary">
									{item.typeLabel}
								</span>
								<span className="font-mono text-[10px] text-ink-muted">
									{item.actor}
								</span>
							</div>
							<div className="flex min-w-0 items-center gap-3 text-[11px] text-ink-muted">
								<Link
									to="/runs/$taskId"
									params={{ taskId: item.taskId }}
									className="font-mono text-brand transition-colors hover:text-info"
								>
									{shortId(item.taskId, 10)}
								</Link>
								<RelativeTime value={item.occurredAt} />
							</div>
						</li>
					))}
				</ol>
			)}
		</Section>
	);
}
