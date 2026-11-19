import { useSuspenseQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { EmptyRow } from "@/components/console/empty-row";
import { ConsoleNote } from "@/components/console/note";
import { Button } from "@/components/ui/button";
import {
	parseRepositoriesSearch,
	type RepositoriesSearch,
	type RepositoryProvider,
} from "@/features/repositories/contracts";
import { repositoriesOptions } from "@/features/repositories/queries";
import {
	AdvancedRegistration,
	ConnectGitHubPanel,
	RepositoriesSkeleton,
	RepositoriesTable,
	RepositoryFilters,
} from "@/features/repositories/repositories-view";
import { requestWorkspaceScrollPreservation } from "@/lib/workspace-scroll";

type GitHubCallbackState = "connected" | "error";

type RepositoriesRouteSearch = RepositoriesSearch & {
	page?: number;
	/** Present when GitHub redirected back through `/api/github/callback`. */
	github?: GitHubCallbackState;
	/** Fixed failure code from the callback; never a provider body. */
	code?: string;
};

const CALLBACK_FAILURE_MESSAGES: Record<string, string> = {
	GITHUB_APP_NOT_CONFIGURED:
		"The GitHub App is not configured for this deployment, so installation could not start.",
	GITHUB_INSTALLATION_REQUIRED:
		"Install the Isolate GitHub App for this organization first.",
	FORBIDDEN: "Only an owner or admin can install the GitHub App.",
	RATE_LIMITED: "GitHub is rate limiting Isolate. Try again shortly.",
	INVALID_INPUT:
		"The GitHub redirect was invalid or expired. Start the install again.",
	NOT_FOUND: "The requested GitHub record was not found.",
	UNAVAILABLE: "GitHub is temporarily unavailable.",
};

function parseRouteSearch(
	search: Record<string, unknown>,
): RepositoriesRouteSearch {
	const base = parseRepositoriesSearch(search);
	const parsed: RepositoriesRouteSearch = { ...base };
	const page = Number(search.page);
	if (Number.isFinite(page) && page >= 2) parsed.page = Math.trunc(page);
	if (search.github === "connected" || search.github === "error") {
		parsed.github = search.github;
	}
	if (typeof search.code === "string" && search.code.length > 0) {
		parsed.code = search.code.slice(0, 48);
	}
	return parsed;
}

export const Route = createFileRoute("/_app/repositories")({
	validateSearch: (search: Record<string, unknown>): RepositoriesRouteSearch =>
		parseRouteSearch(search),
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

const DESCRIPTION =
	"Install the Isolate GitHub App, import the repositories it may work on, and review the default branch and validation gate for each.";

function RepositoriesError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader title="Repositories" description={DESCRIPTION} />
			<ErrorState
				message="Repositories could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function RepositoriesPage() {
	const search = Route.useSearch();
	const query = useSuspenseQuery(
		repositoriesOptions({ q: search.q, provider: search.provider }),
	);
	const navigate = useNavigate();

	const updateSearch = (changes: Partial<RepositoriesRouteSearch>) => {
		requestWorkspaceScrollPreservation();
		void navigate({
			to: "/repositories",
			search: { q: search.q, provider: search.provider, ...changes },
			replace: true,
			resetScroll: false,
		});
	};

	const header = <PageHeader title="Repositories" description={DESCRIPTION} />;

	if (!query.data.ok) {
		return (
			<PageContainer>
				{header}
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
			{header}

			{search.github === "connected" ? (
				<ConsoleNote role="status">
					GitHub is connected for this organization. Choose repositories below
					to import them.
				</ConsoleNote>
			) : null}
			{search.github === "error" ? (
				<ConsoleNote role="alert" tone="danger">
					{search.code !== undefined
						? (CALLBACK_FAILURE_MESSAGES[search.code] ??
							"The GitHub installation did not complete. Start the install again.")
						: "The GitHub installation did not complete. Start the install again."}
				</ConsoleNote>
			) : null}

			<ConnectGitHubPanel
				canManage={canManage}
				autoExpand={search.github === "connected"}
			/>

			<ConsoleNote role="note">
				Installation account metadata is not part of this read model yet; rows
				show the stored configuration the worker uses.
			</ConsoleNote>

			<RepositoryFilters
				search={search}
				count={repositories.length}
				filtered={filtered}
				onQueryChange={(q) =>
					updateSearch({ q, provider: search.provider, page: undefined })
				}
				onProviderChange={(provider: RepositoryProvider | undefined) =>
					updateSearch({ q: search.q, provider, page: undefined })
				}
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
								onClick={() =>
									updateSearch({ q: "", provider: undefined, page: undefined })
								}
							>
								Clear filters
							</Button>
						}
					/>
				) : (
					<EmptyRow
						title="No repositories imported yet"
						description="Use Connect GitHub above to import repositories from the installation. Connected sources only create tasks for an imported repository."
					/>
				)
			) : (
				<RepositoriesTable
					repositories={repositories}
					truncated={truncated}
					page={search.page ?? 1}
					onPageChange={(page) => updateSearch({ page })}
				/>
			)}

			<AdvancedRegistration canManage={canManage} />
		</PageContainer>
	);
}
