import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { WorkflowsIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/workflows")({
	component: WorkflowsPage,
});

function WorkflowsPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Workflows"
				description="Authored workflow definitions and their immutable versions. A task pins one version at submission."
			/>
			<EmptyState
				icon={WorkflowsIcon}
				title="Workflow library is being assembled"
				description="Definitions, versions and validation state will render here. The visual builder is a later wave."
			/>
		</PageContainer>
	);
}
