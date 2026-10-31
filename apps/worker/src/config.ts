import {
	workerConfigSchema as sharedWorkerConfigSchema,
	WORKER_CONFIG_DEFAULTS,
} from "@isolate/shared";
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
	/**
	 * Wave 9: bounded in-process job pool. The shared contract allows 1–64;
	 * the worker caps at 16 because the sandbox provider is the real ceiling.
	 */
	maxConcurrency: z.coerce
		.number()
		.int()
		.min(1)
		.max(16)
		.default(WORKER_CONFIG_DEFAULTS.maxConcurrency),
	leaseSeconds: z.coerce.number().int().min(5).max(3600).default(60),
	maxAttemptsDefault: z.coerce.number().int().min(1).max(50).default(5),
	// Bounded drift guard for expired leases and approval expiry timers.
	reaperIntervalMs: z.coerce.number().int().min(250).default(5000),
	// Coerce env strings while retaining the shared timeout bounds and default.
	jobTimeoutMs: z.preprocess(
		(value) => (typeof value === "string" ? Number(value) : value),
		sharedWorkerConfigSchema.shape.jobTimeoutMs,
	),
	// Per-turn / per-task spend caps (worker-local until promoted to shared).
	// Every bound is finite and explicit: no unbounded model or sandbox run.
	maxOutputTokensPerTurn: z.coerce
		.number()
		.int()
		.min(1)
		.max(8192)
		.default(1024),
	maxTokensPerTask: z.coerce
		.number()
		.int()
		.min(1_000)
		// Operator setting (2026-10-31): 1M tokens per task by default, with
		// 200M kept as the schema ceiling. The USD cap (maxCostUsdPerTask)
		// remains the real spend guard; this bound only stops a runaway loop.
		.max(200_000_000)
		.default(1_000_000),
	maxSandboxSeconds: z.coerce.number().int().min(60).max(3600).default(900),
	// USD; zero is allowed (spend disabled) but never negative or non-finite.
	maxCostUsdPerTask: z.coerce.number().min(0).max(100).default(1),
	maxAgentSteps: z.coerce.number().int().min(1).max(50).default(12),
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
		...(env.WORKER_MAX_CONCURRENCY === undefined
			? {}
			: { maxConcurrency: env.WORKER_MAX_CONCURRENCY }),
		...(env.WORKER_LEASE_SECONDS === undefined
			? {}
			: { leaseSeconds: env.WORKER_LEASE_SECONDS }),
		...(env.WORKER_MAX_ATTEMPTS === undefined
			? {}
			: { maxAttemptsDefault: env.WORKER_MAX_ATTEMPTS }),
		...(env.WORKER_JOB_TIMEOUT_MS === undefined
			? {}
			: { jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS }),
		...(env.WORKER_MAX_OUTPUT_TOKENS_PER_TURN === undefined
			? {}
			: { maxOutputTokensPerTurn: env.WORKER_MAX_OUTPUT_TOKENS_PER_TURN }),
		...(env.WORKER_MAX_TOKENS_PER_TASK === undefined
			? {}
			: { maxTokensPerTask: env.WORKER_MAX_TOKENS_PER_TASK }),
		...(env.WORKER_MAX_SANDBOX_SECONDS === undefined
			? {}
			: { maxSandboxSeconds: env.WORKER_MAX_SANDBOX_SECONDS }),
		...(env.WORKER_MAX_COST_USD_PER_TASK === undefined
			? {}
			: { maxCostUsdPerTask: env.WORKER_MAX_COST_USD_PER_TASK }),
		...(env.WORKER_MAX_AGENT_STEPS === undefined
			? {}
			: { maxAgentSteps: env.WORKER_MAX_AGENT_STEPS }),
		...(env.DATABASE_URL === undefined
			? {}
			: { databaseUrl: env.DATABASE_URL }),
	});
	if (!parsed.success) {
		throw new Error("worker config invalid: check WORKER_* environment values");
	}
	return parsed.data;
}
