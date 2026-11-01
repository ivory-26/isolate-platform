import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { SettingsIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/settings")({
	component: SettingsPage,
});

function SettingsPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Manage"
				title="Settings"
				description="Workspace, members, policies and account controls for the active organization."
			/>
			<EmptyState
				icon={SettingsIcon}
				title="Settings are being assembled"
				description="Workspace details, membership roles and policy controls will render here."
			/>
		</PageContainer>
	);
}
