import { queryOptions } from "@tanstack/react-query";
import { listTasks } from "./tasks.functions";

export const taskKeys = { all: ["current-caller", "tasks"] as const };
export const latestTasksOptions = () =>
	queryOptions({
		queryKey: [...taskKeys.all, "latest", 25],
		queryFn: () => listTasks({ data: { limit: 25 } }),
		staleTime: 10_000,
		retry: false,
	});
