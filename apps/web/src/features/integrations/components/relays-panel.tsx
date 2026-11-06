import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { ErrorState } from "@/components/common/error-state";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { PlusIcon, RetryIcon, TrashIcon } from "@/components/icons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	registerDevice,
	revokeDevice,
	toDeviceApiError,
} from "@/features/devices/api";
import {
	type DeviceView,
	type IssuedDeviceToken,
	RELAY_OFFLINE_AFTER_MS,
	validateDeviceName,
} from "@/features/devices/contracts";
import { deviceKeys, deviceListOptions } from "@/features/devices/queries";
import { buildRelayInstallCommand } from "@/features/onboarding/setup-steps";

/**
 * Relay management: register (token shown once), the one-line install command,
 * heartbeat status, and revoke. A relay that has never been seen is Pending; an
 * active relay with a stale heartbeat is shown as Offline without rewriting the
 * stored status.
 */
export function RelaysPanel({ canManage }: { canManage: boolean }) {
	const queryClient = useQueryClient();
	const [issued, setIssued] = useState<IssuedDeviceToken | null>(null);
	const [issuedName, setIssuedName] = useState("relay");
	const [error, setError] = useState<string | null>(null);
	const [revokeTarget, setRevokeTarget] = useState<DeviceView | null>(null);
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	const devices = useQuery({
		...deviceListOptions(),
		// Keep polling while a relay is active: `last_seen_at` only advances when
		// the relay claims work, so a stopped relay must be able to flip to
		// Offline without a remount.
		refetchInterval: (query) =>
			query.state.data?.some((device) => device.status === "active")
				? 15_000
				: 5_000,
	});
	const register = useMutation({
		mutationFn: (displayName: string) => registerDevice(displayName),
		gcTime: 0,
		onSuccess: (result) => {
			setIssued(result);
			void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});
	const revoke = useMutation({
		mutationFn: (deviceId: string) => revokeDevice(deviceId),
		onSuccess: () => {
			setRevokeTarget(null);
			void queryClient.invalidateQueries({ queryKey: deviceKeys.list });
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});

	function onRegister(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (register.isPending) return;
		setError(null);
		const parsed = validateDeviceName(
			String(new FormData(event.currentTarget).get("displayName") ?? ""),
		);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		setIssuedName(parsed.value);
		register.mutate(parsed.value);
	}

	const rows = devices.data ?? [];
	const command =
		issued === null
			? null
			: buildRelayInstallCommand({
					serverUrl:
						typeof window === "undefined" ? "" : window.location.origin,
					token: issued.token,
					name: issuedName,
				});

	return (
		<ConsoleSection
			id="relays"
			title="Relays"
			description="A relay is the customer-controlled process that holds provider secrets and reaches private networks. It polls Isolate outbound; no inbound port is required."
			action={
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={devices.isFetching}
					onClick={() => void devices.refetch()}
				>
					<RetryIcon />
					{devices.isFetching ? "Refreshing…" : "Refresh"}
				</Button>
			}
		>
			<ConsoleNote role="note">
				Pairing runs on <code className="font-mono">127.0.0.1:47821</code> on
				the relay machine. The token is shown once and stored only as a hash.
			</ConsoleNote>

			{!canManage ? (
				<ConsoleNote role="note">
					Your role can read relay status but not register or revoke one. Owners
					and admins manage relays.
				</ConsoleNote>
			) : issued === null ? (
				<form
					onSubmit={onRegister}
					className="flex flex-col gap-3 border-y border-line-subtle py-4 sm:flex-row sm:items-end"
					noValidate
				>
					<div className="min-w-0 flex-1 space-y-1.5">
						<Label htmlFor="relay-name">Relay name</Label>
						<Input
							id="relay-name"
							name="displayName"
							required
							maxLength={100}
							autoComplete="off"
							placeholder="sre-laptop"
						/>
					</div>
					<Button type="submit" disabled={register.isPending}>
						<PlusIcon />
						{register.isPending ? "Registering…" : "Register relay"}
					</Button>
				</form>
			) : (
				<div className="space-y-3 border-y border-line-subtle py-4">
					<ConsoleNote role="alert" tone="warning">
						This token is shown once. Run the command on the relay machine now;
						clearing it discards the only copy.
					</ConsoleNote>
					<div className="space-y-1.5">
						<p className="text-xs font-medium text-ink-muted">Relay token</p>
						<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
							<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
								{issued.token}
							</code>
							<CopyButton value={issued.token} label="Copy relay token" />
						</div>
					</div>
					{command === null ? (
						<p className="text-xs text-ink-muted">
							Open this page from your deployed Isolate URL to build a safe
							install command.
						</p>
					) : (
						<div className="space-y-1.5">
							<p className="text-xs font-medium text-ink-muted">
								Install command
							</p>
							<div className="flex items-start gap-2 rounded-md border border-line bg-canvas p-2.5">
								<code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-ink">
									{command}
								</code>
								<CopyButton value={command} label="Copy install command" />
							</div>
						</div>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-ink-muted">
							Waiting for the first heartbeat…
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => void devices.refetch()}
						>
							<RetryIcon />
							Check now
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setIssued(null)}
						>
							Clear token
						</Button>
					</div>
				</div>
			)}

			{error ? (
				<p
					role="alert"
					className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
				>
					{error}
				</p>
			) : null}

			{devices.isPending ? (
				<div className="space-y-2" aria-busy="true">
					<Skeleton className="h-12 w-full" />
					<Skeleton className="h-12 w-full" />
				</div>
			) : devices.error ? (
				<ErrorState
					title="Relays could not be loaded"
					message={toDeviceApiError(devices.error).message}
					onRetry={() => void devices.refetch()}
				/>
			) : rows.length === 0 ? (
				<EmptyRow
					title="No relay registered"
					description="Register one relay per environment. Every connector reuses it."
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Relays registered in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col">Relay</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Status
								</TableHead>
								<TableHead scope="col" className="w-[180px]">
									Last heartbeat
								</TableHead>
								<TableHead scope="col" className="w-[120px] text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((device) => {
								const stale =
									mounted &&
									device.status === "active" &&
									device.lastSeenAt !== null &&
									Date.now() - new Date(device.lastSeenAt).getTime() >
										RELAY_OFFLINE_AFTER_MS;
								return (
									<TableRow key={device.id} className="h-12 border-line-subtle">
										<TableCell>
											<span className="text-sm text-ink">
												{device.displayName}
											</span>
											<p className="mt-0.5 font-mono text-[11px] text-ink-muted">
												{device.id.slice(0, 12)}…
											</p>
										</TableCell>
										<TableCell>
											<StatusMark status={stale ? "offline" : device.status} />
										</TableCell>
										<TableCell className="text-xs text-ink-secondary">
											{device.lastSeenAt ? (
												<RelativeTime value={device.lastSeenAt} />
											) : (
												<span className="text-ink-muted">Never seen</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											{canManage && device.status !== "revoked" ? (
												<Button
													type="button"
													variant="ghost"
													size="xs"
													className="text-danger hover:text-danger"
													onClick={() => {
														setError(null);
														setRevokeTarget(device);
													}}
												>
													Revoke
													<span className="sr-only"> {device.displayName}</span>
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

			<AlertDialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setRevokeTarget(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke this relay?</AlertDialogTitle>
						<AlertDialogDescription>
							The relay token stops working immediately. Events and history
							stay; register a new relay to resume connector calls.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={revoke.isPending}>
							Keep relay
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={revoke.isPending || revokeTarget === null}
							onClick={(event) => {
								event.preventDefault();
								if (revokeTarget === null) return;
								revoke.mutate(revokeTarget.id);
							}}
						>
							<TrashIcon />
							{revoke.isPending ? "Revoking…" : "Revoke"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</ConsoleSection>
	);
}
