import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { ErrorState } from "@/components/common/error-state";
import { PageContainer } from "@/components/common/page-container";
import { PageHeader } from "@/components/common/page-header";
import { ConsoleNote } from "@/components/console/note";
import { ConnectorsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	filterInboxItems,
	type InboxSearch,
	inboxSearchFor,
	parseInboxSearch,
} from "@/features/inbox/contracts";
import {
	InboxEmptyState,
	InboxFilters,
	InboxSkeleton,
	InboxTable,
} from "@/features/inbox/inbox-view";
import { inboxOptions } from "@/features/inbox/queries";

export const Route = createFileRoute("/_app/inbox")({
	validateSearch: (search: Record<string, unknown>): InboxSearch =>
		parseInboxSearch(search),
	loaderDeps: ({ search }) => ({
		status: search.status,
		source: search.source,
	}),
	loader: async ({ context, deps }) => {
		await context.queryClient.ensureQueryData(
			inboxOptions(parseInboxSearch(deps)),
		);
	},
	component: InboxPage,
	pendingComponent: () => (
		<PageContainer>
			<InboxSkeleton />
		</PageContainer>
	),
	errorComponent: InboxError,
});

const DESCRIPTION =
	"Every verified event delivery for this organization: source, event kind, severity, the matched rule outcome and the task it created. Payloads and provider secrets are never stored or shown.";

function InboxError() {
	const router = useRouter();
	return (
		<PageContainer>
			<PageHeader title="Inbox" description={DESCRIPTION} />
			<ErrorState
				message="The inbox could not be loaded. Retry in a moment."
				onRetry={() => void router.invalidate()}
			/>
		</PageContainer>
	);
}

function InboxPage() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const query = useSuspenseQuery(inboxOptions(search));

	const items = useMemo(
		() =>
			query.data.ok
				? filterInboxItems(query.data.value.items, search.severity)
				: [],
		[query.data, search.severity],
	);

	const updateSearch = (changes: Partial<InboxSearch>) => {
		void navigate({
			to: "/inbox",
			search: inboxSearchFor(search, changes),
			replace: true,
			resetScroll: false,
		});
	};

	const header = (
		<PageHeader
			title="Inbox"
			description={DESCRIPTION}
			actions={
				<Button asChild size="sm" variant="outline">
					<Link to="/integrations" search={{ tab: "catalog" }}>
						<ConnectorsIcon size={14} />
						Integrations
					</Link>
				</Button>
			}
		/>
	);

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

	const total = query.data.value.items.length;
	const empty = total === 0 && filterIsClear(search);

	return (
		<PageContainer>
			{header}

			{empty ? (
				<InboxEmptyState />
			) : (
				<>
					<InboxFilters
						search={search}
						count={items.length}
						total={total}
						onChange={updateSearch}
					/>
					{query.isRefetchError ? (
						<ConsoleNote role="alert" tone="warning">
							Refresh failed. The deliveries below may be stale.
						</ConsoleNote>
					) : null}
					<InboxTable
						items={items}
						page={search.page ?? 1}
						onPageChange={(page) => updateSearch({ page })}
					/>
				</>
			)}
		</PageContainer>
	);
}

function filterIsClear(search: InboxSearch): boolean {
	return (
		search.status === undefined &&
		search.source === undefined &&
		search.severity === undefined
	);
}
