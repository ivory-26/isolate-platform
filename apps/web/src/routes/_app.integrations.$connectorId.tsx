import {
	useQuery,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RelativeTime } from "@/components/common/relative-time";
import { ConsoleNote } from "@/components/console/note";
import { StatusMark } from "@/components/console/status-mark";
import { ArrowRightIcon, ConnectorsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { deviceListOptions } from "@/features/devices/queries";
import {
	type IntegrationCatalogEntry,
	integrationCatalogEntry,
} from "@/features/integrations/catalog";
import { CapabilityBadges } from "@/features/integrations/components/capability-badges";
import { CapabilitySections } from "@/features/integrations/components/capability-sections";
import { ConnectPairingPanel } from "@/features/integrations/components/connect-pairing-panel";
import { DeliveriesPanel } from "@/features/integrations/components/deliveries-panel";
import { TriggerRulesPanel } from "@/features/integrations/components/trigger-rules";
import { VerificationPanel } from "@/features/integrations/components/verification-panel";
import {
	integrationKeys,
	integrationOptions,
} from "@/features/integrations/queries";
import { verificationStatusLabel } from "@/features/integrations/verification";

export const Route = createFileRoute("/_app/integrations/$connectorId")({
	loader: async ({ context, params }) => {
		if (integrationCatalogEntry(params.connectorId) === undefined) return;
		await context.queryClient.ensureQueryData(
			integrationOptions(params.connectorId),
		);
	},
	component: ConnectorDetailPage,
	errorComponent: ConnectorDetailError,
});

function ConnectorDetailPage() {
	const { connectorId } = Route.useParams();
	const entry = integrationCatalogEntry(connectorId);
	if (entry === undefined) {
		return <UnknownConnector connectorId={connectorId} />;
	}
	return <ConnectorDetail connectorId={connectorId} entry={entry} />;
}

function UnknownConnector({ connectorId }: { connectorId: string }) {
	return (
		<PageContainer>
			<PageHeader
				title="Unknown connector"
				description={`"${connectorId}" is not one of the ten supported connectors.`}
				actions={
					<Button asChild variant="outline" size="sm">
						<Link to="/integrations" search={{ tab: "catalog" }}>
							Back to catalog
						</Link>
					</Button>
				}
			/>
			<ErrorState
				title="Connector not found"
				message="Choose a connector from the catalog. The connector id is a closed union, not free text."
			/>
		</PageContainer>
	);
}

function ConnectorDetailError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader
				title="Integration"
				description="The connector could not be loaded."
			/>
			<ErrorState
				message="Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function ConnectorDetail({
	connectorId,
	entry,
}: {
	connectorId: string;
	entry: IntegrationCatalogEntry;
}) {
	const query = useSuspenseQuery(integrationOptions(connectorId));
	const relays = useQuery(deviceListOptions());
	const queryClient = useQueryClient();
	const detail = query.data.ok ? query.data.value : null;
	const connection = detail?.summary.connection ?? null;
	const canManage = detail?.canManage ?? false;

	const refresh = () => {
		void queryClient.invalidateQueries({
			queryKey: integrationKeys.detail(connectorId),
		});
		void queryClient.invalidateQueries({ queryKey: integrationKeys.list });
	};

	return (
		<PageContainer>
			<PageHeader
				title={entry.label}
				description={entry.description}
				actions={
					<>
						<Button asChild variant="ghost" size="sm">
							<Link to="/integrations" search={{ tab: "catalog" }}>
								<ConnectorsIcon />
								All integrations
							</Link>
						</Button>
						{detail === null ? null : connection !== null ? (
							<Button asChild variant="outline" size="sm">
								<a href="#trigger-rules">
									Triggers
									<ArrowRightIcon />
								</a>
							</Button>
						) : (
							<Button asChild size="sm">
								<a href="#connect">
									Connect securely
									<ArrowRightIcon />
								</a>
							</Button>
						)}
					</>
				}
			>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<CapabilityBadges capabilities={entry.capabilities} />
					<span className="font-mono text-[11px] text-ink-muted">
						{entry.category}
					</span>
					{connection ? (
						<>
							<StatusMark
								status={connection.status}
								label={verificationStatusLabel(connection.status)}
							/>
							<span className="text-xs text-ink-muted">
								on {connection.relayName}
							</span>
							{detail?.summary.lastEventAt ? (
								<span className="text-xs text-ink-muted">
									last event <RelativeTime value={detail.summary.lastEventAt} />
								</span>
							) : null}
						</>
					) : (
						<span className="text-xs text-ink-muted">Not connected</span>
					)}
				</div>
			</PageHeader>

			{!query.data.ok ? (
				<ErrorState
					title="Integration unavailable"
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			) : (
				<>
					<CapabilitySections entry={entry} />

					<ConnectPairingPanel
						entry={entry}
						connection={connection}
						relays={relays.data ?? []}
						canManage={canManage}
						onConnected={refresh}
					/>

					<VerificationPanel
						connectorId={connectorId}
						connection={connection}
						canManage={canManage}
					/>

					<TriggerRulesPanel
						entry={entry}
						subscriptions={detail?.subscriptions ?? []}
						canManage={canManage}
						onChanged={refresh}
					/>

					<DeliveriesPanel
						deliveries={detail?.deliveries ?? []}
						truncated={false}
					/>

					<ConsoleNote role="note">
						Credential hint: {entry.credentialHint} See{" "}
						<span className="font-mono text-[11px]">{entry.docsPath}</span> for
						the exact key-creation path and minimum scopes.
					</ConsoleNote>
				</>
			)}
		</PageContainer>
	);
}
