import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { DevicesIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/devices")({
	component: DevicesPage,
});

function DevicesPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Manage"
				title="Devices and connectors"
				description="Connector credentials stay on a registered device. The server stores only a token hash and connector metadata."
			/>
			<EmptyState
				icon={DevicesIcon}
				title="Device management is being assembled"
				description="Register, rotate and revoke device tokens, then connect the ten supported connectors."
			/>
		</PageContainer>
	);
}
