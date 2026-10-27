import type { JobRow, QueueRepository } from "@isolate/db";
import type { Logger } from "@isolate/shared";
import type { WorkerConfig } from "./config";

/**
 * Worker contracts: job handlers claim a job, perform bounded work, and return
 * a verdict. Cancellation propagates through the AbortSignal; handlers must be
 * idempotent because leases can expire and redeliver (at-least-once).
 */
export type HandlerContext = {
	logger: Logger;
	signal: AbortSignal;
	/** Lease extension must be called from handlers that run long. */
	heartbeat(): Promise<boolean>;
};

export type HandlerVerdict =
	| { outcome: "complete"; note?: string }
	| {
			outcome: "retry";
			code: string; // bounded ErrorCode; sanitise before shipping
			backoffMs?: number;
	  }
	| { outcome: "dead_letter"; code: string; note?: string };

export interface JobHandler {
	jobType: JobRow["type"];
	/** Pure check before the work starts; a false answer skips the claim. */
	supports(payload: Record<string, unknown>): boolean;
	handle(job: JobRow, ctx: HandlerContext): Promise<HandlerVerdict>;
}

export interface WorkerLoop {
	/** Starts polling; resolves on graceful stop or synchronous throw. */
	start(): Promise<void>;
	stop(reason?: string): Promise<void>;
}

export type WorkerDeps = {
	config: WorkerConfig;
	logger: Logger;
	handlers: JobHandler[];
	// The queue is injected as this interface so tests use in-memory fakes.
	queue: QueueLike;
};

/**
 * Structural subset of QueueRepository the loop relies on. Keeps the claim /
 * heartbeat / ack / fail lifecycle isolated from the full repository surface.
 */
export interface QueueLike {
	claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
	}): Promise<Awaited<ReturnType<QueueRepository["claimNext"]>>>;
	heartbeat(
		jobId: string,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean>;
	ackComplete(
		jobId: string,
		ownerId: string,
	): Promise<Awaited<ReturnType<QueueRepository["ackComplete"]>>>;
	ackFail(input: {
		jobId: string;
		ownerId: string;
		code: string;
		message: string;
	}): Promise<Awaited<ReturnType<QueueRepository["ackFail"]>>>;
	requeueExpiredLeases(nowMs: number): Promise<number>;
}
