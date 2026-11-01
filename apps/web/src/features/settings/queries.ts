import { queryOptions } from "@tanstack/react-query";
import { getWorkspaceMembers, getWorkspaceSummary } from "./settings.functions";

export const settingsKeys = {
	all: ["settings"] as const,
	summary: ["settings", "workspace-summary"] as const,
	members: ["settings", "members"] as const,
};

/** `staleTime` keeps the shell from refetching on every focus; retry is off. */
export const workspaceSummaryOptions = () =>
	queryOptions({
		queryKey: settingsKeys.summary,
		queryFn: () => getWorkspaceSummary(),
		staleTime: 30_000,
		retry: false,
	});

export const workspaceMembersOptions = () =>
	queryOptions({
		queryKey: settingsKeys.members,
		queryFn: () => getWorkspaceMembers(),
		staleTime: 30_000,
		retry: false,
	});
