import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import {
	ArrowRightIcon,
	RepositoriesIcon,
	ServerIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { HomeSources } from "../contracts";

function triggerLabel(count: number, enabled: number): string {
	if (count === 0) return "No trigger rule";
	return enabled === 0 ? `${count} disabled` : `${enabled} of ${count} enabled`;
}

/**
 * Source health for Home: GitHub installation presence, every relay-paired
 * connector and the relays themselves. A relay row is stored status, not a
 * live probe; the copy says so instead of claiming green health.
 */
export function HomeSourcesSection({ sources }: { sources: HomeSources }) {
	const { github, connectors, relays } = sources;
	const empty = connectors.length === 0 && relays.length === 0;
	return (
		<ConsoleSection
			id="home-sources"
			title="Sources"
			description="Where events come from. A source is connected after its credential is stored on your relay; Isolate keeps metadata only."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/integrations" search={{ tab: "connected" }}>
						Integrations
						<ArrowRightIcon />
					</Link>
				</Button>
			}
		>
			<ul className="divide-y divide-line-subtle/70 border-y border-line-subtle">
				<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 py-3">
					<div className="flex min-w-0 items-center gap-2.5">
						<RepositoriesIcon size={15} className="shrink-0 text-ink-muted" />
						<div className="min-w-0">
							<p className="text-[13px] text-ink">GitHub</p>
							<p className="text-[11px] text-ink-muted">
								{github.connected
									? `${github.repositoryCount} imported ${
											github.repositoryCount === 1
												? "repository"
												: "repositories"
										}`
									: "App not installed for this organization"}
							</p>
						</div>
					</div>
					<div className="flex items-center gap-3">
						<StatusMark
							status={github.connected ? "connected" : "pending"}
							label={github.connected ? "Connected" : "Not connected"}
						/>
						<Button asChild variant="outline" size="xs">
							<Link to="/repositories" search={{ q: "" }}>
								{github.connected ? "Repositories" : "Connect GitHub"}
							</Link>
						</Button>
					</div>
				</li>

				{connectors.map((source) => (
					<li
						key={source.connectorId}
						className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 py-3"
					>
						<div className="min-w-0">
							<p className="text-[13px] text-ink">{source.label}</p>
							<p className="text-[11px] text-ink-muted">
								{source.relayName ? `${source.relayName} · ` : ""}
								{triggerLabel(source.triggerCount, source.enabledTriggerCount)}
							</p>
							<p className="text-[10px] text-ink-muted">
								{source.lastEventAt ? (
									<>
										Last event <RelativeTime value={source.lastEventAt} />
									</>
								) : (
									"No event received yet"
								)}
								{source.lastVerifiedAt ? (
									<>
										{" · "}verified{" "}
										<RelativeTime value={source.lastVerifiedAt} />
									</>
								) : null}
							</p>
						</div>
						<StatusMark status={source.status} />
					</li>
				))}

				{relays.map((relay) => (
					<li
						key={relay.id}
						className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 py-3"
					>
						<div className="flex min-w-0 items-center gap-2.5">
							<ServerIcon size={15} className="shrink-0 text-ink-muted" />
							<div className="min-w-0">
								<p className="truncate text-[13px] text-ink">
									{relay.displayName}
								</p>
								<p className="text-[10px] text-ink-muted">
									Relay ·{" "}
									{relay.lastSeenAt ? (
										<>
											last seen <RelativeTime value={relay.lastSeenAt} />
										</>
									) : (
										"never seen"
									)}
								</p>
							</div>
						</div>
						<StatusMark status={relay.status} />
					</li>
				))}
			</ul>

			{empty ? (
				<div className="mt-3">
					<EmptyRow
						title="No relay or source connected"
						description="Install a relay, then connect one source from the catalog. Until then only manually delegated tasks can run."
						action={
							<Button asChild variant="outline" size="sm">
								<Link to="/integrations" search={{ tab: "relays" }}>
									Register a relay
								</Link>
							</Button>
						}
					/>
				</div>
			) : null}
		</ConsoleSection>
	);
}
