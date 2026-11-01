import { queryOptions } from "@tanstack/react-query";
import {
	RUNS_PAGE_LIMIT_DEFAULT,
	type RunsSearch,
	runsSearchToFilter,
} from "./contracts";
import { getRunDetail, listRuns } from "./runs.functions";

export const runKeys = {
	all: ["runs"] as const,
	list: (search: RunsSearch) =>
		[
			...runKeys.all,
			"list",
			{ ...search, limit: RUNS_PAGE_LIMIT_DEFAULT },
		] as const,
	detail: (taskId: string) => [...runKeys.all, "detail", taskId] as const,
};

export const runsListOptions = (search: RunsSearch) =>
	queryOptions({
		queryKey: runKeys.list(search),
		queryFn: () => listRuns({ data: runsSearchToFilter(search) }),
		staleTime: 10_000,
		retry: false,
	});

export const runDetailOptions = (taskId: string) =>
	queryOptions({
		queryKey: runKeys.detail(taskId),
		queryFn: () => getRunDetail({ data: { taskId } }),
		staleTime: 10_000,
		retry: false,
	});
