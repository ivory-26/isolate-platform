import { queryOptions } from "@tanstack/react-query";
import { getApprovals } from "./approvals.functions";

export const approvalKeys = {
	all: ["current-caller", "approvals"] as const,
	snapshot: ["current-caller", "approvals", "snapshot"] as const,
};

export const approvalsOptions = () =>
	queryOptions({
		queryKey: approvalKeys.snapshot,
		queryFn: () => getApprovals(),
		staleTime: 10_000,
		retry: false,
	});
