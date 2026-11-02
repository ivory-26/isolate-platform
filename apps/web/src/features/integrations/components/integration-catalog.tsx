import { Link } from "@tanstack/react-router";
import { StatusMark } from "@/components/console/status-mark";
import { ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	groupIntegrationCatalog,
	INTEGRATION_CATALOG,
	type IntegrationCatalogEntry,
} from "../catalog";
import type { IntegrationSummary } from "../contracts";
import { CapabilityBadges } from "./capability-badges";

/**
 * The catalog groups the ten connectors by the job they do. Each row states the
 * three capabilities separately and names the vendor's free tier; a connected
 * row links to its detail instead of offering a second connect action.
 */
export function IntegrationCatalogPanel({
	integrations,
}: {
	integrations: readonly IntegrationSummary[];
}) {
	const byId = new Map(
		integrations.map((summary) => [summary.connectorId, summary]),
	);
	const groups = groupIntegrationCatalog(INTEGRATION_CATALOG);

	return (
		<div className="space-y-8">
			{groups.map((group) => (
				<section
					key={group.category}
					aria-labelledby={`catalog-${group.category.replaceAll(/[^a-z]+/g, "-")}`}
					className="space-y-2"
				>
					<div className="flex items-baseline justify-between gap-3">
						<h2
							id={`catalog-${group.category.replaceAll(/[^a-z]+/g, "-")}`}
							className="text-xs font-medium tracking-tight text-ink"
						>
							{group.category}
						</h2>
						<span className="font-mono text-[10px] text-ink-muted tabular-nums">
							{group.entries.length}
						</span>
					</div>
					<ul className="divide-y divide-line-subtle border-y border-line-subtle">
						{group.entries.map((entry) => (
							<CatalogRow
								key={entry.id}
								entry={entry}
								summary={byId.get(entry.id)}
							/>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

function CatalogRow({
	entry,
	summary,
}: {
	entry: IntegrationCatalogEntry;
	summary: IntegrationSummary | undefined;
}) {
	const connection = summary?.connection ?? null;
	return (
		<li className="flex flex-col gap-3 py-4 md:flex-row md:items-start md:justify-between">
			<div className="min-w-0 space-y-1.5">
				<div className="flex flex-wrap items-center gap-2">
					<Link
						to="/integrations/$connectorId"
						params={{ connectorId: entry.id }}
						search={{ tab: "catalog" }}
						className="text-sm font-medium text-ink transition-colors hover:text-brand focus-visible:text-brand focus-visible:outline-none"
					>
						{entry.label}
					</Link>
					{connection ? (
						<StatusMark status={connection.status} />
					) : (
						<span className="text-[11px] text-ink-muted">Not connected</span>
					)}
					{summary !== undefined && summary.triggerCount > 0 ? (
						<span className="text-[11px] text-ink-muted">
							{summary.triggerCount} trigger
							{summary.triggerCount === 1 ? "" : "s"}
						</span>
					) : null}
				</div>
				<p className="max-w-[80ch] text-xs leading-5 text-ink-secondary">
					{entry.description}
				</p>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<CapabilityBadges capabilities={entry.capabilities} />
					<span className="text-[11px] leading-5 text-ink-muted">
						{entry.freeTier}
					</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button asChild size="sm" variant="outline">
					<Link
						to="/integrations/$connectorId"
						params={{ connectorId: entry.id }}
						search={{ tab: "catalog" }}
					>
						{connection ? "Open" : "Connect"}
						<ArrowRightIcon />
					</Link>
				</Button>
			</div>
		</li>
	);
}
