import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { WorkflowsIcon } from "@/components/icons";
import { workflowsOptions } from "@/features/workflows/queries";
import {
	BuilderUnavailableNote,
	WorkflowsSkeleton,
	WorkflowsTable,
} from "@/features/workflows/workflows-view";

export const Route = createFileRoute("/_app/workflows")({
	loader: async ({ context }) => {
		await context.queryClient.ensureQueryData(workflowsOptions());
	},
	component: WorkflowsPage,
	pendingComponent: () => (
		<PageContainer>
			<WorkflowsSkeleton />
		</PageContainer>
	),
	errorComponent: WorkflowsError,
});

function WorkflowsError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Workflows"
				description="Authored workflow definitions and their immutable versions."
			/>
			<ErrorState
				message="Workflow definitions could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function WorkflowsPage() {
	const query = useSuspenseQuery(workflowsOptions());
	const description =
		"Definitions and immutable versions for the active organization. A task pins one version at submission; the newest compiled plan and rejection are shown.";

	if (!query.data.ok) {
		return (
			<PageContainer>
				<PageHeader
					eyebrow="Operate"
					title="Workflows"
					description={description}
				/>
				<ErrorState
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			</PageContainer>
		);
	}

	const { workflows, truncated } = query.data.value;

	return (
		<PageContainer>
			<PageHeader
				eyebrow="Operate"
				title="Workflows"
				description={description}
			/>
			<BuilderUnavailableNote />
			{workflows.length === 0 ? (
				<EmptyState
					icon={WorkflowsIcon}
					title="No workflow definitions yet"
					description="Definitions appear here once the authored workflow library is seeded or published outside this read-only surface."
				/>
			) : (
				<WorkflowsTable workflows={workflows} truncated={truncated} />
			)}
		</PageContainer>
	);
}
