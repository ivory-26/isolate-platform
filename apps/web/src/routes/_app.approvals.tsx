import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { ApprovalsIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/approvals")({
	component: ApprovalsPage,
});

function ApprovalsPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Approvals"
				description="Human decisions that unblock a run. Each approval is bound to the exact action and payload it authorizes."
			/>
			<EmptyState
				icon={ApprovalsIcon}
				title="Approvals are being assembled"
				description="Pending and decided approvals will render here with their exact scope and consequences."
			/>
		</PageContainer>
	);
}
