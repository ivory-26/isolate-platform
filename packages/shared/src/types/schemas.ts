import { z } from "zod";
import { PlatformError } from "./errors";
import { EVENT_ACTORS } from "./events";
import type { Result } from "./result";
import { canTransition, taskStatusSchema } from "./task-state";
import { parseWith } from "./zod";

/**
 * Request to move a task to a new lifecycle status.
 *
 * `expectedStatus` is the optimistic-concurrency token: callers asserting a
 * current status get the request rejected at the repository guard if the stored
 * status differs (ARCHITECTURE.md §9). `expectedStatus -> to` legality is
 * checked here; the DB-layer transition guard re-checks `actual -> to`, so this
 * schema can never widen the state machine.
 */
export const taskTransitionRequestSchema = z.object({
	taskId: z.string().min(1).max(128),
	expectedStatus: taskStatusSchema.optional(),
	to: taskStatusSchema,
	actor: z.enum(EVENT_ACTORS).optional(),
	reason: z.string().max(500).optional(),
});

export type TaskTransitionRequest = z.infer<typeof taskTransitionRequestSchema>;

/**
 * Shape-validates and transition-checks a status change request.
 * Returns INVALID_TRANSITION when the optimistic status cannot legally move
 * to `to` according to TASK_STATE_TRANSITIONS.
 */
export function parseTaskTransitionRequest(
	input: unknown,
): Result<TaskTransitionRequest, PlatformError> {
	const parsed = parseWith(taskTransitionRequestSchema, input);
	if (!parsed.ok) {
		return parsed;
	}
	const request = parsed.value;
	if (
		request.expectedStatus !== undefined &&
		!canTransition(request.expectedStatus, request.to)
	) {
		return {
			ok: false,
			error: new PlatformError(
				"INVALID_TRANSITION",
				`transition ${request.expectedStatus} -> ${request.to} is not declared`,
			),
		};
	}
	return { ok: true, value: request };
}

/**
 * Worker configuration field types. Values are isolated primitives with hard
 * bounds — no connection strings, no env passthrough — so a misconfigured
 * worker fails fast instead of operating unbounded.
 */
export const WORKER_CONFIG_DEFAULTS = {
	pollIntervalMs: 1000,
	maxConcurrency: 4,
	leaseTtlMs: 30000,
	maxJobAttempts: 3,
	maxAgentTurns: 12,
	maxOutputBytes: 262144,
	repairBudget: 2,
	jobTimeoutMs: 120000,
	networkEgressDefault: "deny",
} as const;

export const workerConfigSchema = z.object({
	pollIntervalMs: z
		.number()
		.int()
		.min(100)
		.max(60000)
		.default(WORKER_CONFIG_DEFAULTS.pollIntervalMs),
	maxConcurrency: z
		.number()
		.int()
		.min(1)
		.max(64)
		.default(WORKER_CONFIG_DEFAULTS.maxConcurrency),
	leaseTtlMs: z
		.number()
		.int()
		.min(5000)
		.max(300000)
		.default(WORKER_CONFIG_DEFAULTS.leaseTtlMs),
	maxJobAttempts: z
		.number()
		.int()
		.min(1)
		.max(10)
		.default(WORKER_CONFIG_DEFAULTS.maxJobAttempts),
	maxAgentTurns: z
		.number()
		.int()
		.min(1)
		.max(50)
		.default(WORKER_CONFIG_DEFAULTS.maxAgentTurns),
	maxOutputBytes: z
		.number()
		.int()
		.min(1024)
		.max(16777216)
		.default(WORKER_CONFIG_DEFAULTS.maxOutputBytes),
	repairBudget: z
		.number()
		.int()
		.min(0)
		.max(5)
		.default(WORKER_CONFIG_DEFAULTS.repairBudget),
	// Per-job hard execution budget; the worker loop applies it to every
	// handler invocation (test seams may override for determinism).
	jobTimeoutMs: z
		.number()
		.int()
		.min(1000)
		.max(3600000)
		.default(WORKER_CONFIG_DEFAULTS.jobTimeoutMs),
	networkEgressDefault: z
		.enum(["deny", "allowlist"])
		.default(WORKER_CONFIG_DEFAULTS.networkEgressDefault),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function parseWorkerConfig(
	input: unknown,
): Result<WorkerConfig, PlatformError> {
	return parseWith(workerConfigSchema, input);
}
