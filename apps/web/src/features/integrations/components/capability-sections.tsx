import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import type { IntegrationCatalogEntry, IntegrationToolRisk } from "../catalog";

const RISK_LABEL: Record<IntegrationToolRisk, string> = {
	read_only: "Read only",
	scoped_write: "Scoped write",
	sensitive: "Approval required",
};

/**
 * The three capabilities are separate sections, never one "connected" badge.
 * The catalog is static; the connection status above says whether the provider
 * is actually reachable.
 */
export function CapabilitySections({
	entry,
}: {
	entry: IntegrationCatalogEntry;
}) {
	return (
		<div className="grid gap-8 lg:grid-cols-3">
			<ConsoleSection
				id="capability-events"
				title="Event source"
				description={
					entry.capabilities.eventSource
						? "Signed deliveries can start a task through a matching rule."
						: "No native event source. Normalized events arrive through the signed bridge."
				}
			>
				<CapabilityState available={entry.capabilities.eventSource} />
				<ul className="mt-3 space-y-1.5">
					{entry.eventKinds.map((kind) => (
						<li
							key={kind}
							className="flex items-center justify-between gap-3 border-b border-line-subtle py-1.5 text-xs"
						>
							<span className="font-mono text-[11px] text-ink-secondary">
								{kind}
							</span>
							<span className="text-[10px] text-ink-muted">normalized</span>
						</li>
					))}
				</ul>
			</ConsoleSection>

			<ConsoleSection
				id="capability-context"
				title="Context provider"
				description="Read-only evidence the agent may cite during a run. Each call is bounded, redacted and audited."
			>
				<CapabilityState available={entry.capabilities.context} />
				<ul className="mt-3 space-y-2">
					{entry.readTools.map((tool) => (
						<ToolRow
							key={tool.name}
							name={tool.name}
							risk={tool.risk}
							description={tool.description}
						/>
					))}
				</ul>
			</ConsoleSection>

			<ConsoleSection
				id="capability-actions"
				title="Action provider"
				description="External mutations stay separate from reads. Sensitive actions use the exact-payload approval gate; destructive tools are denied by policy."
			>
				<CapabilityState available={entry.capabilities.actions} />
				{entry.actionTools.length === 0 ? (
					<ConsoleNote role="note" className="mt-3">
						No write tools are exposed for this connector.
					</ConsoleNote>
				) : (
					<ul className="mt-3 space-y-2">
						{entry.actionTools.map((tool) => (
							<ToolRow
								key={tool.name}
								name={tool.name}
								risk={tool.risk}
								description={tool.description}
							/>
						))}
					</ul>
				)}
			</ConsoleSection>
		</div>
	);
}

function CapabilityState({ available }: { available: boolean }) {
	return (
		<StatusMark
			status={available ? "active" : "offline"}
			label={available ? "Available" : "Not supported"}
		/>
	);
}

function ToolRow({
	name,
	risk,
	description,
}: {
	name: string;
	risk: IntegrationToolRisk;
	description: string;
}) {
	return (
		<li className="space-y-1 border-b border-line-subtle pb-2">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<code className="font-mono text-[11px] text-ink">{name}</code>
				<span className="text-[10px] text-ink-muted">{RISK_LABEL[risk]}</span>
			</div>
			<p className="text-[11px] leading-4 text-ink-muted">{description}</p>
		</li>
	);
}
