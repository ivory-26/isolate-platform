import { Link } from "@tanstack/react-router";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import { ArrowRightIcon, DevicesIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { DeviceHealthRow } from "../contracts";

export function DeviceHealthSection({
	devices,
}: {
	devices: DeviceHealthRow[];
}) {
	return (
		<Section
			title="Registered devices"
			description="Rows registered to this organization. A listing is not a live health check."
			action={
				<Button asChild variant="ghost" size="sm">
					<Link to="/devices">
						Devices
						<ArrowRightIcon />
					</Link>
				</Button>
			}
			contentClassName={devices.length === 0 ? "p-5" : "p-0"}
		>
			{devices.length === 0 ? (
				<output className="flex items-start gap-3">
					<span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line-subtle bg-elevated text-ink-muted">
						<DevicesIcon size={18} />
					</span>
					<span className="block space-y-1">
						<span className="block text-sm font-medium text-ink">
							No devices registered
						</span>
						<span className="block text-xs leading-5 text-ink-muted">
							Connector credentials execute on a registered device. Register one
							before connecting incident sources.
						</span>
					</span>
				</output>
			) : (
				<ul className="divide-y divide-line-subtle">
					{devices.map((device) => (
						<li
							key={device.id}
							className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
						>
							<div className="min-w-0">
								<p className="truncate text-sm text-ink">
									{device.displayName}
								</p>
								<p className="text-[11px] text-ink-muted">
									{device.lastSeenAt ? (
										<>
											Last seen <RelativeTime value={device.lastSeenAt} />
										</>
									) : (
										"Never seen"
									)}
								</p>
							</div>
							<StatusBadge status={device.status} />
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}
