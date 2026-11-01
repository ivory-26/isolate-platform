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
			variant="plain"
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
				<div className="py-8">
					<EmptyState
						icon={LogsIcon}
						title="No run events yet"
						description="Task lifecycle, agent turns and approvals write durable events here."
					/>
				</div>
			) : (
				<ol className="divide-y divide-line-subtle/70">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 hover:bg-elevated/40"
						>
							<div className="flex min-w-0 items-center gap-2.5">
								<span className="size-1 shrink-0 rounded-full bg-line-strong" />
								<span className="truncate text-[12px] text-ink-secondary">
									{item.typeLabel}
								</span>
								<span className="font-mono text-[10px] text-ink-muted">
									{item.actor}
								</span>
							</div>
							<div className="flex min-w-0 items-center gap-3 text-[10px] text-ink-muted">
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
