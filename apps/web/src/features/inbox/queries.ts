import { queryOptions } from "@tanstack/react-query";
import { type InboxSearch, inboxQueryFor } from "./contracts";
import { listInbox } from "./inbox.functions";

export const inboxKeys = { all: ["current-caller", "inbox"] as const };

/**
 * One bounded window of deliveries for the active filters. The page slices it
 * into 25-row pages locally; `limit: 100` is the server's hard cap.
 */
export const inboxOptions = (search: InboxSearch) => {
	const input = inboxQueryFor(search);
	return queryOptions({
		queryKey: [
			...inboxKeys.all,
			input.status ?? "all",
			input.source ?? "all",
			input.severity ?? "all",
		],
		queryFn: () => listInbox({ data: input }),
		staleTime: 15_000,
		retry: false,
	});
};
