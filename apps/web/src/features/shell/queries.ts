import { queryOptions } from "@tanstack/react-query";
import { getShellSummary } from "./shell.functions";

export const shellKeys = { summary: ["shell", "summary"] as const };

export const shellSummaryOptions = () =>
	queryOptions({
		queryKey: shellKeys.summary,
		queryFn: () => getShellSummary(),
		staleTime: 15_000,
		retry: false,
	});
