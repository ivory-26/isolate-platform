import { createConsoleLogger } from "@isolate/shared";
import {
	createOfflineWorkerDeps,
	type WorkerCompositionOverrides,
} from "./composition";
import { loadWorkerConfig } from "./config";
import type { JobHandler, WorkerDeps, WorkerLoop } from "./contracts";
import { createUnavailableQueue, createWorkerLoop } from "./loop";
import { createConfiguredWorkerComposition } from "./runtime-composition";

/**
 * Worker entry point.
 *
 * `bootstrapWorkers` composes the real durable loop (see `loop.ts`) and the
 * `run_task` handler. `main` binds the configured composition first: the
 * database queue, usage sink and task-context loader are bound whenever
 * DATABASE_URL exists, and Modal/Baseten adapters only when their provider
 * variables opt in. Without a database the loop still runs against the
 * fail-closed unavailable queue.
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
	const composition = await createConfiguredWorkerComposition(config, logger);
	logger.info("worker adapters configured", {
		sandboxProvider: composition.providerName,
		inferenceProvider: composition.inferenceProvider,
		queueBound: composition.queue !== undefined,
		taskContextBound: composition.overrides.loadTaskContext !== undefined,
		usageSinkBound: composition.overrides.usageSink !== undefined,
	});
	const loop = bootstrapWorkers({
		config,
		logger,
		queue: composition.queue,
		taskExecution: composition.overrides,
	});

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
