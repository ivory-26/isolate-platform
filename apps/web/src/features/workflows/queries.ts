import { queryOptions } from "@tanstack/react-query";
import { listWorkflows } from "./workflows.functions";

export const workflowKeys = { all: ["workflows"] as const };

export const workflowsOptions = () =>
	queryOptions({
		queryKey: workflowKeys.all,
		queryFn: () => listWorkflows(),
		staleTime: 20_000,
		retry: false,
	});
