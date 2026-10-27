import { z } from "zod";

/**
 * Worker configuration. Bounded values only — the worker never runs unbounded
 * loops: poll interval, lease duration, and retry/dead-letter thresholds are
 * explicit. Env reading stays here; no credential values may be logged.
 */
export const workerConfigSchema = z.object({
	workerId: z
		.string()
		.min(1)
		.default(() => `worker_${process.pid}_${Date.now().toString(36)}`),
	pollIntervalMs: z.coerce.number().int().min(50).default(1000),
	leaseSeconds: z.coerce.number().int().min(5).max(3600).default(60),
	maxAttemptsDefault: z.coerce.number().int().min(1).max(50).default(5),
	// Bounded drift guard for expired leases and approval expiry timers.
	reaperIntervalMs: z.coerce.number().int().min(250).default(5000),
	databaseUrl: z.string().min(1).optional(),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

/**
 * Loads worker config from the process environment. Missing DATABASE_URL is
 * allowed at construction (worker reports QUEUE_UNAVAILABLE per tick) but the
 * main loop refuses to claim jobs without one.
 */
export function loadWorkerConfig(
	env: Record<string, string | undefined> = process.env,
): WorkerConfig {
	const parsed = workerConfigSchema.safeParse({
		...(env.WORKER_ID === undefined ? {} : { workerId: env.WORKER_ID }),
		...(env.WORKER_POLL_INTERVAL_MS === undefined
			? {}
			: { pollIntervalMs: env.WORKER_POLL_INTERVAL_MS }),
		...(env.WORKER_LEASE_SECONDS === undefined
			? {}
			: { leaseSeconds: env.WORKER_LEASE_SECONDS }),
		...(env.WORKER_MAX_ATTEMPTS === undefined
			? {}
			: { maxAttemptsDefault: env.WORKER_MAX_ATTEMPTS }),
		...(env.DATABASE_URL === undefined
			? {}
			: { databaseUrl: env.DATABASE_URL }),
	});
	if (!parsed.success) {
		throw new Error("worker config invalid: check WORKER_* environment values");
	}
	return parsed.data;
}
