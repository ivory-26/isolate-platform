import { useState } from "react";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { ConnectorsIcon, KeyIcon } from "@/components/icons";
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
import {
	authKindLabel,
	type ConnectorCredentialView,
	connectorLabel,
	type DeviceView,
	deviceNameFor,
} from "../contracts";
import { ConnectConnectorDialog } from "./connect-connector-dialog";
import { RevokeConnectorDialog } from "./revoke-connector-dialog";

const SKELETON_ROWS = ["one", "two", "three"];

export function ConnectorsPanel({
	credentials,
	isLoading,
	error,
	onRetry,
	devices,
	canManage,
	onChanged,
}: {
	credentials: ConnectorCredentialView[] | undefined;
	isLoading: boolean;
	error: DeviceApiError | null;
	onRetry: () => void;
	devices: readonly DeviceView[];
	canManage: boolean;
	onChanged: () => void;
}) {
	const [connectOpen, setConnectOpen] = useState(false);
	const [revokeTarget, setRevokeTarget] =
		useState<ConnectorCredentialView | null>(null);
	const activeDevices = devices.filter((device) => device.status === "active");
	const canConnect = canManage && activeDevices.length > 0;
	const connectAction = canManage ? (
		<Button
			type="button"
			size="sm"
			disabled={!canConnect}
			onClick={() => setConnectOpen(true)}
		>
			<ConnectorsIcon />
			Connect connector
		</Button>
	) : null;

	return (
		<ConsoleSection
			id="connectors"
			title="Connectors"
			description="Metadata for the ten supported vendors. The credential itself is read from the device keychain at call time."
			action={
				canManage && credentials && credentials.length > 0
					? connectAction
					: null
			}
		>
			<ConsoleNote role="note" icon={KeyIcon} className="mb-3">
				Device-held credentials: the vendor key lives in the operating-system
				keychain on the selected device. Isolate stores an opaque keychain name,
				scopes and metadata, never the key.
			</ConsoleNote>

			{!canManage ? (
				<ConsoleNote role="note" className="mb-3">
					Your role can read connectors but not connect or disconnect them.
					Owners and admins manage connectors.
				</ConsoleNote>
			) : activeDevices.length === 0 ? (
				<ConsoleNote role="note" tone="warning" className="mb-3">
					Register an active device first. A connector needs a device to hold
					its credential.
				</ConsoleNote>
			) : null}

			{isLoading ? (
				<div
					className="divide-y divide-line-subtle border-y border-line-subtle"
					aria-busy="true"
					aria-live="polite"
				>
					<span className="sr-only">Loading connectors</span>
					{SKELETON_ROWS.map((row) => (
						<Skeleton key={row} className="h-12 w-full" />
					))}
				</div>
			) : error ? (
				<ErrorState
					title="Connectors could not be loaded"
					message={error.message}
					onRetry={onRetry}
				/>
			) : credentials === undefined || credentials.length === 0 ? (
				<EmptyRow
					title="No connectors yet"
					description="Connect one of the ten supported vendors to run its read tools from your device."
					action={connectAction}
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Connectors connected in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col" className="min-w-[220px]">
									Connection
								</TableHead>
								<TableHead scope="col" className="w-[120px]">
									Connector
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Device
								</TableHead>
								<TableHead scope="col" className="w-[170px]">
									Auth kind
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Status
								</TableHead>
								<TableHead scope="col" className="w-[130px]">
									Last used
								</TableHead>
								<TableHead scope="col" className="w-[120px] text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{credentials.map((credential) => {
								const revoked = credential.status === "revoked";
								return (
									<TableRow
										key={credential.id}
										className="h-11 border-line-subtle"
									>
										<TableCell className="py-1">
											<span className="text-sm text-ink">
												{credential.displayName}
											</span>
											<p
												className="mt-1 truncate font-mono text-[11px] text-ink-muted"
												title={
													credential.scopes.length > 0
														? `${credential.credentialRef} · ${credential.scopes.join(", ")}`
														: credential.credentialRef
												}
											>
												{credential.credentialRef}
												{credential.scopes.length > 0 ? (
													<span className="font-sans">
														{" "}
														· {credential.scopes.join(", ")}
													</span>
												) : null}
											</p>
										</TableCell>
										<TableCell className="py-1 text-xs text-ink-secondary">
											{connectorLabel(credential.connectorId)}
										</TableCell>
										<TableCell className="py-1 text-xs text-ink-secondary">
											{deviceNameFor(devices, credential.deviceId)}
										</TableCell>
										<TableCell className="py-1 text-xs text-ink-secondary">
											{authKindLabel(credential.authKind)}
										</TableCell>
										<TableCell className="py-1">
											<StatusMark status={credential.status} />
										</TableCell>
										<TableCell className="py-1 text-xs text-ink-secondary">
											{credential.lastUsedAt ? (
												<RelativeTime value={credential.lastUsedAt} />
											) : (
												<span className="text-ink-muted">Never used</span>
											)}
										</TableCell>
										<TableCell className="py-1 text-right">
											{revoked ? (
												<span className="text-xs text-ink-muted">—</span>
											) : canManage ? (
												<Button
													type="button"
													variant="ghost"
													size="xs"
													className="text-danger hover:text-danger"
													onClick={() => setRevokeTarget(credential)}
												>
													Disconnect
													<span className="sr-only">
														{" "}
														{credential.displayName}
													</span>
												</Button>
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

			<ConnectConnectorDialog
				open={connectOpen}
				onOpenChange={setConnectOpen}
				devices={devices}
				onConnected={onChanged}
			/>
			<RevokeConnectorDialog
				credential={revokeTarget}
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRevokeTarget(null);
				}}
				onRevoked={onChanged}
			/>
		</ConsoleSection>
	);
}
