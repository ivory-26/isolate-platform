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
			WORKER_MAX_CONCURRENCY: "3",
		});
		expect(config.workerId).toBe("ci-worker");
		expect(config.pollIntervalMs).toBe(250);
		expect(config.maxConcurrency).toBe(3);
	});

	test("maxConcurrency defaults to the shared contract and stays bounded", () => {
		expect(workerConfigSchema.parse({}).maxConcurrency).toBe(
			WORKER_CONFIG_DEFAULTS.maxConcurrency,
		);
		expect(workerConfigSchema.parse({ maxConcurrency: 1 }).maxConcurrency).toBe(
			1,
		);
		expect(
			workerConfigSchema.parse({ maxConcurrency: 16 }).maxConcurrency,
		).toBe(16);
		expect(workerConfigSchema.safeParse({ maxConcurrency: 0 }).success).toBe(
			false,
		);
		expect(workerConfigSchema.safeParse({ maxConcurrency: 17 }).success).toBe(
			false,
		);
		expect(workerConfigSchema.safeParse({ maxConcurrency: 1.5 }).success).toBe(
			false,
		);
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

describe("worker config — task execution caps", () => {
	test("defaults are bounded and deterministic", () => {
		const config = workerConfigSchema.parse({});
		expect(config.maxOutputTokensPerTurn).toBe(1024);
		expect(config.maxTokensPerTask).toBe(200_000);
		expect(config.maxSandboxSeconds).toBe(900);
		expect(config.maxCostUsdPerTask).toBe(1);
		expect(config.maxAgentSteps).toBe(12);
	});

	test("env strings coerce for every cap", () => {
		const config = loadWorkerConfig({
			WORKER_MAX_OUTPUT_TOKENS_PER_TURN: "2048",
			WORKER_MAX_TOKENS_PER_TASK: "1500000",
			WORKER_MAX_SANDBOX_SECONDS: "1200",
			WORKER_MAX_COST_USD_PER_TASK: "2.5",
			WORKER_MAX_AGENT_STEPS: "25",
		});
		expect(config.maxOutputTokensPerTurn).toBe(2048);
		expect(config.maxTokensPerTask).toBe(1_500_000);
		expect(config.maxSandboxSeconds).toBe(1200);
		expect(config.maxCostUsdPerTask).toBe(2.5);
		expect(config.maxAgentSteps).toBe(25);
	});

	test.each([
		["maxOutputTokensPerTurn", 1],
		["maxOutputTokensPerTurn", 8192],
		["maxTokensPerTask", 1_000],
		["maxTokensPerTask", 2_000_000],
		["maxSandboxSeconds", 60],
		["maxSandboxSeconds", 3600],
		["maxCostUsdPerTask", 0],
		["maxCostUsdPerTask", 100],
		["maxAgentSteps", 1],
		["maxAgentSteps", 50],
	])("accepts boundary %s=%d", (field, value) => {
		const parsed = workerConfigSchema.parse({
			[field]: value,
		}) as unknown as Record<string, number>;
		expect(parsed[field]).toBe(value);
	});

	test.each([
		["maxOutputTokensPerTurn", 0],
		["maxOutputTokensPerTurn", 8193],
		["maxOutputTokensPerTurn", 1.5],
		["maxTokensPerTask", 999],
		["maxTokensPerTask", 2_000_001],
		["maxSandboxSeconds", 59],
		["maxSandboxSeconds", 3601],
		["maxCostUsdPerTask", -0.01],
		["maxCostUsdPerTask", 100.01],
		["maxAgentSteps", 0],
		["maxAgentSteps", 51],
	])("rejects out-of-bounds %s=%d", (field, value) => {
		expect(workerConfigSchema.safeParse({ [field]: value }).success).toBe(
			false,
		);
	});

	test("rejects non-finite and non-numeric cap env values without echoing them", () => {
		for (const [name, value] of [
			["WORKER_MAX_OUTPUT_TOKENS_PER_TURN", "Infinity"],
			["WORKER_MAX_TOKENS_PER_TASK", "not-a-number"],
			["WORKER_MAX_SANDBOX_SECONDS", "NaN"],
			["WORKER_MAX_COST_USD_PER_TASK", "Infinity"],
			["WORKER_MAX_AGENT_STEPS", "1e3"],
		] as const) {
			expect(() => loadWorkerConfig({ [name]: value })).toThrow(
				"worker config invalid: check WORKER_* environment values",
			);
		}
	});
});
