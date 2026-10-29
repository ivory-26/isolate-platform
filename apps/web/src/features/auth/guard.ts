import { redirect } from "@tanstack/react-router";
import type { AuthState } from "./contracts";

/**
 * Protected routes need a trusted session.
 *
 * The local demo is an explicit development/test mode with its own trusted
 * scope, so it is never redirected. Every other unauthenticated posture fails
 * closed by sending the caller to the sign-in page.
 */
export function requireSession(state: AuthState): AuthState {
	if (state.mode === "anonymous" || state.mode === "unavailable") {
		throw redirect({ to: "/login" });
	}
	return state;
}

/**
 * The role the caller holds in the active organization. Roles come from the
 * membership table, never from the request.
 */
export function activeRole(state: AuthState) {
	if (state.mode !== "authenticated") return null;
	const activeId = state.session.activeOrganizationId;
	if (!activeId) return null;
	return (
		state.session.organizations.find((entry) => entry.id === activeId)?.role ??
		null
	);
}
