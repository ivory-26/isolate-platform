import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { RelativeTime } from "@/components/common/relative-time";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleSection } from "@/components/console/section";
import { StatusMark } from "@/components/console/status-mark";
import { TrashIcon } from "@/components/icons";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { revokeConnector, toDeviceApiError } from "@/features/devices/api";
import type { IntegrationConnection, IntegrationSummary } from "../contracts";

/**
 * Connected sources: one row per connector that has a non-revoked credential.
 * Disconnect marks the metadata row revoked; the relay deletes its local secret
 * on the next poll. The server cannot delete a secret it never held.
 */
export function ConnectedIntegrationsPanel({
	integrations,
	canManage,
	onChanged,
}: {
	integrations: readonly IntegrationSummary[];
	canManage: boolean;
	onChanged: () => void;
}) {
	const connected = integrations.filter(
		(summary) => summary.connection !== null,
	);
	const [target, setTarget] = useState<{
		summary: IntegrationSummary;
		connection: IntegrationConnection;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const revoke = useMutation({
		mutationFn: (credentialId: string) => revokeConnector(credentialId),
		onSuccess: () => {
			onChanged();
			setTarget(null);
		},
		onError: (cause) => setError(toDeviceApiError(cause).message),
	});

	return (
		<ConsoleSection
			id="connected-sources"
			title="Connected sources"
			description="Status, relay, verification and event counters come from stored metadata. A verification action lands with the connector verify route; until then a new connection stays pending validation."
			action={
				<Button asChild size="sm" variant="outline">
					<Link to="/integrations" search={{ tab: "catalog" }}>
						Browse catalog
					</Link>
				</Button>
			}
		>
			{connected.length === 0 ? (
				<EmptyRow
					title="No sources connected"
					description="Connect a connector through an active relay. The provider key is entered on the relay's loopback page."
					action={
						<Button asChild size="sm">
							<Link to="/integrations" search={{ tab: "catalog" }}>
								Open catalog
							</Link>
						</Button>
					}
				/>
			) : (
				<div className="border-y border-line-subtle">
					<Table>
						<caption className="sr-only">
							Connected sources in the active organization
						</caption>
						<TableHeader>
							<TableRow className="border-line-subtle hover:bg-transparent">
								<TableHead scope="col" className="min-w-[200px]">
									Connection
								</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Relay
								</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Status
								</TableHead>
								<TableHead scope="col" className="w-[140px]">
									Last verified
								</TableHead>
								<TableHead scope="col" className="w-[130px]">
									Last event
								</TableHead>
								<TableHead scope="col" className="w-[80px] text-right">
									Triggers
								</TableHead>
								<TableHead scope="col" className="w-[150px]">
									Enabled tools
								</TableHead>
								<TableHead scope="col" className="w-[110px]">
									Usage
								</TableHead>
								<TableHead scope="col" className="w-[130px] text-right">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{connected.map((summary) => {
								const connection = summary.connection;
								if (connection === null) return null;
								return (
									<TableRow
										key={connection.id}
										className="h-12 border-line-subtle"
									>
										<TableCell className="py-2">
											<Link
												to="/integrations/$connectorId"
												params={{ connectorId: summary.connectorId }}
												search={{ tab: "connected" }}
												className="text-sm text-ink transition-colors hover:text-brand focus-visible:text-brand focus-visible:outline-none"
											>
												{summary.label}
											</Link>
											<p className="mt-0.5 truncate text-[11px] text-ink-muted">
												{connection.displayName}
											</p>
										</TableCell>
										<TableCell className="py-2 text-xs text-ink-secondary">
											{connection.relayName}
										</TableCell>
										<TableCell className="py-2">
											<StatusMark status={connection.status} />
										</TableCell>
										<TableCell className="py-2 text-xs text-ink-secondary">
											{connection.lastValidatedAt ? (
												<RelativeTime value={connection.lastValidatedAt} />
											) : (
												<span className="text-ink-muted">Never</span>
											)}
										</TableCell>
										<TableCell className="py-2 text-xs text-ink-secondary">
											{summary.lastEventAt ? (
												<RelativeTime value={summary.lastEventAt} />
											) : (
												<span className="text-ink-muted">None</span>
											)}
										</TableCell>
										<TableCell className="py-2 text-right font-mono text-xs text-ink-secondary tabular-nums">
											{summary.enabledTriggerCount}
										</TableCell>
										<TableCell
											className="max-w-[150px] truncate py-2 text-xs text-ink-secondary"
											title={connection.enabledTools.join(", ")}
										>
											{connection.enabledTools.length > 0
												? connection.enabledTools.join(", ")
												: "None"}
										</TableCell>
										<TableCell className="py-2 font-mono text-xs text-ink-secondary tabular-nums">
											{summary.usage.requestsThisPeriod}
											<span className="text-ink-muted"> this period</span>
										</TableCell>
										<TableCell className="py-2 text-right">
											{canManage ? (
												<Button
													type="button"
													variant="ghost"
													size="xs"
													className="text-danger hover:text-danger"
													onClick={() => {
														setError(null);
														setTarget({ summary, connection });
													}}
												>
													Disconnect
													<span className="sr-only">
														{" "}
														{summary.label} {connection.displayName}
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

			<AlertDialog
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) {
						setTarget(null);
						setError(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Disconnect {target?.summary.label ?? "this connector"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							The metadata row is kept as revoked and the event history stays.
							The relay deletes its local secret on the next poll; Isolate
							cannot delete a secret it never held.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{error ? (
						<p
							role="alert"
							className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
						>
							{error}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={revoke.isPending}>
							Keep connected
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={revoke.isPending || target === null}
							onClick={(event) => {
								event.preventDefault();
								if (target === null) return;
								revoke.mutate(target.connection.id);
							}}
						>
							<TrashIcon />
							{revoke.isPending ? "Disconnecting…" : "Disconnect"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</ConsoleSection>
	);
}
