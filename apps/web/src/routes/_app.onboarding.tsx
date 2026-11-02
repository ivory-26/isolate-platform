import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { RetryIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { OnboardingWizard } from "@/features/onboarding/components/onboarding-wizard";
import { setupStateOptions } from "@/features/onboarding/queries";
import { repositoriesOptions } from "@/features/repositories/queries";

export const Route = createFileRoute("/_app/onboarding")({
	loader: async ({ context }) => {
		await Promise.all([
			context.queryClient.ensureQueryData(setupStateOptions()),
			context.queryClient.ensureQueryData(repositoriesOptions({ q: "" })),
		]);
	},
	component: OnboardingPage,
});

function OnboardingPage() {
	const query = useSuspenseQuery(setupStateOptions());

	return (
		<PageContainer>
			<PageHeader
				title="Set up Isolate"
				description="Four steps: connect GitHub, install one relay, connect a source and create the default trigger. No deployment .env edits, no pasted provider keys."
				actions={
					<>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							<RetryIcon />
							{query.isFetching ? "Refreshing…" : "Refresh"}
						</Button>
						<Button asChild variant="outline" size="sm">
							<Link to="/overview">Skip to overview</Link>
						</Button>
					</>
				}
			/>
			{query.data.ok ? (
				<OnboardingWizard state={query.data.value} />
			) : (
				<ErrorState
					title="Setup state unavailable"
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			)}
		</PageContainer>
	);
}
