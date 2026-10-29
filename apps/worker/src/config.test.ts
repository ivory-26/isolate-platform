import { describe, expect, test } from "bun:test";
import { WORKER_CONFIG_DEFAULTS } from "@isolate/shared";
import { loadWorkerConfig, workerConfigSchema } from "./config";

describe("worker config", () => {
	test("defaults are bounded and sane", () => {
		const config = workerConfigSchema.parse({});
		expect(config.pollIntervalMs).toBe(1000);
		expect(config.leaseSeconds).toBe(60);
		expect(config.maxAttemptsDefault).toBe(5);
		expect(config.reaperIntervalMs).toBe(5000);
		expect(config.workerId.startsWith("worker_")).toBe(true);
		expect(config.databaseUrl).toBeUndefined();
		expect(config.jobTimeoutMs).toBe(WORKER_CONFIG_DEFAULTS.jobTimeoutMs);
		expect(loadWorkerConfig({}).jobTimeoutMs).toBe(120_000);
	});

	test("numeric env strings coerce; explicit worker id wins", () => {
		const config = loadWorkerConfig({
			WORKER_ID: "ci-worker",
			WORKER_POLL_INTERVAL_MS: "250",
		});
		expect(config.workerId).toBe("ci-worker");
		expect(config.pollIntervalMs).toBe(250);
	});

	test("WORKER_JOB_TIMEOUT_MS coerces and mirrors shared contract bounds", () => {
		expect(
			loadWorkerConfig({ WORKER_JOB_TIMEOUT_MS: "1500" }).jobTimeoutMs,
		).toBe(1500);
		expect(workerConfigSchema.safeParse({ jobTimeoutMs: 999 }).success).toBe(
			false,
		);
		expect(
			workerConfigSchema.safeParse({ jobTimeoutMs: 3_600_001 }).success,
		).toBe(false);
		expect(workerConfigSchema.safeParse({ jobTimeoutMs: 1000.5 }).success).toBe(
			false,
		);
		expect(
			workerConfigSchema.safeParse({ jobTimeoutMs: "300000" }).success,
		).toBe(true);
	});

	test.each([
		1000, 3_600_000,
	])("accepts timeout contract boundary %d", (jobTimeoutMs) => {
		expect(workerConfigSchema.parse({ jobTimeoutMs }).jobTimeoutMs).toBe(
			jobTimeoutMs,
		);
		expect(
			loadWorkerConfig({ WORKER_JOB_TIMEOUT_MS: String(jobTimeoutMs) })
				.jobTimeoutMs,
		).toBe(jobTimeoutMs);
	});

	test.each([
		"999",
		"3600001",
		"1000.5",
		"",
		"not-a-number",
		"Infinity",
	])("rejects invalid timeout env value %j without exposing it", (jobTimeoutMs) => {
		expect(() =>
			loadWorkerConfig({ WORKER_JOB_TIMEOUT_MS: jobTimeoutMs }),
		).toThrow("worker config invalid: check WORKER_* environment values");
	});

	test("unbounded/too-small values are rejected", () => {
		expect(workerConfigSchema.safeParse({ pollIntervalMs: 10 }).success).toBe(
			false,
		);
		expect(workerConfigSchema.safeParse({ leaseSeconds: 4000 }).success).toBe(
			false,
		);
	});
});
