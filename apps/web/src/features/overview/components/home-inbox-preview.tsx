import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { ArrowRightIcon, InboxIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { InboxItem } from "@/features/inbox/contracts";
import { shortId } from "@/lib/format";

/**
 * The newest deliveries as a compact preview. One row per delivery with the
 * source, bounded title, severity, matched status and task link; the full
 * filters, reasons and pagination live on `/inbox`.
 */
export function HomeInboxPreview({ items }: { items: readonly InboxItem[] }) {
	return (
		<ConsoleSection
			id="home-inbox"
			title="Inbox"
			description="Event deliveries from connected sources, newest first."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/inbox">
						Open inbox
						<ArrowRightIcon />
					</Link>
				</Button>
			}
		>
			{items.length === 0 ? (
				<EmptyRow
					title="No event deliveries yet"
					description="Events arrive after a source is connected and a trigger rule is enabled. Only a verified delivery that matches a rule becomes a task; duplicates are recorded as deduplicated."
					action={
						<Button asChild variant="outline" size="sm">
							<Link to="/integrations" search={{ tab: "catalog" }}>
								<InboxIcon size={14} />
								Connect a source
							</Link>
						</Button>
					}
				/>
			) : (
				<ul className="divide-y divide-line-subtle/70 border-y border-line-subtle">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-2.5"
						>
							<span className="w-[86px] shrink-0 text-[11px] text-ink-muted">
								<RelativeTime value={item.receivedAt} />
							</span>
							<span className="w-[92px] shrink-0 truncate text-[11px] text-ink-secondary">
								{item.sourceLabel}
							</span>
							<span className="min-w-0 flex-1 truncate text-[12px] text-ink">
								{item.title || "Untitled signal"}
							</span>
							<span className="w-[104px] shrink-0 text-[11px] text-ink-muted">
								{item.severityLabel}
							</span>
							<span className="w-[110px] shrink-0">
								<StatusBadge status={item.status} label={item.statusLabel} />
							</span>
							<span className="w-[78px] shrink-0 text-right">
								{item.taskId ? (
									<Link
										to="/runs/$taskId"
										params={{ taskId: item.taskId }}
										className="font-mono text-[10px] text-brand transition-colors hover:text-info"
									>
										{shortId(item.taskId, 8)}
									</Link>
								) : (
									<span className="text-[10px] text-ink-muted">—</span>
								)}
							</span>
						</li>
					))}
				</ul>
			)}
		</ConsoleSection>
	);
}
