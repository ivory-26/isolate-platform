import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { AuthState } from "../../features/auth/contracts";
import { authStateOptions } from "../../features/auth/queries";

const SessionContext = createContext<AuthState>({ mode: "anonymous" });

/**
 * Publishes the caller's authentication posture to the shared shell.
 *
 * The state is fetched by a server function, so no credential, cookie or
 * tenant identifier is ever read from the browser.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
	const query = useQuery(authStateOptions());
	const state = useMemo<AuthState>(
		() => query.data ?? { mode: "anonymous" },
		[query.data],
	);
	return (
		<SessionContext.Provider value={state}>{children}</SessionContext.Provider>
	);
}

export function useSession(): AuthState {
	return useContext(SessionContext);
}
