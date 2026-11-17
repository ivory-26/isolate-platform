import { queryOptions } from "@tanstack/react-query";
import {
	isLiveRunStatus,
	RUN_LIVE_POLL_INTERVAL_MS,
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

/**
 * Polling is a function of the data, not a fixed interval: a live run keeps
 * refreshing so the timeline advances without a manual reload, and the first
 * response that lands in a settled status turns polling off for good. That
 * keeps a forgotten tab from querying the server forever.
 */
export const runsListOptions = (search: RunsSearch) =>
	queryOptions({
		queryKey: runKeys.list(search),
		queryFn: () => listRuns({ data: runsSearchToFilter(search) }),
		staleTime: 10_000,
		retry: false,
		refetchInterval: (query) => {
			const data = query.state.data;
			return data?.ok &&
				data.value.rows.some((row) => isLiveRunStatus(row.status))
				? RUN_LIVE_POLL_INTERVAL_MS
				: false;
		},
	});

export const runDetailOptions = (taskId: string) =>
	queryOptions({
		queryKey: runKeys.detail(taskId),
		queryFn: () => getRunDetail({ data: { taskId } }),
		staleTime: 10_000,
		retry: false,
		refetchInterval: (query) => {
			const data = query.state.data;
			return data?.ok && isLiveRunStatus(data.value.task.status)
				? RUN_LIVE_POLL_INTERVAL_MS
				: false;
		},
	});
