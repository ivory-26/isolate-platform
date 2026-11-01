import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { OverviewIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/")({
	component: OverviewPage,
});

function OverviewPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Overview"
				description="Operational state for the active organization: what is running, what needs approval, and what changed recently."
			/>
			<EmptyState
				icon={OverviewIcon}
				title="Overview is being assembled"
				description="Metrics, active runs, pending approvals and recent activity will render here from live server data."
			/>
		</PageContainer>
	);
}
