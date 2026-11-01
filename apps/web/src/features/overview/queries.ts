import { queryOptions } from "@tanstack/react-query";
import { getOverview, getSubmitOptions } from "./overview.functions";

export const overviewKeys = {
	all: ["current-caller", "overview"] as const,
	snapshot: ["current-caller", "overview", "snapshot"] as const,
	submitOptions: ["current-caller", "overview", "submit-options"] as const,
};

export const overviewOptions = () =>
	queryOptions({
		queryKey: overviewKeys.snapshot,
		queryFn: () => getOverview(),
		staleTime: 15_000,
		retry: false,
	});

/** Connected repositories and published workflow versions for Submit. */
export const submitOptionsQueryOptions = () =>
	queryOptions({
		queryKey: overviewKeys.submitOptions,
		queryFn: () => getSubmitOptions(),
		staleTime: 60_000,
		retry: false,
	});
