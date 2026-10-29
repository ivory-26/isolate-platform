import type { JobRow } from "@isolate/db";
import { errorCodeOf, type Logger, PlatformError } from "@isolate/shared";
import type {
	HandlerContext,
	HandlerVerdict,
	JobHandler,
	WorkerDeps,
	WorkerLoop,
} from "./contracts";
import { createHeartbeatTicker } from "./heartbeat";
import { clampErrorCode, sanitizeMessage, toAckError } from "./sanitize";

/**
 * Durable worker loop.
 *
 * Lifecycle per claimed job:
 *   claim → lease ctx (heartbeat ticker + abort signal linked to stop) →
 *   handler → "complete" → ackComplete
 *           "retry"/"dead_letter" → ackFail (requeue decision is the queue's)
 *
 * Bounds:
 * - one claim per poll tick, `pollIntervalMs` idle between ticks
 * - one in-flight job at a time (strict, so lease/ack ownership is unambiguous)
 * - heartbeat ticker at most every half lease window, never overlapping
 * - reaper runs at `reaperIntervalMs` with an overlap guard
 * - a handler that ignores its AbortSignal is cut at `jobTimeoutMs` and
 *   ack-failed with BUDGET_EXCEEDED (execution time is never unbounded)
 * - stop() resolves within STOP_DRAIN_TIMEOUT_MS even if a handler hangs
 */

/** Max wait for stop() resolution when a handler refuses to settle. */
const STOP_DRAIN_TIMEOUT_MS = 10_000;

export type WorkerEvent =
	| { kind: "claimed"; jobId: string }
	| { kind: "completed"; jobId: string }
	| { kind: "failed"; jobId: string; code: string; requeued: boolean };

type EventSink = (event: WorkerEvent) => void;

/** Sleep that resolves on either the delay elapsing or the signal aborting. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => finish(), ms);
		timer.unref?.();
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		signal.addEventListener("abort", finish, { once: true });
	});
}

/** Plain (non-abortable) hard-timeout ticket used to bound handler runtime. */
function makeTimeoutTicket(ms: number): {
	promise: Promise<true>;
	cancel(): void;
} {
	let resolveTimeout: (() => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
		timer = null;
		resolveTimeout?.();
	}, ms);
	timer.unref?.();
	return {
		promise: new Promise<true>((resolve) => {
			resolveTimeout = () => resolve(true);
		}),
		cancel(): void {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}

/**
 * Fallback queue used when no database-backed queue is bound (Sprint A owns
 * the real implementation). Claims fail closed with QUEUE_UNAVAILABLE so the
 * loop reports the missing configuration per tick instead of misbehaving.
 */
export function createUnavailableQueue(reason: string): WorkerDeps["queue"] {
	const refuse = (): Promise<never> => {
		return Promise.reject(new PlatformError("QUEUE_UNAVAILABLE", reason));
	};
	return {
		claimNext: () => refuse(),
		heartbeat: async () => false,
		ackComplete: () => refuse(),
		ackFail: () => refuse(),
		requeueExpiredLeases: async () => 0,
	};
}

export function createWorkerLoop(
	deps: WorkerDeps & {
		/**
		 * Test seam: hard per-job budget override. Retained only for tests that
		 * need sub-bound determinism (e.g. 60ms, below the config min of 1000ms);
		 * it takes precedence over the parsed config budget.
		 */
		jobTimeoutMs?: number;
		/** Optional structured event sink for integration/test observability. */
		onEvent?: EventSink;
	},
): WorkerLoop {
	const { config, logger, handlers, queue } = deps;
	const jobTimeoutMs = deps.jobTimeoutMs ?? config.jobTimeoutMs;
	const onEvent: EventSink = deps.onEvent ?? (() => {});

	const handlersByType = new Map<JobRow["type"], JobHandler>();
	for (const handler of handlers) {
		if (handlersByType.has(handler.jobType)) {
			logger.warn("duplicate handler for job type; last registration wins", {
				jobType: handler.jobType,
			});
		}
		handlersByType.set(handler.jobType, handler);
	}

	const stopController = new AbortController();
	let runPromise: Promise<void> | null = null;

	const settle = async <T>(
		promise: Promise<T>,
		context: string,
		jobLogger: Logger,
	): Promise<T | null> => {
		try {
			return await promise;
		} catch (error) {
			// Ack/queue failures are never fatal to the loop: bounded code only.
			jobLogger.warn("queue call failed", {
				context,
				code: errorCodeOf(error),
			});
			return null;
		}
	};

	async function processJob(job: JobRow): Promise<void> {
		const jobLogger = logger.child({ jobId: job.id, jobType: job.type });
		const handler = handlersByType.get(job.type);
		if (!handler) {
			jobLogger.warn("no handler registered for job type", {
				jobType: job.type,
			});
			await settle(
				queue.ackFail({
					jobId: job.id,
					ownerId: config.workerId,
					code: "NOT_FOUND",
					message: `no handler registered for job type ${job.type}`,
				}),
				"ackFail",
				jobLogger,
			);
			return;
		}

		// supports() is a pure pre-work check on the claimed payload: a false
		// answer never runs the handler.
		if (!handler.supports(job.payload)) {
			jobLogger.warn("payload rejected by handler supports() check");
			await settle(
				queue.ackFail({
					jobId: job.id,
					ownerId: config.workerId,
					code: "VALIDATION_FAILED",
					message: "job payload rejected by handler",
				}),
				"ackFail",
				jobLogger,
			);
			return;
		}

		const jobController = new AbortController();
		const abortJob = (): void => jobController.abort();
		stopController.signal.addEventListener("abort", abortJob, { once: true });
		try {
			const ticker = createHeartbeatTicker({
				queue,
				jobId: job.id,
				ownerId: config.workerId,
				extendSeconds: config.leaseSeconds,
				logger: jobLogger,
				signal: jobController.signal,
				leaseLost: () => abortJob(),
			});

			const ctx: HandlerContext = {
				logger: jobLogger,
				signal: jobController.signal,
				heartbeat: () => ticker.heartbeat(),
			};

			const attempt = handler
				.handle(job, ctx)
				.then(
					(
						verdict,
					):
						| { ok: true; verdict: HandlerVerdict }
						| { ok: false; error: unknown } => ({
						ok: true,
						verdict,
					}),
				)
				.catch((error: unknown): { ok: false; error: unknown } => ({
					ok: false,
					error,
				}));

			const budget = makeTimeoutTicket(jobTimeoutMs);
			const raced = await Promise.race([attempt, budget.promise]);
			budget.cancel();

			if (raced === true) {
				// Handler ignored its signal past the hard budget: cut it off.
				jobLogger.error("job exceeded execution budget; failing", {
					jobTimeoutMs,
				});
				jobController.abort();
				void attempt.catch(() => null); // swallow the abandoned attempt
				await settle(
					queue.ackFail({
						jobId: job.id,
						ownerId: config.workerId,
						code: "BUDGET_EXCEEDED",
						message: `handler exceeded the ${jobTimeoutMs}ms execution budget`,
					}),
					"ackFail",
					jobLogger,
				);
				return;
			}

			ticker.stop();

			if (!raced.ok) {
				const ack = toAckError(raced.error);
				jobLogger.error("handler threw; mapped to bounded code", {
					code: ack.code,
				});
				await settle(
					queue.ackFail({
						jobId: job.id,
						ownerId: config.workerId,
						code: ack.code,
						message: ack.message,
					}),
					"ackFail",
					jobLogger,
				);
				return;
			}

			const verdict = raced.verdict;
			if (verdict.outcome === "complete") {
				jobLogger.info("job completed", { note: verdict.note });
				onEvent({ kind: "completed", jobId: job.id });
				const result = await settle(
					queue.ackComplete(job.id, config.workerId),
					"ackComplete",
					jobLogger,
				);
				if (result !== null && result.ok === false) {
					jobLogger.warn("ackComplete rejected", { queueCode: result.code });
				}
				return;
			}

			// "retry" and "dead_letter" both go through ackFail: whether the job
			// is requeued or dead-lettered is the queue's decision (attempts vs
			// task budget), never the handler's.
			const code = clampErrorCode(verdict.code);
			const note = verdict.outcome === "dead_letter" ? verdict.note : undefined;
			const message =
				sanitizeMessage(note ?? "") ||
				`${verdict.outcome} requested by handler`;
			const result = await settle(
				queue.ackFail({
					jobId: job.id,
					ownerId: config.workerId,
					code,
					message,
				}),
				"ackFail",
				jobLogger,
			);
			const requeued = result?.ok === true ? result.requeued : false;
			jobLogger.warn("job failed", { code, requeued });
			onEvent({ kind: "failed", jobId: job.id, code, requeued });
		} finally {
			stopController.signal.removeEventListener("abort", abortJob);
		}
	}

	async function run(): Promise<void> {
		// Reaper ticker: expired leases are requeued on a timer, with an
		// overlap guard so a slow reaper never stacks calls.
		let reaping = false;
		const reaper = setInterval(() => {
			if (reaping || stopController.signal.aborted) return;
			reaping = true;
			void queue
				.requeueExpiredLeases(Date.now())
				.then((count) => {
					if (count > 0) {
						logger.info("requeued expired leases", { count });
					}
				})
				.catch((error: unknown) => {
					logger.warn("reaper failed", { code: errorCodeOf(error) });
				})
				.finally(() => {
					reaping = false;
				});
		}, config.reaperIntervalMs);
		reaper.unref?.();

		try {
			while (!stopController.signal.aborted) {
				let job: JobRow | null;
				try {
					job = await queue.claimNext({
						ownerId: config.workerId,
						leaseSeconds: config.leaseSeconds,
					});
				} catch (error) {
					// Queue/database unavailability is reported per tick with a
					// bounded code; no retry storm (the poll interval is the bound).
					logger.error("worker tick failed", { code: errorCodeOf(error) });
					job = null;
				}
				if (job) {
					onEvent({ kind: "claimed", jobId: job.id });
					// Inline await keeps single in-flight concurrency; stop() only
					// resolves after the current job settles or its drain deadline.
					await processJob(job);
				}
				await sleepAbortable(config.pollIntervalMs, stopController.signal);
			}
		} finally {
			clearInterval(reaper);
		}
	}

	function start(): Promise<void> {
		runPromise ??= run();
		return runPromise;
	}

	function stop(reason?: string): Promise<void> {
		logger.info("worker stop requested", { reason: reason ?? "unspecified" });
		stopController.abort();
		// Bounded stop: normally runPromise unwinds immediately (every wait in
		// the schedule aborts); if a handler refuses to settle within the drain
		// budget, stop() still returns, leaving the loop to unwind in background.
		const drain = sleepAbortable(
			STOP_DRAIN_TIMEOUT_MS,
			new AbortController().signal,
		);
		return Promise.race([start(), drain]);
	}

	return { start, stop };
}
