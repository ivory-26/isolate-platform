import { describe, expect, test } from "bun:test";
import type { JobRow } from "@isolate/db";
import type {
	JobId,
	LogFields,
	Logger,
	OrganizationId,
	TaskId,
} from "@isolate/shared";
import { PlatformError } from "@isolate/shared";
import { loadWorkerConfig, workerConfigSchema } from "./config";
import type { HandlerVerdict, JobHandler, QueueLike } from "./contracts";
import { createHeartbeatTicker } from "./heartbeat";
import { createWorkerLoop } from "./loop";
import { clampErrorCode, sanitizeMessage, toAckError } from "./sanitize";

/* ---------------------------------- fakes --------------------------------- */

type LogRecord = { severity: string; message: string; fields: LogFields };

function makeFakingLogger(sink: LogRecord[]): Logger {
	const make = (base: LogFields): Logger => ({
		debug: (m, f) =>
			sink.push({ severity: "debug", message: m, fields: { ...base, ...f } }),
		info: (m, f) =>
			sink.push({ severity: "info", message: m, fields: { ...base, ...f } }),
		warn: (m, f) =>
			sink.push({ severity: "warn", message: m, fields: { ...base, ...f } }),
		error: (m, f) =>
			sink.push({ severity: "error", message: m, fields: { ...base, ...f } }),
		child: (f) => make({ ...base, ...f }),
	});
	return make({});
}

let jobSeq = 0;

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
	jobSeq += 1;
	const now = new Date().toISOString();
	return {
		id: `job_${jobSeq}` as JobId,
		organizationId: "org_test" as OrganizationId,
		taskId: "task_test" as TaskId,
		type: "run_task",
		payload: { taskId: "task_test" },
		status: "pending",
		attempts: 0,
		maxAttempts: 2,
		lease: null,
		notBefore: now,
		enqueueUuidKey: `enqueue_${jobSeq}`,
		lastError: null,
		createdAt: now,
		...overrides,
	};
}

/**
 * In-memory QueueLike fake mirroring the documented @isolate/db semantics:
 * atomic claim, ownership-checked heartbeat/ack, attempts-based
 * retry-vs-dead-letter decision inside ackFail, lease-expiry requeue.
 *
 * The clock follows real time by default so jobs created by `makeJob()` after
 * queue construction remain claimable on every tick. A test may assign `now`
 * explicitly (reads the current value, adds a delta); the assignment freezes
 * the clock deterministically for expiry scenarios.
 */
class FakeQueue implements QueueLike {
	private manualNow: number | null = null;

	get now(): number {
		return this.manualNow ?? Date.now();
	}

	set now(value: number) {
		this.manualNow = value;
	}

	jobs: JobRow[] = [];
	backoffMs = 0;

	claimNextCalls = 0;
	heartbeats: Array<{ jobId: string; ownerId: string }> = [];
	heartbeatOutcome: "ok" | "lost" | "throw" = "ok";
	ackCompletes: string[] = [];
	ackFails: Array<{ jobId: string; code: string; message: string }> = [];
	requeues = 0;

	async claimNext(input: {
		ownerId: string;
		leaseSeconds: number;
	}): Promise<JobRow | null> {
		this.claimNextCalls += 1;
		const candidate = this.jobs.find(
			(job) =>
				job.status === "pending" &&
				Date.parse(job.notBefore) <= this.now &&
				(job.lease == null || Date.parse(job.lease.leaseExpiresAt) <= this.now),
		);
		if (!candidate) return null;
		candidate.status = "claimed";
		candidate.attempts += 1;
		candidate.lease = {
			ownerId: input.ownerId,
			leaseExpiresAt: new Date(
				this.now + input.leaseSeconds * 1000,
			).toISOString(),
		};
		return structuredClone(candidate);
	}

	async heartbeat(
		jobId: string,
		ownerId: string,
		extendSeconds: number,
	): Promise<boolean> {
		this.heartbeats.push({ jobId, ownerId });
		if (this.heartbeatOutcome === "throw") throw new Error("db blip (fake)");
		const job = this.findOwned(jobId, ownerId);
		if (job && this.heartbeatOutcome === "lost") {
			// A failed beat is lease loss: the job leaves this owner's control,
			// so an ack submitted afterwards must be rejected (LEASE_LOST).
			job.lease = null;
			return false;
		}
		if (!job) return false;
		job.lease = {
			ownerId,
			leaseExpiresAt: new Date(this.now + extendSeconds * 1000).toISOString(),
		};
		return true;
	}

	async ackComplete(
		jobId: string,
		ownerId: string,
	): Promise<{ ok: true } | { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }> {
		const job = this.findOwned(jobId, ownerId);
		if (!job) return { ok: false, code: "LEASE_LOST" };
		this.ackCompletes.push(jobId);
		job.status = "done";
		job.lease = null;
		return { ok: true };
	}

	async ackFail(input: {
		jobId: string;
		ownerId: string;
		code: string;
		message: string;
	}): Promise<
		| { ok: true; requeued: boolean }
		| { ok: false; code: "NOT_FOUND" | "LEASE_LOST" }
	> {
		const job = this.findOwned(input.jobId, input.ownerId);
		if (!job) return { ok: false, code: "LEASE_LOST" };
		this.ackFails.push({
			jobId: input.jobId,
			code: input.code,
			message: input.message,
		});
		job.lastError = { code: input.code, message: input.message };
		job.lease = null;
		if (job.attempts < job.maxAttempts) {
			job.status = "pending";
			job.notBefore = new Date(this.now + this.backoffMs).toISOString();
			return { ok: true, requeued: true };
		}
		job.status = "dead_letter";
		return { ok: true, requeued: false };
	}

	async requeueExpiredLeases(nowMs: number): Promise<number> {
		this.requeues += 1;
		let count = 0;
		for (const job of this.jobs) {
			if (
				job.status === "claimed" &&
				job.lease != null &&
				Date.parse(job.lease.leaseExpiresAt) <= nowMs
			) {
				job.status = "pending";
				job.lease = null;
				count += 1;
			}
		}
		return count;
	}

	private findOwned(jobId: string, ownerId: string): JobRow | null {
		const job = this.jobs.find((candidate) => candidate.id === jobId);
		if (job == null || job.lease == null) return null;
		if (job.lease.ownerId !== ownerId) return null;
		if (Date.parse(job.lease.leaseExpiresAt) <= this.now) return null;
		return job;
	}
}

/* --------------------------------- harness -------------------------------- */

type Harness = {
	queue: FakeQueue;
	logs: LogRecord[];
	events: Array<Record<string, unknown>>;
	started: Promise<void>;
	stop(reason?: string): Promise<void>;
};

function makeHarness(
	handlers: JobHandler[],
	options: {
		pollIntervalMs?: number;
		leaseSeconds?: number;
		reaperIntervalMs?: number;
		/** Wave 9: in-process pool size (config.maxConcurrency). */
		maxConcurrency?: number;
		/** Dep-level test seam: hard override of the parsed budget. */
		jobTimeoutMs?: number;
		/** Parsed WorkerConfig value: the production precedence path. */
		configJobTimeoutMs?: number;
		maxAttemptsDefault?: number;
	} = {},
): Harness {
	const queue = new FakeQueue();
	const logs: LogRecord[] = [];
	const events: Array<Record<string, unknown>> = [];
	const workerPollIntervalMs = options.pollIntervalMs ?? 50;
	const leaseSeconds = options.leaseSeconds ?? 5;
	const loop = createWorkerLoop({
		config: workerConfigSchema.parse({
			workerId: "test-worker",
			pollIntervalMs: workerPollIntervalMs,
			leaseSeconds,
			maxAttemptsDefault: options.maxAttemptsDefault ?? 5,
			reaperIntervalMs: options.reaperIntervalMs ?? 10_000, // off by default
			jobTimeoutMs: options.configJobTimeoutMs,
			...(options.maxConcurrency === undefined
				? {}
				: { maxConcurrency: options.maxConcurrency }),
		}),
		logger: makeFakingLogger(logs),
		handlers,
		queue,
		jobTimeoutMs: options.jobTimeoutMs,
		onEvent: (event) => events.push({ ...event }),
	});
	return {
		queue,
		logs,
		events,
		started: loop.start(),
		stop: (reason?: string) => loop.stop(reason),
	};
}

async function eventually(
	condition: () => boolean,
	timeoutMs = 2000,
	stepMs = 5,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline)
			throw new Error("condition not met within budget");
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

/* ---------------------------------- tests --------------------------------- */

describe("worker loop — happy path", () => {
	test("claims, runs handler, acks completion", async () => {
		const handleCalls: string[] = [];
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async (job, ctx) => {
				expect(ctx.signal.aborted).toBe(false);
				handleCalls.push(job.id);
				return { outcome: "complete", note: "did the work" };
			},
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob());
		await eventually(
			() =>
				harness.queue.jobs[0]?.status === "done" && handleCalls.length === 1,
		);
		expect(harness.queue.claimNextCalls).toBeGreaterThanOrEqual(1);
		expect(harness.queue.ackCompletes).toEqual([harness.queue.jobs[0].id]);
		expect(harness.queue.ackFails).toEqual([]);
		const claimed = harness.events.filter((event) => event.kind === "claimed");
		const completed = harness.events.filter(
			(event) => event.kind === "completed",
		);
		expect(claimed.length).toBe(1);
		expect(completed.length).toBe(1);
		await harness.stop("test done");
	});

	test("graceful stop halts polling within a bounded drain", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => ({ outcome: "complete" }),
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob());
		await eventually(() => harness.queue.ackCompletes.length === 1);
		const claimsAtStop = harness.queue.claimNextCalls;
		await harness.stop("clean");
		const claimsAfter = harness.queue.claimNextCalls;
		await new Promise((resolve) => setTimeout(resolve, 250)); // 3+ poll intervals
		expect(harness.queue.claimNextCalls).toBe(claimsAfter);
		expect(claimsAfter - claimsAtStop).toBeLessThanOrEqual(1);
		expect(
			harness.logs.some((log) => log.message === "worker stop requested"),
		).toBe(true);
	});
});

describe("worker loop — failure ordering", () => {
	test("retry verdict acks fail; queue requeues then dead-letters by attempts", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => ({
				outcome: "retry",
				code: "AGENT_EXECUTION_FAILED",
				backoffMs: 10,
			}),
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob({ maxAttempts: 2 }));
		await eventually(
			() =>
				harness.queue.jobs[0]?.status === "dead_letter" &&
				harness.queue.jobs[0]?.attempts === 2,
		);
		expect(harness.queue.ackFails.length).toBe(2); // queue decided both times
		expect(harness.queue.ackFails[0]?.code).toBe("AGENT_EXECUTION_FAILED");
		expect(await harness.stop("done")).toBeUndefined();
	});

	test("dead_letter verdict flows through ackFail once per attempt", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => ({
				outcome: "dead_letter",
				code: "POLICY_DENIED",
				note: "bad",
			}),
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob({ maxAttempts: 1 }));
		await eventually(() => harness.queue.jobs[0]?.status === "dead_letter");
		expect(harness.queue.ackFails.length).toBe(1);
		expect(harness.queue.ackFails[0]?.message).toBe("bad");
		await harness.stop("done");
	});

	test("unknown handler throw maps to INTERNAL with no payload leak", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => {
				throw new TypeError(
					"boom https://user:token123@db.internal/admin?api_key=zzz\n at stackFrame",
				);
			},
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob({ maxAttempts: 1 }));
		await eventually(() => harness.queue.jobs[0]?.status === "dead_letter");
		const fail = harness.queue.ackFails[0];
		expect(fail?.code).toBe("INTERNAL");
		expect(fail?.message).toBe("internal handler failure (details withheld)");
		expect(fail?.message).not.toContain("https");
		await harness.stop("done");
	});

	test("handler supports() false never invokes handle()", async () => {
		let handleRan = false;
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => false,
			handle: async () => {
				handleRan = true;
				return { outcome: "complete" };
			},
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob({ maxAttempts: 2 }));
		await eventually(() => harness.queue.jobs[0]?.status === "dead_letter");
		expect(handleRan).toBe(false);
		expect(harness.queue.ackFails[0]?.code).toBe("VALIDATION_FAILED");
		expect(harness.queue.ackFails.length).toBe(2); // redelivered, not retried in loop
		await harness.stop("done");
	});

	test("job with no registered handler acks fail NOT_FOUND", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => ({ outcome: "complete" }),
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(
			makeJob({ type: "finalize_review", maxAttempts: 1 }),
		);
		await eventually(() => harness.queue.jobs[0]?.status === "dead_letter");
		expect(harness.queue.ackFails[0]?.code).toBe("NOT_FOUND");
		await harness.stop("done");
	});
});

describe("worker loop — lease lifecycle", () => {
	test("heartbeat false aborts the handler signal and ack is rejected", async () => {
		let sawAborted = false;
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async (_job, ctx) => {
				const ok = await ctx.heartbeat();
				sawAborted = !ok && ctx.signal.aborted;
				return { outcome: "complete" }; // stale ack attempt
			},
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob());
		harness.queue.heartbeatOutcome = "lost";
		await eventually(() => sawAborted);
		await eventually(() => harness.queue.jobs[0]?.status === "claimed"); // ack rejected
		expect(harness.queue.ackCompletes).toEqual([]);
		await harness.stop("done");
	});

	test("expired lease is requeued, redelivered to another claim, old ack fails", async () => {
		let attempt = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => {
				attempt += 1;
				if (attempt === 1) {
					await gate;
					return { outcome: "complete" };
				}
				return { outcome: "complete", note: "after redelivery" };
			},
		};
		const harness = makeHarness([handler]);
		harness.queue.jobs.push(makeJob());
		await eventually(() => harness.queue.jobs[0]?.status === "claimed");

		// Lease expires: advance the fake clock and run the reaper explicitly
		// (exactly what queue.requeueExpiredLeases(Date.now()) does in prod).
		harness.queue.now += 10_000;
		const requeuedCount = await harness.queue.requeueExpiredLeases(
			harness.queue.now,
		);
		expect(requeuedCount).toBe(1);
		expect(harness.queue.jobs[0]?.status).toBe("pending");

		release();
		await eventually(() => harness.queue.jobs[0]?.attempts === 2);
		await eventually(() => harness.queue.jobs[0]?.status === "done");
		expect(harness.queue.ackCompletes.length).toBe(1);
		await harness.stop("done");
	});

	test("per-job heartbeat ticker keeps leases alive without spamming", async () => {
		const queue = new FakeQueue();
		const logs: LogRecord[] = [];
		const job = makeJob();
		// The ticker stops itself on a lost lease, so the fake queue must hold
		// this job under a live lease owned by the ticker's owner.
		job.lease = {
			ownerId: "test-worker",
			leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		const startedAt = Date.now();
		queue.jobs.push(job);
		const ticker = createHeartbeatTicker({
			queue,
			jobId: job.id,
			ownerId: "test-worker",
			extendSeconds: 5,
			logger: makeFakingLogger(logs),
			signal: new AbortController().signal,
			leaseLost: () => {},
			intervalMs: 15,
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		const beats = queue.heartbeats.length;
		expect(beats).toBeGreaterThanOrEqual(2);
		// Anti-spam property: one beat per configured interval at most, with slack
		// for scheduler jitter. A fixed cap fails on slow CI runners (wall-clock
		// scheduling produces more 15ms windows than on a fast dev machine), so
		// bound by actually-elapsed time at interval granularity instead.
		const elapsedMs = Date.now() - startedAt;
		expect(beats).toBeLessThanOrEqual(Math.ceil(elapsedMs / 15) + 3);
		ticker.stop();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(queue.heartbeats.length).toBe(beats);
	});

	test("ticker stops permanently on lease loss and fires leaseLost once", async () => {
		const queue = new FakeQueue();
		let lostCount = 0;
		const controller = new AbortController();
		const ticker = createHeartbeatTicker({
			queue,
			jobId: "x" as JobId,
			ownerId: "test-worker",
			extendSeconds: 5,
			logger: makeFakingLogger([]),
			signal: controller.signal,
			leaseLost: () => {
				lostCount += 1;
				controller.abort(); // mirrors the loop wiring: the worker aborts the job on lease loss
			},
			intervalMs: 15,
		});
		queue.heartbeatOutcome = "lost";
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(lostCount).toBe(1);
		expect(controller.signal.aborted).toBe(true);
		expect(ticker.isAlive()).toBe(false);
		const beats = queue.heartbeats.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(queue.heartbeats.length).toBe(beats);
	});

	test("heartbeat queue error is swallowed and bounded", async () => {
		const queue = new FakeQueue();
		const controller = new AbortController();
		// The first beat must be true: give the fake queue a job currently
		// leased by this owner (a live lease is what makes a heartbeat succeed).
		const leased = makeJob({ id: "x" as JobId });
		leased.lease = {
			ownerId: "test-worker",
			leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		queue.jobs.push(leased);
		const ok = await createHeartbeatTicker({
			queue,
			jobId: "x" as JobId,
			ownerId: "test-worker",
			extendSeconds: 5,
			logger: makeFakingLogger([]),
			signal: controller.signal,
			leaseLost: () => {},
			intervalMs: 15,
		}).heartbeat();
		queue.heartbeatOutcome = "throw";
		const second = await createHeartbeatTicker({
			queue,
			jobId: "y" as JobId,
			ownerId: "test-worker",
			extendSeconds: 5,
			logger: makeFakingLogger([]),
			signal: controller.signal,
			leaseLost: () => {},
			intervalMs: 15,
		}).heartbeat();
		expect(ok).toBe(true);
		expect(second).toBe(false);
		expect(controller.signal.aborted).toBe(false);
	});
});

describe("worker loop — bounds and unavailable queue", () => {
	test("handler that ignores its signal is cut at the job budget", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => {
				// Pretend to hang; a well-behaved handler would settle on abort,
				// this one ignores it until the hard budget cuts it.
				return new Promise<HandlerVerdict>(() => undefined);
			},
		};
		const harness = makeHarness([handler], { jobTimeoutMs: 60 });
		harness.queue.jobs.push(makeJob({ maxAttempts: 1 }));
		await eventually(() => harness.queue.ackFails.length === 1);
		expect(harness.queue.ackFails[0]?.code).toBe("BUDGET_EXCEEDED");
		expect(harness.queue.ackFails[0]?.message).toBe(
			"handler exceeded the 60ms execution budget",
		);
		expect(harness.queue.jobs[0]?.status).toBe("dead_letter");
		await harness.stop("done");
	});

	test("loop with unavailable queue reports QUEUE_UNAVAILABLE per tick and stops bounded", async () => {
		const logs: LogRecord[] = [];
		const loop = createWorkerLoop({
			config: workerConfigSchema.parse({
				workerId: "test-worker",
				pollIntervalMs: 50,
				leaseSeconds: 5,
				maxAttemptsDefault: 5,
				reaperIntervalMs: 10_000,
			}),
			logger: makeFakingLogger(logs),
			handlers: [],
			queue: {
				claimNext: async () => {
					throw new PlatformError(
						"QUEUE_UNAVAILABLE",
						"queue unavailable: no queue bound",
					);
				},
				heartbeat: async () => false,
				ackComplete: async () => ({ ok: false, code: "NOT_FOUND" }),
				ackFail: async () => ({ ok: false, code: "NOT_FOUND" }),
				requeueExpiredLeases: async () => 0,
			},
		});
		const started = loop.start();
		await eventually(() =>
			logs.some(
				(log) =>
					log.message === "worker tick failed" &&
					log.fields.code === "QUEUE_UNAVAILABLE",
			),
		);
		let stopped = false;
		void loop.stop("shut").then(() => {
			stopped = true;
		});
		await eventually(() => stopped);
		await expect(started.then(() => "ok")).resolves.toBe("ok");
	});
});

describe("worker loop — per-job timeout sourcing", () => {
	const hangingHandler = (signals: AbortSignal[] = []): JobHandler => ({
		jobType: "run_task",
		supports: () => true,
		handle: async (_job, ctx) => {
			signals.push(ctx.signal);
			return new Promise<HandlerVerdict>(() => undefined);
		},
	});

	test("config-supplied jobTimeoutMs is honored end-to-end via BUDGET_EXCEEDED", async () => {
		const signals: AbortSignal[] = [];
		const harness = makeHarness([hangingHandler(signals)], {
			configJobTimeoutMs: 1500,
		});
		const job = makeJob({ maxAttempts: 1 });
		try {
			harness.queue.jobs.push(job);
			await eventually(() => harness.queue.ackFails.length === 1, 4000);
			expect(harness.queue.ackFails).toEqual([
				{
					jobId: job.id,
					code: "BUDGET_EXCEEDED",
					message: "handler exceeded the 1500ms execution budget",
				},
			]);
			expect(signals).toHaveLength(1);
			expect(signals[0]?.aborted).toBe(true);
			expect(harness.queue.ackCompletes).toEqual([]);
			expect(job.status).toBe("dead_letter");
			expect(
				harness.logs.some(
					(log) =>
						log.message === "job exceeded execution budget; failing" &&
						log.fields.jobTimeoutMs === 1500,
				),
			).toBe(true);
		} finally {
			await harness.stop("done");
		}
	});

	test("dep-level test seam takes precedence over the config value", async () => {
		// Sub-bound budgets remain a test seam, never a production config value.
		const harness = makeHarness([hangingHandler()], {
			configJobTimeoutMs: 1500,
			jobTimeoutMs: 60,
		});
		try {
			harness.queue.jobs.push(makeJob({ maxAttempts: 1 }));
			await eventually(() => harness.queue.ackFails.length === 1);
			expect(harness.queue.ackFails[0]?.code).toBe("BUDGET_EXCEEDED");
			expect(harness.queue.ackFails[0]?.message).toBe(
				"handler exceeded the 60ms execution budget",
			);
		} finally {
			await harness.stop("done");
		}
	});

	test("env-parsed config (WORKER_JOB_TIMEOUT_MS) flows through loadWorkerConfig into the loop", async () => {
		const config = loadWorkerConfig({ WORKER_JOB_TIMEOUT_MS: "1500" });
		expect(config.jobTimeoutMs).toBe(1500);
		const queue = new FakeQueue();
		const logs: LogRecord[] = [];
		const loop = createWorkerLoop({
			config,
			logger: makeFakingLogger(logs),
			handlers: [hangingHandler()],
			queue,
		});
		queue.jobs.push(makeJob({ maxAttempts: 1 }));
		const started = loop.start();
		try {
			await eventually(() => queue.ackFails.length === 1, 4000);
			expect(queue.ackFails[0]?.code).toBe("BUDGET_EXCEEDED");
			expect(queue.ackFails[0]?.message).toBe(
				"handler exceeded the 1500ms execution budget",
			);
			expect(queue.jobs[0]?.status).toBe("dead_letter");
			expect(queue.ackCompletes).toEqual([]);
		} finally {
			await loop.stop("done");
			await expect(started.then(() => "ok")).resolves.toBe("ok");
		}
	});

	test("parsed default jobTimeoutMs allows a handler to complete within budget", async () => {
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async () => ({ outcome: "complete", note: "fast" }),
		};
		const harness = makeHarness([handler]);
		try {
			harness.queue.jobs.push(makeJob());
			await eventually(() => harness.queue.ackCompletes.length === 1);
			expect(harness.queue.ackFails).toEqual([]);
			expect(
				harness.logs.some((log) =>
					log.message.includes("job exceeded execution budget"),
				),
			).toBe(false);
		} finally {
			await harness.stop("done");
		}
	});
});

describe("worker loop — bounded concurrency (wave 9)", () => {
	function gated() {
		const started: string[] = [];
		const finished: string[] = [];
		let active = 0;
		let peak = 0;
		const releases = new Map<string, () => void>();
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async (job) => {
				active += 1;
				peak = Math.max(peak, active);
				started.push(job.id);
				await new Promise<void>((resolve) => {
					releases.set(job.id, resolve);
				});
				active -= 1;
				finished.push(job.id);
				return { outcome: "complete" };
			},
		};
		return {
			handler,
			started,
			finished,
			releases,
			peak: () => peak,
		};
	}

	test("never exceeds config.maxConcurrency and keeps claiming as slots free", async () => {
		const gate = gated();
		const harness = makeHarness([gate.handler], { maxConcurrency: 2 });
		harness.queue.jobs.push(makeJob(), makeJob(), makeJob());

		await eventually(() => gate.started.length === 2);
		// Pool full: the third job must not start while two are running.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(gate.started).toHaveLength(2);
		expect(gate.peak()).toBe(2);

		gate.releases.get(gate.started[0] as string)?.();
		await eventually(() => gate.started.length === 3);
		expect(gate.peak()).toBe(2);

		for (const id of [...gate.started]) gate.releases.get(id)?.();
		await eventually(() => harness.queue.ackCompletes.length === 3);

		expect(gate.peak()).toBe(2);
		expect(harness.queue.ackFails).toEqual([]);
		await harness.stop("done");
	});

	test("stop() drains every in-flight job before resolving", async () => {
		const aborted: string[] = [];
		const handler: JobHandler = {
			jobType: "run_task",
			supports: () => true,
			handle: async (job, ctx) => {
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) {
						aborted.push(job.id);
						resolve();
						return;
					}
					ctx.signal.addEventListener(
						"abort",
						() => {
							aborted.push(job.id);
							resolve();
						},
						{ once: true },
					);
				});
				return { outcome: "complete" };
			},
		};
		const harness = makeHarness([handler], { maxConcurrency: 3 });
		harness.queue.jobs.push(makeJob(), makeJob(), makeJob());
		await eventually(() => harness.queue.claimNextCalls >= 3);

		await harness.stop("drain");

		expect(aborted).toHaveLength(3);
		const claimsAfterStop = harness.queue.claimNextCalls;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(harness.queue.claimNextCalls).toBe(claimsAfterStop);
	});
});

describe("worker sanitisation — unit", () => {
	test("sanitizeMessage strips URLs and bearer tokens and caps length", () => {
		const out = sanitizeMessage(
			"failed at https://admin:supersecret@db.internal/x?api_key=abc123 with Bearer eyJhbGciOi.verylong prefix",
			40,
		);
		expect(out).not.toContain("https");
		expect(out).not.toContain("supersecret");
		expect(out).not.toContain("eyJhbGciOi");
		expect(out.length).toBeLessThanOrEqual(40);
	});

	test("toAckError keeps PlatformError code but sanitises; unknown collapses to INTERNAL", () => {
		const platform = toAckError(
			new PlatformError(
				"SANDBOX_PROVISION_FAILED",
				"line crash\n at foo\n at bar",
			),
		);
		expect(platform.code).toBe("SANDBOX_PROVISION_FAILED");
		expect(platform.retryable).toBe(true);
		expect(platform.message).not.toContain("\n at ");

		const unknown = toAckError(new Error("raw internals"));
		expect(unknown.code).toBe("INTERNAL");
		expect(unknown.message).toBe("internal handler failure (details withheld)");
	});

	test("clampErrorCode collapses unknown codes", () => {
		expect(clampErrorCode("AGENT_EXECUTION_FAILED")).toBe(
			"AGENT_EXECUTION_FAILED",
		);
		expect(clampErrorCode("MADE_UP_CODE")).toBe("INTERNAL");
	});
});
