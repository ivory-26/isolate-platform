import { createConsoleLogger } from "@isolate/shared";
import {
	createOfflineWorkerDeps,
	type WorkerCompositionOverrides,
} from "./composition";
import { loadWorkerConfig } from "./config";
import type { JobHandler, WorkerDeps, WorkerLoop } from "./contracts";
import { createUnavailableQueue, createWorkerLoop } from "./loop";

/**
 * Worker entry point.
 *
 * `bootstrapWorkers` composes the real durable loop (see `loop.ts`). The
 * database-backed `QueueRepository` is owned by @isolate/db (Sprint A); until
 * it is bound here the loop runs against a fail-closed unavailable queue and
 * reports QUEUE_UNAVAILABLE per tick.
 *
 * The `run_task` handler is always registered from the offline composition
 * (`composition.ts`): it boots with zero provider env, defaults to
 * `NullProvider`, and only fails at execution time with a bounded
 * MISSING_CONFIG until W4-OPS injects real adapters via `taskExecution`.
 *
 * Signal handling: INT/TERM translate to `loop.stop()`; the loop aborts
 * every in-flight handler via its AbortSignal and resolves bounded.
 */
export function bootstrapWorkers(
	deps: Omit<WorkerDeps, "handlers" | "queue"> & {
		handlers?: JobHandler[];
		queue?: WorkerDeps["queue"];
		/** Adapter overrides for the default `run_task` composition. */
		taskExecution?: WorkerCompositionOverrides;
	},
): WorkerLoop {
	const { config, logger, queue, taskExecution } = deps;
	const handlers =
		deps.handlers ??
		createOfflineWorkerDeps(config, logger, taskExecution).handlers;

	if (!queue) {
		logger.warn("worker starting without a bound queue; claims fail closed", {
			workerId: config.workerId,
			databaseConfigured: Boolean(config.databaseUrl),
		});
	}

	return createWorkerLoop({
		config,
		logger,
		handlers,
		queue:
			queue ??
			createUnavailableQueue(
				config.databaseUrl
					? "queue unavailable: no database queue implementation bound yet"
					: "queue unavailable: DATABASE_URL is not configured",
			),
	});
}

const isMain = import.meta.main;
if (isMain) {
	const config = loadWorkerConfig();
	const logger = createConsoleLogger("isolate-worker").child({
		workerId: config.workerId,
	});
	const loop = bootstrapWorkers({ config, logger });

	let stopping = false;
	const requestStop = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		void loop.stop(`signal ${signal}`);
	};
	process.on("SIGINT", () => requestStop("SIGINT"));
	process.on("SIGTERM", () => requestStop("SIGTERM"));
	process.on("uncaughtException", (error: unknown) => {
		// Bounded, sanitised reporting; unknown errors collapse to INTERNAL.
		logger.error("uncaught exception; stopping worker", {
			code:
				error && typeof error === "object" && "code" in error
					? String(error.code)
					: "INTERNAL",
		});
		requestStop("uncaughtException");
	});

	await loop.start();
}
