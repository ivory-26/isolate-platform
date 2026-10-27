import type { Logger } from "@isolate/shared";
import { errorCodeOf } from "@isolate/shared";
import type { QueueLike } from "./contracts";

/**
 * Lease keep-alive for a running handler.
 *
 * Long handlers must not spam the queue: the ticker fires at most once per
 * interval (default: half the lease window) and skips a beat while a previous
 * heartbeat is still in flight. It stops immediately when the lease is lost,
 * the worker aborts, or `stop()` is called.
 */
export type HeartbeatTicker = {
	/** One manual beat (the HandlerContext entry point). */
	heartbeat(): Promise<boolean>;
	/** True while the ticker has not been stopped and the lease still lives. */
	isAlive(): boolean;
	/** Idempotent teardown; clears the interval and stops background beats. */
	stop(): void;
};

export function createHeartbeatTicker(input: {
	queue: QueueLike;
	jobId: string;
	ownerId: string;
	extendSeconds: number;
	logger: Logger;
	signal: AbortSignal;
	/** Called (once) when any beat returns false: the lease is gone. */
	leaseLost(): void;
	/** Override for tests; defaults to half the lease window, min 1s. */
	intervalMs?: number;
}): HeartbeatTicker {
	const {
		queue,
		jobId,
		ownerId,
		extendSeconds,
		logger,
		signal,
		leaseLost,
		intervalMs = Math.max(Math.floor((extendSeconds * 1000) / 2), 1000),
	} = input;

	let stopped = false;
	let inFlight = false;

	const beat = async (): Promise<boolean> => {
		if (stopped || signal.aborted || inFlight) return false;
		inFlight = true;
		try {
			const ok = await queue.heartbeat(jobId, ownerId, extendSeconds);
			if (ok) {
				logger.debug("lease extended", { jobId });
				return true;
			}
			logger.warn("lease lost during heartbeat", { jobId, code: "LEASE_LOST" });
			stop();
			leaseLost();
			return false;
		} catch (error) {
			// A single failed beat must not abort the job; bounded code only.
			logger.warn("heartbeat failed", { jobId, code: errorCodeOf(error) });
			return false;
		} finally {
			inFlight = false;
		}
	};

	const timer = setInterval(() => {
		void beat();
	}, intervalMs);

	// The worker process must not be kept alive by idle tickers.
	timer.unref?.();

	signal.addEventListener(
		"abort",
		() => {
			stop();
		},
		{ once: true },
	);

	function stop(): void {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	}

	return {
		heartbeat: beat,
		isAlive: () => !stopped && !signal.aborted,
		stop,
	};
}
