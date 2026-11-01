import { useState } from "react";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { PlusIcon } from "@/components/icons";
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

const SKELETON_ROWS = ["one", "two", "three"];

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
	const registerAction = canManage ? (
		<Button type="button" size="sm" onClick={() => setRegisterOpen(true)}>
			<PlusIcon />
			Register device
		</Button>
	) : null;

	return (
		<ConsoleSection
			id="registered-devices"
			title="Registered devices"
			description="Each device authenticates with its own token. The token is stored only as a hash on the server."
			action={
				canManage && devices && devices.length > 0 ? registerAction : null
			}
		>
			{!canManage ? (
				<ConsoleNote role="note" className="mb-3">
					Your role can read devices but not register, rotate or revoke them.
					Owners and admins manage devices.
				</ConsoleNote>
			) : null}

			{isLoading ? (
				<div
					className="divide-y divide-line-subtle border-y border-line-subtle"
					aria-busy="true"
					aria-live="polite"
				>
					<span className="sr-only">Loading devices</span>
					{SKELETON_ROWS.map((row) => (
						<Skeleton key={row} className="h-12 w-full" />
					))}
				</div>
			) : error ? (
				<ErrorState
					title="Devices could not be loaded"
					message={error.message}
					onRetry={onRetry}
				/>
			) : devices === undefined || devices.length === 0 ? (
				<EmptyRow
					title="No devices registered"
					description="Register a device to run connector calls from its own keychain. The server never receives a vendor key."
					action={registerAction}
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Devices registered in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col">Device</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Status
								</TableHead>
								<TableHead scope="col" className="w-[180px]">
									Last seen
								</TableHead>
								<TableHead scope="col" className="w-[200px] text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{devices.map((device) => {
								const revoked = device.status === "revoked";
								return (
									<TableRow key={device.id} className="h-12 border-line-subtle">
										<TableCell>
											<span className="text-sm text-ink">
												{device.displayName}
											</span>
											<p className="mt-1 font-mono text-[11px] text-ink-muted">
												{device.id.slice(0, 12)}…
											</p>
										</TableCell>
										<TableCell>
											<StatusMark status={device.status} />
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{device.lastSeenAt ? (
												<RelativeTime value={device.lastSeenAt} />
											) : (
												<span className="text-ink-muted">Never seen</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											{revoked ? (
												<span className="text-xs text-ink-muted">—</span>
											) : canManage ? (
												<div className="flex items-center justify-end gap-2">
													<Button
														type="button"
														variant="outline"
														size="xs"
														onClick={() => setRotateTarget(device)}
													>
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
		</ConsoleSection>
	);
}
