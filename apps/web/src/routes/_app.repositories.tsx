import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RepositoriesIcon } from "@/components/icons";

export const Route = createFileRoute("/_app/repositories")({
	component: RepositoriesPage,
});

function RepositoriesPage() {
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Repositories"
				description="Connected repositories, default branches, validation commands and integration health."
			/>
			<EmptyState
				icon={RepositoriesIcon}
				title="Repositories are being assembled"
				description="Connected repositories and their validation policy will render here."
			/>
		</PageContainer>
	);
}
