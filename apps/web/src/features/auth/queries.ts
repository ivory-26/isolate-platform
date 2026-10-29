import { queryOptions } from "@tanstack/react-query";
import { getAuthState, getSession } from "./auth.functions";

export const sessionKeys = { all: ["session"] as const };
export const sessionOptions = () =>
	queryOptions({
		queryKey: sessionKeys.all,
		queryFn: () => getSession(),
		staleTime: 30_000,
		retry: false,
	});

export const authStateKeys = { all: ["auth-state"] as const };
export const authStateOptions = () =>
	queryOptions({
		queryKey: authStateKeys.all,
		queryFn: () => getAuthState(),
		staleTime: 30_000,
		retry: false,
	});
