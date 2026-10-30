import { describe, expect, test } from "bun:test";
import type { LogFields, Logger } from "@isolate/shared";
import {
	boundedMetricFields,
	emitMetric,
	METRIC_LOG_MESSAGE,
	WORKER_METRICS,
} from "./metrics";

type Recorded = { message: string; fields: LogFields };

function recordingLogger(records: Recorded[]): Logger {
	const make = (base: LogFields): Logger => ({
		debug: () => {},
		info: (message, fields) =>
			records.push({ message, fields: { ...base, ...fields } }),
		warn: () => {},
		error: () => {},
		child: (fields) => make({ ...base, ...fields }),
	});
	return make({});
}

describe("worker metric vocabulary", () => {
	test("names are fixed and stable", () => {
		expect(Object.values(WORKER_METRICS)).toEqual([
			"worker.job.claimed",
			"worker.job.completed",
			"worker.job.failed",
			"worker.job.dead_letter",
			"worker.turn.latency_ms",
			"worker.sandbox.seconds",
			"worker.validation.outcome",
			"worker.pr.outcome",
		]);
	});

	test("emits exactly one isolate.metric record with bounded fields", () => {
		const records: Recorded[] = [];
		emitMetric(recordingLogger(records), WORKER_METRICS.turnLatencyMs, {
			turn: 2,
			durationMs: 1234.6,
			taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f",
		});
		expect(records).toHaveLength(1);
		expect(records[0]?.message).toBe(METRIC_LOG_MESSAGE);
		expect(records[0]?.fields).toEqual({
			metric: "worker.turn.latency_ms",
			turn: 2,
			durationMs: 1235,
			taskId: "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f",
		});
	});

	test("payload-shaped fields never reach the record", () => {
		const records: Recorded[] = [];
		emitMetric(recordingLogger(records), WORKER_METRICS.validationOutcome, {
			outcome: "passed",
			// A caller mistake must not leak these.
			prompt: "please fix the widget with the secret token",
			repoPath: "/tmp/task/repo/src/widget.ts",
			args: { content: "SECRET" },
			note: "validation text",
			summary: "model narrative",
		});
		expect(records).toHaveLength(1);
		const serialized = JSON.stringify(records[0]);
		expect(serialized).not.toContain("widget");
		expect(serialized).not.toContain("/tmp");
		expect(serialized).not.toContain("SECRET");
		expect(serialized).not.toContain("narrative");
		expect(records[0]?.fields).toEqual({
			metric: "worker.validation.outcome",
			outcome: "passed",
		});
	});

	test("unsafe id/outcome strings are dropped, never truncated", () => {
		const fields = boundedMetricFields({
			jobId: "../../etc/passwd",
			outcome: "a value with spaces",
			code: "VALIDATION_FAILED",
			durationMs: -5,
			seconds: Number.POSITIVE_INFINITY,
			count: 4_000_000,
			requeued: true,
			unknown: "x",
		});
		expect(fields).toEqual({
			code: "VALIDATION_FAILED",
			count: 1_000_000,
			requeued: true,
		});
	});

	test("durations are clamped and seconds rounded to milliseconds", () => {
		expect(
			boundedMetricFields({ seconds: 1.23456, durationMs: 100_000_000 }),
		).toEqual({ seconds: 1.235, durationMs: 86_400_000 });
	});
});
