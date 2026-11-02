import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { AuthState } from "../../features/auth/contracts";
import { authStateOptions } from "../../features/auth/queries";
import { resolveSessionState } from "../../features/auth/session-state";

const SessionContext = createContext<AuthState>({ mode: "anonymous" });

/**
 * Publishes the caller's authentication posture to the shared shell.
 *
 * The state is fetched by a server function, so no credential, cookie or
 * tenant identifier is ever read from the browser. `initialState` is the
 * posture the root loader already resolved, so the first client render matches
 * the server and never flashes an anonymous shell for a signed-in caller.
 */
export function SessionProvider({
	children,
	initialState,
}: {
	children: ReactNode;
	initialState?: AuthState;
}) {
	const query = useQuery(authStateOptions());
	const state = useMemo<AuthState>(
		() => resolveSessionState(query.data, initialState),
		[query.data, initialState],
	);
	return (
		<SessionContext.Provider value={state}>{children}</SessionContext.Provider>
	);
}

export function useSession(): AuthState {
	return useContext(SessionContext);
}
