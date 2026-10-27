import { createConsoleLogger } from "@isolate/shared";
import { loadWorkerConfig } from "./config";
import type { JobHandler, WorkerDeps, WorkerLoop } from "./contracts";

/**
 * Worker entry point. Sprint B-1 replaces the bootstrapping below with the
 * durable loop: claim → heartbeat → handle → ack, plus lease and approval
 * reapers. This stub exists so the process boots and fails informatively.
 */

export function bootstrapWorkers(
	deps: Omit<WorkerDeps, "handlers" | "queue"> & {
		handlers?: JobHandler[];
	},
): WorkerLoop {
	const { config, logger } = deps;
	return {
		start: async () => {
			logger.error("worker skeleton: no queue implementation bound yet", {
				workerId: config.workerId,
				hint: "implemented in sprint B-1 (apps/worker task)",
			});
		},
		stop: async (reason) => {
			logger.warn("worker stop requested", { reason });
		},
	};
}

const isMain = import.meta.main;
if (isMain) {
	const config = loadWorkerConfig();
	const loop = bootstrapWorkers({
		config,
		logger: createConsoleLogger("isolate-worker").child({
			workerId: config.workerId,
		}),
	});
	await loop.start();
}
