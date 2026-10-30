import type { Logger } from "@isolate/shared";

/**
 * Structured worker metrics (wave 11).
 *
 * One fixed-name JSON record per metric, emitted through the existing
 * `Logger` as `isolate.metric` with a `metric` field. Consumers (log
 * aggregation, dashboards) key on the name, never on free text.
 *
 * Vocabulary (stable):
 * - `worker.job.claimed`        — a job was claimed; `jobType`, `attempt`
 * - `worker.job.completed`      — handler returned `complete`
 * - `worker.job.failed`         — handler failed (retried or not); `code`
 * - `worker.job.dead_letter`    — the queue dead-lettered the job; `code`
 * - `worker.turn.latency_ms`    — one `runTurn` duration; `turn`, `durationMs`
 * - `worker.sandbox.seconds`    — measured sandbox wall time at teardown
 * - `worker.validation.outcome` — configured validation gate; `outcome`
 * - `worker.pr.outcome`         — pull-request job result; `outcome`
 *
 * Safety: only bounded fields cross this boundary — ids (≤64 safe chars),
 * counts, durations, codes and outcomes. Unknown keys are dropped, so a caller
 * that accidentally passes a prompt, a path or tool arguments cannot leak
 * them through a metric record.
 */

export const WORKER_METRICS = {
	jobClaimed: "worker.job.claimed",
	jobCompleted: "worker.job.completed",
	jobFailed: "worker.job.failed",
	jobDeadLetter: "worker.job.dead_letter",
	turnLatencyMs: "worker.turn.latency_ms",
	sandboxSeconds: "worker.sandbox.seconds",
	validationOutcome: "worker.validation.outcome",
	prOutcome: "worker.pr.outcome",
} as const;

export type WorkerMetricName =
	(typeof WORKER_METRICS)[keyof typeof WORKER_METRICS];

/** Message every metric record is logged under. */
export const METRIC_LOG_MESSAGE = "isolate.metric";

/**
 * Field bag accepted from callers. Typed `unknown` on purpose: the filter
 * below is the trust boundary, so a caller mistake is dropped rather than
 * trusted.
 */
export type MetricFields = Readonly<Record<string, unknown>>;

const ID_FIELDS = new Set(["jobId", "taskId", "jobType", "code", "outcome"]);
const COUNT_FIELDS = new Set(["attempt", "maxAttempts", "turn", "count"]);
const DURATION_FIELDS = new Set(["durationMs", "seconds"]);
const FLAG_FIELDS = new Set(["requeued"]);

/**
 * Safe identifier alphabet. Deliberately excludes `/`, `\` and whitespace so a
 * filesystem path or a prompt fragment can never pass as an id or outcome.
 */
const BOUNDED_TOKEN = /^[A-Za-z0-9_.:@-]{1,64}$/;
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_SECONDS = 86_400;

function boundedNumber(value: unknown, max: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.min(value, max);
}

/**
 * Filters a field bag down to the whitelisted, bounded metric vocabulary.
 * A dropped key is dropped entirely — it is not replaced or truncated, so no
 * partial payload text can survive.
 */
export function boundedMetricFields(
	fields: MetricFields | undefined,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (fields === undefined) return out;
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined) continue;
		if (ID_FIELDS.has(key)) {
			if (typeof value === "string" && BOUNDED_TOKEN.test(value)) {
				out[key] = value;
			}
			continue;
		}
		if (COUNT_FIELDS.has(key)) {
			const bounded = boundedNumber(value, MAX_COUNT);
			if (bounded !== null) out[key] = Math.floor(bounded);
			continue;
		}
		if (DURATION_FIELDS.has(key)) {
			const max = key === "seconds" ? MAX_SECONDS : MAX_DURATION_MS;
			const bounded = boundedNumber(value, max);
			if (bounded !== null) {
				out[key] =
					key === "seconds"
						? Math.round(bounded * 1000) / 1000
						: Math.round(bounded);
			}
			continue;
		}
		if (FLAG_FIELDS.has(key)) {
			if (typeof value === "boolean") out[key] = value;
		}
	}
	return out;
}

/** Emits exactly one bounded `isolate.metric` record. Never throws. */
export function emitMetric(
	logger: Logger,
	metric: WorkerMetricName,
	fields: MetricFields = {},
): void {
	logger.info(METRIC_LOG_MESSAGE, { metric, ...boundedMetricFields(fields) });
}
