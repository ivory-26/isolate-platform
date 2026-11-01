import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { LogsIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/runs/$taskId")({
	component: RunDetailPage,
});

function RunDetailPage() {
	const { taskId } = Route.useParams();
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Run detail"
				title="Run detail"
				description={`Timeline, structured logs, artifacts and approvals for task ${taskId}.`}
			/>
			<EmptyState
				icon={LogsIcon}
				title="Run detail is being assembled"
				description="The durable event timeline, tool decisions, artifacts and traces will render here."
			/>
		</PageContainer>
	);
}
