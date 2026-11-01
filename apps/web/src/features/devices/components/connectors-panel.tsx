import { useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { Section } from "@/components/common/section";
import { StatusBadge } from "@/components/common/status-badge";
import {
	ConnectorsIcon,
	KeyIcon,
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
import {
	authKindLabel,
	type ConnectorCredentialView,
	connectorLabel,
	type DeviceView,
	deviceNameFor,
} from "../contracts";
import { ConnectConnectorDialog } from "./connect-connector-dialog";
import { RevokeConnectorDialog } from "./revoke-connector-dialog";

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

	return (
		<Section
			title="Connectors"
			description="Metadata for the ten supported vendors. The credential itself is read from the device keychain at call time."
			action={
				canManage ? (
					<Button
						type="button"
						size="sm"
						disabled={!canConnect}
						onClick={() => setConnectOpen(true)}
					>
						<ConnectorsIcon />
						Connect connector
					</Button>
				) : null
			}
		>
			<div className="mb-4 flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
				<KeyIcon size={14} className="mt-0.5 shrink-0 text-brand" />
				<p className="leading-5">
					Device-held credentials: the vendor key lives in the operating-system
					keychain on the selected device. Isolate stores an opaque keychain
					name, scopes and metadata, never the key.
				</p>
			</div>

			{!canManage ? (
				<div className="mb-4 flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
					<WarningIcon size={14} className="mt-0.5 shrink-0 text-ink-muted" />
					<p className="leading-5">
						Your role can read connectors but not connect or disconnect them.
						Owners and admins manage connectors.
					</p>
				</div>
			) : activeDevices.length === 0 ? (
				<div className="mb-4 flex items-start gap-2 rounded-md border border-line-subtle bg-elevated px-3 py-2 text-xs text-ink-secondary">
					<WarningIcon size={14} className="mt-0.5 shrink-0 text-ink-muted" />
					<p className="leading-5">
						Register an active device first. A connector needs a device to hold
						its credential.
					</p>
				</div>
			) : null}

			{isLoading ? (
				<div className="space-y-2" aria-busy="true" aria-live="polite">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : error ? (
				<ErrorState
					title="Connectors could not be loaded"
					message={error.message}
					onRetry={onRetry}
				/>
			) : credentials === undefined || credentials.length === 0 ? (
				<EmptyState
					icon={ConnectorsIcon}
					title="No connectors yet"
					description="Connect one of the ten supported vendors to run its read tools from your device."
					action={
						canManage ? (
							<Button
								type="button"
								size="sm"
								disabled={!canConnect}
								onClick={() => setConnectOpen(true)}
							>
								<ConnectorsIcon />
								Connect the first connector
							</Button>
						) : null
					}
				/>
			) : (
				<div className="overflow-x-auto rounded-lg border border-line-subtle">
					<Table>
						<caption className="sr-only">
							Connectors connected in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead>Connection</TableHead>
								<TableHead className="w-[130px]">Connector</TableHead>
								<TableHead className="w-[150px]">Device</TableHead>
								<TableHead className="w-[180px]">Auth kind</TableHead>
								<TableHead className="w-[150px]">Status</TableHead>
								<TableHead className="w-[150px]">Last used</TableHead>
								<TableHead className="w-[130px]">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{credentials.map((credential) => {
								const revoked = credential.status === "revoked";
								return (
									<TableRow key={credential.id} className="border-line-subtle">
										<TableCell>
											<span className="text-sm font-medium text-ink">
												{credential.displayName}
											</span>
											<p className="mt-0.5 break-all font-mono text-[11px] text-ink-muted">
												{credential.credentialRef}
											</p>
											{credential.scopes.length > 0 ? (
												<p className="mt-0.5 text-[11px] text-ink-muted">
													Scopes: {credential.scopes.join(", ")}
												</p>
											) : null}
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{connectorLabel(credential.connectorId)}
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{deviceNameFor(devices, credential.deviceId)}
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{authKindLabel(credential.authKind)}
										</TableCell>
										<TableCell>
											<StatusBadge status={credential.status} />
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{credential.lastUsedAt ? (
												<RelativeTime value={credential.lastUsedAt} />
											) : (
												<span className="text-ink-muted">Never used</span>
											)}
										</TableCell>
										<TableCell>
											{revoked ? (
												<span className="text-xs text-ink-muted">
													Disconnected
												</span>
											) : canManage ? (
												<Button
													type="button"
													variant="ghost"
													size="xs"
													className="text-danger hover:text-danger"
													onClick={() => setRevokeTarget(credential)}
												>
													<TrashIcon />
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
		</Section>
	);
}
