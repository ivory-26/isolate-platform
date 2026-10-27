import { describe, expect, test } from "bun:test";
import {
	parseTaskTransitionRequest,
	parseWorkerConfig,
	taskTransitionRequestSchema,
	WORKER_CONFIG_DEFAULTS,
	workerConfigSchema,
} from "./schemas";

describe("taskTransitionRequestSchema", () => {
	test("accepts a minimal request", () => {
		const parsed = taskTransitionRequestSchema.parse({
			taskId: "task_1",
			to: "executing",
		});
		expect(parsed.taskId).toBe("task_1");
		expect(parsed.to).toBe("executing");
		expect(parsed.expectedStatus).toBeUndefined();
	});

	test("accepts optional fields", () => {
		const parsed = taskTransitionRequestSchema.parse({
			taskId: "task_1",
			expectedStatus: "queued",
			to: "planning",
			actor: "worker",
			reason: "claiming next job",
		});
		expect(parsed.expectedStatus).toBe("queued");
		expect(parsed.actor).toBe("worker");
		expect(parsed.reason).toBe("claiming next job");
	});

	test("rejects unknown status values", () => {
		expect(
			taskTransitionRequestSchema.safeParse({
				taskId: "task_1",
				to: "dreaming",
			}).success,
		).toBe(false);
	});

	test("rejects oversized reasons", () => {
		expect(
			taskTransitionRequestSchema.safeParse({
				taskId: "task_1",
				to: "planning",
				reason: "x".repeat(501),
			}).success,
		).toBe(false);
	});

	test("parseTaskTransitionRequest passes a legal optimistic pair", () => {
		const result = parseTaskTransitionRequest({
			taskId: "task_1",
			expectedStatus: "queued",
			to: "planning",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.to).toBe("planning");
		}
	});

	test("parseTaskTransitionRequest rejects an illegal optimistic pair", () => {
		const result = parseTaskTransitionRequest({
			taskId: "task_1",
			expectedStatus: "queued",
			to: "executing",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("INVALID_TRANSITION");
		}
	});

	test("parseTaskTransitionRequest rejects shape failures with VALIDATION_FAILED", () => {
		const result = parseTaskTransitionRequest({ to: "planning" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("VALIDATION_FAILED");
			expect(result.error.message).not.toContain("task_");
		}
	});

	test("parseTaskTransitionRequest rejects unknown actor kinds", () => {
		const result = parseTaskTransitionRequest({
			taskId: "task_1",
			to: "planning",
			actor: "admin",
		});
		expect(result.ok).toBe(false);
	});
});

describe("workerConfigSchema", () => {
	test("empty input yields bounded defaults", () => {
		const parsed = workerConfigSchema.parse({});
		expect(parsed).toEqual({
			pollIntervalMs: WORKER_CONFIG_DEFAULTS.pollIntervalMs,
			maxConcurrency: WORKER_CONFIG_DEFAULTS.maxConcurrency,
			leaseTtlMs: WORKER_CONFIG_DEFAULTS.leaseTtlMs,
			maxJobAttempts: WORKER_CONFIG_DEFAULTS.maxJobAttempts,
			maxAgentTurns: WORKER_CONFIG_DEFAULTS.maxAgentTurns,
			maxOutputBytes: WORKER_CONFIG_DEFAULTS.maxOutputBytes,
			repairBudget: WORKER_CONFIG_DEFAULTS.repairBudget,
			jobTimeoutMs: WORKER_CONFIG_DEFAULTS.jobTimeoutMs,
			networkEgressDefault: "deny",
		});
	});

	test("accepts in-bounds custom values", () => {
		const result = parseWorkerConfig({
			pollIntervalMs: 250,
			maxConcurrency: 16,
			leaseTtlMs: 10000,
			maxJobAttempts: 5,
			maxAgentTurns: 24,
			maxOutputBytes: 1048576,
			repairBudget: 1,
			jobTimeoutMs: 300000,
			networkEgressDefault: "allowlist",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.maxConcurrency).toBe(16);
			expect(result.value.jobTimeoutMs).toBe(300000);
			expect(result.value.networkEgressDefault).toBe("allowlist");
		}
	});

	test("rejects out-of-bounds and wrongly-typed fields", () => {
		const tooSmall = parseWorkerConfig({ pollIntervalMs: 10 });
		expect(tooSmall.ok).toBe(false);
		if (!tooSmall.ok) {
			expect(tooSmall.error.code).toBe("VALIDATION_FAILED");
		}

		const tooBig = parseWorkerConfig({ leaseTtlMs: 1000000 });
		expect(tooBig.ok).toBe(false);

		const notInteger = parseWorkerConfig({ maxConcurrency: 1.5 });
		expect(notInteger.ok).toBe(false);

		const wrongType = parseWorkerConfig({ maxAgentTurns: "many" });
		expect(wrongType.ok).toBe(false);

		const tinyTimeout = parseWorkerConfig({ jobTimeoutMs: 100 });
		expect(tinyTimeout.ok).toBe(false);
	});

	test("rejects unknown egress modes", () => {
		const result = parseWorkerConfig({ networkEgressDefault: "open" });
		expect(result.ok).toBe(false);
	});
});
