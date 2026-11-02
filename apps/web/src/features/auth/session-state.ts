import type { AuthState } from "./contracts";

/**
 * The auth posture a shell component should render.
 *
 * The root route loader resolves the posture before the first paint and the
 * query cache is hydrated with it. The cache is authoritative once it holds a
 * value; the loader result is the deterministic fallback for the first render,
 * so a client never paints an anonymous shell while a trusted session exists.
 */
export function resolveSessionState(
	cached: AuthState | undefined,
	loaderState: AuthState | undefined,
): AuthState {
	return cached ?? loaderState ?? { mode: "anonymous" };
}
