import "@tanstack/react-start/server-only";
import { createDb } from "@isolate/db";
import { type RuntimeConfig, resolveLocalScope } from "./local-mode.server";
import { createPostgresStore } from "./postgres-store.server";
import { createTaskService, type TaskStore } from "./task-service.server";

let store: Promise<TaskStore> | undefined;
export function getTaskService() {
	const config: RuntimeConfig = {
		nodeEnv: process.env.NODE_ENV,
		localDemo: process.env.WEB_LOCAL_DEMO,
		databaseUrl: process.env.DATABASE_URL,
	};
	return createTaskService({
		// Production fails closed until a real session/membership adapter replaces
		// this resolver. Neither request headers nor caller data is identity.
		resolveScope: async () => resolveLocalScope(config),
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
