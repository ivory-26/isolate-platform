import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { StatusBadge } from "@/components/common/status-badge";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { ExternalIcon } from "@/components/icons";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { deliveryStatusLabel, type EventDelivery } from "../contracts";

/**
 * Recent deliveries for one connector. A row shows the bounded title, matched
 * rule outcome, repository and task; the raw provider body is never stored.
 */
export function DeliveriesPanel({
	deliveries,
	truncated,
}: {
	deliveries: readonly EventDelivery[];
	truncated: boolean;
}) {
	return (
		<ConsoleSection
			id="recent-deliveries"
			title="Recent deliveries"
			description="The last bounded receipts for this source. A duplicate is recorded as deduplicated and creates no second task."
			action={
				truncated ? (
					<span className="text-[11px] text-ink-muted">
						Showing the newest {deliveries.length}
					</span>
				) : null
			}
		>
			{deliveries.length === 0 ? (
				<EmptyRow
					title="No deliveries yet"
					description="When the vendor (or the signed bridge) posts an event, the receipt appears here with its matched rule and task."
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Recent deliveries for this integration
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col" className="w-[150px]">
									Received
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Event
								</TableHead>
								<TableHead scope="col" className="min-w-[240px]">
									Signal
								</TableHead>
								<TableHead scope="col" className="w-[100px]">
									Severity
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Status
								</TableHead>
								<TableHead scope="col" className="min-w-[150px]">
									Repository
								</TableHead>
								<TableHead scope="col" className="w-[120px]">
									Task
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{deliveries.map((delivery) => (
								<TableRow key={delivery.id} className="border-line-subtle">
									<TableCell className="py-2 text-xs text-ink-secondary">
										<RelativeTime value={delivery.receivedAt} />
									</TableCell>
									<TableCell className="py-2">
										<span className="font-mono text-[11px] text-ink">
											{delivery.eventKind}
										</span>
										<p className="text-[10px] text-ink-muted">
											{delivery.source}
										</p>
									</TableCell>
									<TableCell className="max-w-[420px] py-2">
										<p className="truncate text-xs text-ink">
											{delivery.title || "Untitled signal"}
										</p>
										{delivery.links.length > 0 ? (
											<a
												href={delivery.links[0]?.url}
												target="_blank"
												rel="noreferrer"
												className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-brand hover:underline"
											>
												{delivery.links[0]?.label}
												<ExternalIcon size={10} />
											</a>
										) : null}
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{delivery.severity}
									</TableCell>
									<TableCell className="py-2">
										<StatusBadge
											status={delivery.status}
											label={deliveryStatusLabel(delivery.status)}
										/>
										{delivery.reasonCode ? (
											<p className="mt-0.5 font-mono text-[10px] text-ink-muted">
												{delivery.reasonCode}
											</p>
										) : null}
									</TableCell>
									<TableCell className="py-2 text-xs text-ink-secondary">
										{delivery.repositoryName ?? (
											<span className="text-ink-muted">Unmapped</span>
										)}
									</TableCell>
									<TableCell className="py-2 text-xs">
										{delivery.taskId ? (
											<Link
												to="/runs/$taskId"
												params={{ taskId: delivery.taskId }}
												className="text-brand hover:underline"
											>
												Open run
											</Link>
										) : (
											<span className="text-ink-muted">—</span>
										)}
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
