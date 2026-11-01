import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { EmptyRow } from "@/components/console/empty-row";
import { parseUsageSearch, type UsageSearch } from "@/features/usage/contracts";
import { usageOptions } from "@/features/usage/queries";
import {
	UsageCharts,
	UsageMetrics,
	UsagePeriodSelector,
	UsageSkeleton,
	UsageTable,
} from "@/features/usage/usage-view";
import { formatDate } from "@/lib/format";

export const Route = createFileRoute("/_app/usage")({
	validateSearch: (search: Record<string, unknown>): UsageSearch =>
		parseUsageSearch(search),
	loaderDeps: ({ search }) => ({ period: search.period }),
	loader: async ({ context, deps }) => {
		await context.queryClient.ensureQueryData(usageOptions(deps.period));
	},
	component: UsagePage,
	pendingComponent: () => (
		<PageContainer>
			<UsageSkeleton />
		</PageContainer>
	),
	errorComponent: UsageError,
});

function UsageError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader
				title="Usage"
				description="Measured model tokens, sandbox seconds and recorded cost."
			/>
			<ErrorState
				message="Usage could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function UsagePage() {
	const search = Route.useSearch();
	const query = useSuspenseQuery(usageOptions(search.period));
	const description =
		"Measured model tokens, sandbox seconds and recorded cost for the active organization. All values come from usage records; no estimates are produced, and a missing price is shown as a dash.";

	if (!query.data.ok) {
		return (
			<PageContainer>
				<PageHeader
					title="Usage"
					description={description}
					actions={<UsagePeriodSelector period={search.period} />}
				/>
				<ErrorState
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			</PageContainer>
		);
	}

	const model = query.data.value;

	return (
		<PageContainer>
			<PageHeader
				title="Usage"
				description={description}
				actions={<UsagePeriodSelector period={search.period} />}
			>
				<p className="flex items-center gap-2 text-xs text-ink-muted">
					<span
						aria-hidden="true"
						className="size-1.5 shrink-0 rounded-full bg-brand"
					/>
					Measured · {model.period} day window · {model.timeZone} · through{" "}
					{formatDate(new Date(new Date(model.until).getTime() - 1))}
				</p>
			</PageHeader>

			{!model.hasRows ? (
				<EmptyRow
					title="No usage recorded in this period"
					description="Neither model usage nor measured sandbox time exists for the selected window. Choose a longer period or run a task."
				/>
			) : (
				<div className="flex flex-col gap-8">
					<UsageMetrics model={model} />
					<UsageCharts model={model} />
					<UsageTable model={model} />
				</div>
			)}
		</PageContainer>
	);
}
