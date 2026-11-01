import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@/components/auth/SessionProvider";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RetryIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activeRole, requireSession } from "@/features/auth/guard";
import { authStateOptions } from "@/features/auth/queries";
import { toDeviceApiError } from "@/features/devices/api";
import { ConnectorsPanel } from "@/features/devices/components/connectors-panel";
import { DevicesPanel } from "@/features/devices/components/devices-panel";
import {
	connectorListOptions,
	deviceListOptions,
} from "@/features/devices/queries";

export const Route = createFileRoute("/_app/devices")({
	loader: async ({ context }) => {
		const state = await context.queryClient.ensureQueryData(authStateOptions());
		return requireSession(state);
	},
	component: DevicesPage,
});

function DevicesPage() {
	const session = useSession();
	const role = activeRole(session);
	const canManage = role === "owner" || role === "admin";
	const devicesQuery = useQuery(deviceListOptions());
	const connectorsQuery = useQuery(connectorListOptions());
	const refreshing = devicesQuery.isFetching || connectorsQuery.isFetching;

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Manage"
				title="Devices and connectors"
				description="Register the devices that run connector calls, then connect the ten supported vendors. Vendor keys stay on the device; the server stores a token hash and metadata only."
				actions={
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={refreshing}
						onClick={() => {
							void devicesQuery.refetch();
							void connectorsQuery.refetch();
						}}
					>
						<RetryIcon />
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
				}
			/>

			<Tabs defaultValue="devices">
				<TabsList aria-label="Device and connector sections">
					<TabsTrigger value="devices">Devices</TabsTrigger>
					<TabsTrigger value="connectors">Connectors</TabsTrigger>
				</TabsList>
				<TabsContent value="devices" className="mt-4">
					<DevicesPanel
						devices={devicesQuery.data}
						isLoading={devicesQuery.isPending}
						error={
							devicesQuery.error ? toDeviceApiError(devicesQuery.error) : null
						}
						onRetry={() => void devicesQuery.refetch()}
						canManage={canManage}
						onChanged={() => {
							void devicesQuery.refetch();
							void connectorsQuery.refetch();
						}}
					/>
				</TabsContent>
				<TabsContent value="connectors" className="mt-4">
					<ConnectorsPanel
						credentials={connectorsQuery.data}
						isLoading={connectorsQuery.isPending}
						error={
							connectorsQuery.error
								? toDeviceApiError(connectorsQuery.error)
								: null
						}
						onRetry={() => void connectorsQuery.refetch()}
						devices={devicesQuery.data ?? []}
						canManage={canManage}
						onChanged={() => {
							void connectorsQuery.refetch();
						}}
					/>
				</TabsContent>
			</Tabs>
		</PageContainer>
	);
}
