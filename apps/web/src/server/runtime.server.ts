import "@tanstack/react-start/server-only";
import { createDb } from "@isolate/db";
import {
	createLocalDemoAdapters,
	type RuntimeConfig,
	resolveCallerScope,
} from "./caller-scope.server";
import { createPostgresStore } from "./postgres-store.server";
import {
	type CallerScope,
	ControlPlaneError,
	createTaskService,
	type TaskStore,
} from "./task-service.server";

let store: Promise<TaskStore> | undefined;

/**
 * No trusted session/membership adapter is wired for database deployments yet.
 * Headers, cookies and form fields are never identity, so fail closed instead
 * of silently falling back to a demo tenant.
 */
async function resolveRuntimeScope(
	config: RuntimeConfig,
): Promise<CallerScope> {
	if (config.databaseUrl) throw new ControlPlaneError("AUTH_REQUIRED");
	const adapters = createLocalDemoAdapters(config);
	return resolveCallerScope(adapters);
}

export function getTaskService() {
	const config: RuntimeConfig = {
		nodeEnv: process.env.NODE_ENV,
		localDemo: process.env.WEB_LOCAL_DEMO,
		databaseUrl: process.env.DATABASE_URL,
	};
	return createTaskService({
		resolveScope: () => resolveRuntimeScope(config),
		getStore: () => {
			store ??= config.databaseUrl
				? Promise.resolve(createPostgresStore(createDb(config.databaseUrl)))
				: import("./development-store.server").then((module) =>
						module.createDevelopmentStore(config),
					);
			return store;
		},
	});
}
