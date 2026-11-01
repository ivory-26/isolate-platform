import { useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import {
	CpuIcon,
	RefreshIcon,
	TrashIcon,
	WarningIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { DeviceApiError } from "../api";
import type { DeviceView } from "../contracts";
import { RegisterDeviceDialog } from "./register-device-dialog";
import { RevokeDeviceDialog } from "./revoke-device-dialog";
import { RotateDeviceDialog } from "./rotate-device-dialog";

export function DevicesPanel({
	devices,
	isLoading,
	error,
	onRetry,
	canManage,
	onChanged,
}: {
	devices: DeviceView[] | undefined;
	isLoading: boolean;
	error: DeviceApiError | null;
	onRetry: () => void;
	canManage: boolean;
	onChanged: () => void;
}) {
	const [registerOpen, setRegisterOpen] = useState(false);
	const [rotateTarget, setRotateTarget] = useState<DeviceView | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<DeviceView | null>(null);

	return (
		<Section
			title="Registered devices"
			description="Each device authenticates with its own token. The token is stored only as a hash on the server."
			action={
				canManage ? (
					<Button type="button" size="sm" onClick={() => setRegisterOpen(true)}>
						<CpuIcon />
						Register device
					</Button>
				) : null
			}
		>
			{!canManage ? (
				<div className="mb-4 flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
					<WarningIcon size={14} className="mt-0.5 shrink-0 text-ink-muted" />
					<p className="leading-5">
						Your role can read devices but not register, rotate or revoke them.
						Owners and admins manage devices.
					</p>
				</div>
			) : null}

			{isLoading ? (
				<div className="space-y-2" aria-busy="true" aria-live="polite">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-3/4" />
				</div>
			) : error ? (
				<ErrorState
					title="Devices could not be loaded"
					message={error.message}
					onRetry={onRetry}
				/>
			) : devices === undefined || devices.length === 0 ? (
				<EmptyState
					icon={CpuIcon}
					title="No devices registered"
					description="Register a device to run connector calls from its own keychain. The server never receives a vendor key."
					action={
						canManage ? (
							<Button
								type="button"
								size="sm"
								onClick={() => setRegisterOpen(true)}
							>
								<CpuIcon />
								Register the first device
							</Button>
						) : null
					}
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border border-line-subtle">
					<Table>
						<caption className="sr-only">
							Devices registered in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead>Device</TableHead>
								<TableHead className="w-[140px]">Status</TableHead>
								<TableHead className="w-[180px]">Last seen</TableHead>
								<TableHead className="w-[220px]">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{devices.map((device) => {
								const revoked = device.status === "revoked";
								return (
									<TableRow key={device.id} className="border-line-subtle">
										<TableCell>
											<span className="text-sm font-medium text-ink">
												{device.displayName}
											</span>
											<p className="mt-0.5 font-mono text-[11px] text-ink-muted">
												{device.id.slice(0, 12)}…
											</p>
										</TableCell>
										<TableCell>
											<StatusBadge status={device.status} />
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{device.lastSeenAt ? (
												<RelativeTime value={device.lastSeenAt} />
											) : (
												<span className="text-ink-muted">Never seen</span>
											)}
										</TableCell>
										<TableCell>
											{revoked ? (
												<span className="text-xs text-ink-muted">Revoked</span>
											) : canManage ? (
												<div className="flex items-center gap-2">
													<Button
														type="button"
														variant="outline"
														size="xs"
														onClick={() => setRotateTarget(device)}
													>
														<RefreshIcon />
														Rotate
														<span className="sr-only">
															{" "}
															token for {device.displayName}
														</span>
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="xs"
														className="text-danger hover:text-danger"
														onClick={() => setRevokeTarget(device)}
													>
														<TrashIcon />
														Revoke
														<span className="sr-only">
															{" "}
															{device.displayName}
														</span>
													</Button>
												</div>
											) : (
												<span className="text-xs text-ink-muted">—</span>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			)}

			<RegisterDeviceDialog
				open={registerOpen}
				onOpenChange={setRegisterOpen}
				onRegistered={onChanged}
			/>
			<RotateDeviceDialog
				device={rotateTarget}
				open={rotateTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRotateTarget(null);
				}}
				onRotated={onChanged}
			/>
			<RevokeDeviceDialog
				device={revokeTarget}
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRevokeTarget(null);
				}}
				onRevoked={onChanged}
			/>
		</Section>
	);
}
