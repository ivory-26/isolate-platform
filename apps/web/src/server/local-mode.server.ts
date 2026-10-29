import "@tanstack/react-start/server-only";

/**
 * Local demo configuration lives with the dev caller-scope adapter so the
 * identity guard and the store guard can never drift apart. This module stays
 * as the stable import surface for the local demo.
 */
export {
	createLocalDemoAdapters,
	localDemo,
	type RuntimeConfig,
	resolveLocalScope,
} from "./caller-scope.server";
