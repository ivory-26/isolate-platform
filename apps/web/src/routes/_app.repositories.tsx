import { useSuspenseQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { Button } from "@/components/ui/button";
import {
	parseRepositoriesSearch,
	type RepositoriesSearch,
} from "@/features/repositories/contracts";
import { repositoriesOptions } from "@/features/repositories/queries";
import {
	RegisterRepositoryDialog,
	RepositoriesSkeleton,
	RepositoriesTable,
	RepositoryFilters,
} from "@/features/repositories/repositories-view";

export const Route = createFileRoute("/_app/repositories")({
	validateSearch: (search: Record<string, unknown>): RepositoriesSearch =>
		parseRepositoriesSearch(search),
	loaderDeps: ({ search }) => ({ q: search.q, provider: search.provider }),
	loader: async ({ context, deps }) => {
		await context.queryClient.ensureQueryData(repositoriesOptions(deps));
	},
	component: RepositoriesPage,
	pendingComponent: () => (
		<PageContainer>
			<RepositoriesSkeleton />
		</PageContainer>
	),
	errorComponent: RepositoriesError,
});

function RepositoriesError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader
				title="Repositories"
				description="Connected repositories, default branches, validation commands and registration state."
			/>
			<ErrorState
				message="Repositories could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function RepositoriesPage() {
	const search = Route.useSearch();
	const query = useSuspenseQuery(repositoriesOptions(search));
	const navigate = useNavigate();

	const updateSearch = useCallback(
		(next: RepositoriesSearch) => {
			void navigate({
				to: "/repositories",
				search: next,
				replace: true,
			});
		},
		[navigate],
	);

	if (!query.data.ok) {
		return (
			<PageContainer>
				<PageHeader
					title="Repositories"
					description="Connected repositories, default branches, validation commands and registration state."
				/>
				<ErrorState
					message={query.data.error.message}
					onRetry={() => void query.refetch()}
				/>
			</PageContainer>
		);
	}

	const { repositories, truncated, canManage } = query.data.value;
	const filtered = search.q.length > 0 || search.provider !== undefined;

	return (
		<PageContainer>
			<PageHeader
				title="Repositories"
				description="Connected repositories, default branches, validation commands and registration state for the active organization."
				actions={
					canManage && repositories.length > 0 ? (
						<RegisterRepositoryDialog />
					) : undefined
				}
			/>

			<ConsoleNote role="note">
				Integration health is not reported by the server in this wave; rows show
				only stored configuration.
			</ConsoleNote>

			<RepositoryFilters
				search={search}
				count={repositories.length}
				filtered={filtered}
				onQueryChange={(q) => updateSearch({ q, provider: search.provider })}
				onProviderChange={(provider) => updateSearch({ q: search.q, provider })}
			/>

			{repositories.length === 0 ? (
				filtered ? (
					<EmptyRow
						title="No repositories match this filter"
						description="Try a different full name or clear the provider filter."
						action={
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => updateSearch({ q: "" })}
							>
								Clear filters
							</Button>
						}
					/>
				) : (
					<EmptyRow
						title="No repositories registered yet"
						description="Register a GitHub repository to give tasks a default branch and an optional validation gate."
						action={canManage ? <RegisterRepositoryDialog /> : undefined}
					/>
				)
			) : (
				<RepositoriesTable repositories={repositories} truncated={truncated} />
			)}
		</PageContainer>
	);
}
