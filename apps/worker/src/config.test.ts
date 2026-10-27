import { describe, expect, test } from "bun:test";
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
	});

	test("numeric env strings coerce; explicit worker id wins", () => {
		const config = loadWorkerConfig({
			WORKER_ID: "ci-worker",
			WORKER_POLL_INTERVAL_MS: "250",
		});
		expect(config.workerId).toBe("ci-worker");
		expect(config.pollIntervalMs).toBe(250);
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
