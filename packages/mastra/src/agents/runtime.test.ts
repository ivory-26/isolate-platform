import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import type { Agent } from "@mastra/core/agent";
import {
	createFakeAgentRuntime,
	createMastraAgentRuntime,
	limitSummary,
	type MastraAgentRuntime,
	nextTurnTokenReservation,
} from "./runtime";
import type { AgentUsage, TaskContext } from "./types";

const CONTEXT: TaskContext = {
	taskId: "task-1",
	organizationId: "org-1",
	goal: "goal",
	repoUrl: "https://fake.invalid/repo.git",
	baseBranch: "main",
	isolatedBranch: "task/task-1",
	fileOwnership: ["src/a.ts"],
	acceptanceCriteria: ["works"],
	limits: {
		max_agent_turns: 3,
		max_repair_attempts: 1,
		max_duration_ms: 60_000,
	},
};

type FakeResult = {
	text: string;
	totalUsage?: unknown;
	usage?: unknown;
	toolCalls?: unknown;
};

type GenerateCall = { prompt: string; options: Record<string, unknown> };

/** Fake Agent: records the exact options the runtime passes to `generate`. */
function fakeAgent(
	handler: (
		prompt: string,
		options: Record<string, unknown>,
	) => FakeResult | Promise<FakeResult>,
	onCall?: (call: GenerateCall) => void,
): { agent: Agent; calls: GenerateCall[] } {
	const calls: GenerateCall[] = [];
	const agent = {
		generate: async (prompt: string, options: Record<string, unknown>) => {
			const call = { prompt, options };
			calls.push(call);
			onCall?.(call);
			return await handler(prompt, options);
		},
	} as unknown as Agent;
	return { agent, calls };
}

function runtimeWith(
	agent: Agent,
	overrides: Partial<Parameters<typeof createMastraAgentRuntime>[1]> = {},
): MastraAgentRuntime {
	return createMastraAgentRuntime(agent, {
		id: "coding-agent",
		name: "Coding Agent",
		model: {
			providerId: "baseten",
			modelId: "meta-models/muse-spark-open-1026",
		},
		...overrides,
	});
}

const signal = new AbortController().signal;

describe("createMastraAgentRuntime usage mapping", () => {
	test("maps totalUsage, records tool names without args, cost null without a table", async () => {
		const fake = fakeAgent(() => ({
			text: "did the work",
			totalUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
			toolCalls: [
				{
					type: "tool-call",
					payload: {
						toolName: "repo.read_file",
						args: { path: "src/secret.ts", token: "s3cr3t-value" },
					},
				},
				{ toolName: "repo.search", args: { query: "s3cr3t-value" } },
			],
		}));
		const runtime = runtimeWith(fake.agent);

		const text = await runtime.runTurn({
			prompt: "go",
			context: CONTEXT,
			signal,
		});
		expect(text).toBe("did the work");
		expect(runtime.totalTokensUsed).toBe(150);
		expect(runtime.turns[0]).toMatchObject({
			turn: 1,
			status: "finished",
			summary: "did the work",
			toolCalls: ["repo.read_file", "repo.search"],
			usage: {
				providerId: "baseten",
				modelId: "meta-models/muse-spark-open-1026",
				promptTokens: 120,
				completionTokens: 30,
				totalTokens: 150,
				costUsd: null,
			},
		});
		// Names only: args/payloads never reach the record.
		expect(JSON.stringify(runtime.turns[0])).not.toContain("s3cr3t-value");
	});

	test("computes exact cost from an injected price table and awaits onUsage before onRecord", async () => {
		const order: string[] = [];
		const usageSeen: number[] = [];
		const fake = fakeAgent(() => ({
			text: "ok",
			totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
			toolCalls: [],
		}));
		const runtime = runtimeWith(fake.agent, {
			priceTable: {
				"meta-models/muse-spark-open-1026": {
					promptUsdPerMillion: 3,
					completionUsdPerMillion: 15,
				},
			},
			onUsage: async (usage) => {
				order.push("usage:start");
				await Promise.resolve();
				order.push("usage:end");
				usageSeen.push(usage.costUsd ?? -1);
			},
			onRecord: async () => {
				order.push("record");
			},
		});

		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(usageSeen).toHaveLength(1);
		expect(usageSeen[0]).toBeCloseTo(0.0105, 10);
		expect(order).toEqual(["usage:start", "usage:end", "record"]);
	});

	test("empty text at the output cap is BUDGET_EXCEEDED, not completion", async () => {
		const caps = {
			maxOutputTokensPerTurn: 128,
			maxTaskTokens: 1024,
			maxSteps: 1,
		};
		const truncated = fakeAgent(() => ({
			text: "",
			totalUsage: { inputTokens: 10, outputTokens: 128, totalTokens: 138 },
		}));
		const runtime = runtimeWith(truncated.agent, { caps });
		await expect(
			runtime.runTurn({
				prompt: "go",
				context: CONTEXT,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

		const finished = fakeAgent(() => ({
			text: "",
			totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		}));
		const doneRuntime = runtimeWith(finished.agent, { caps });
		expect(
			await doneRuntime.runTurn({
				prompt: "go",
				context: CONTEXT,
				signal: new AbortController().signal,
			}),
		).toBe("");
	});

	test("falls back to result.usage and accepts OpenAI-style token aliases", async () => {
		const fake = fakeAgent(() => ({
			text: "ok",
			usage: { promptTokens: 10, completionTokens: 5 },
		}));
		const runtime = runtimeWith(fake.agent);
		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(runtime.turns[0].usage).toMatchObject({
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			costUsd: null,
		});
	});

	test("no reported usage leaves the record usage null", async () => {
		const fake = fakeAgent(() => ({ text: "ok" }));
		const runtime = runtimeWith(fake.agent);
		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(runtime.turns[0].usage).toBeNull();
		expect(runtime.totalTokensUsed).toBe(0);
	});
});

describe("createMastraAgentRuntime bounds", () => {
	test("passes maxSteps, per-turn output cap and abort signal through", async () => {
		const fake = fakeAgent(() => ({
			text: "ok",
			totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		}));
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 1000,
				maxSteps: 3,
			},
		});

		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].options.maxSteps).toBe(3);
		expect(fake.calls[0].options.modelSettings).toEqual({
			maxOutputTokens: 16,
		});
		expect(fake.calls[0].options.abortSignal).toBe(signal);
	});

	test("cumulative token cap blocks the next turn before generate", async () => {
		const fake = fakeAgent(() => ({
			text: "ok",
			totalUsage: { inputTokens: 60, outputTokens: 40, totalTokens: 100 },
		}));
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
			},
		});

		await runtime.runTurn({ prompt: "first", context: CONTEXT, signal });
		expect(fake.calls).toHaveLength(1);
		expect(runtime.totalTokensUsed).toBe(100);

		let caught: unknown;
		try {
			await runtime.runTurn({ prompt: "second", context: CONTEXT, signal });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("BUDGET_EXCEEDED");
		expect((caught as PlatformError).message).toBe(
			"task token budget exhausted",
		);
		expect(fake.calls).toHaveLength(1);
	});

	test("invalid caps fail at construction with VALIDATION_FAILED", () => {
		const fake = fakeAgent(() => ({ text: "ok" }));
		const invalidCaps = [
			{ maxOutputTokensPerTurn: 16, maxTaskTokens: 100, maxSteps: 0 },
			{ maxOutputTokensPerTurn: 16, maxTaskTokens: 100, maxSteps: -1 },
			{
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: Number.NaN,
			},
			{
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: Number.POSITIVE_INFINITY,
				maxSteps: 2,
			},
			{
				maxOutputTokensPerTurn: Number.NaN,
				maxTaskTokens: 100,
				maxSteps: 2,
			},
			{
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
				priorTaskTokens: -1,
			},
			{
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
				priorTaskTokens: 1.5,
			},
			{
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
				priorTaskTokens: Number.NaN,
			},
		];
		for (const caps of invalidCaps) {
			expect(() => runtimeWith(fake.agent, { caps })).toThrow(PlatformError);
			try {
				runtimeWith(fake.agent, { caps });
			} catch (error) {
				expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
			}
		}
	});

	test("abort errors propagate as-is and are recorded as failed", async () => {
		const abortError = Object.assign(new Error("aborted"), {
			name: "AbortError",
		});
		const fake = fakeAgent(() => {
			throw abortError;
		});
		const runtime = runtimeWith(fake.agent);
		let caught: unknown;
		try {
			await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(abortError);
		expect(runtime.turns[0].status).toBe("failed");
		expect(runtime.turns[0].usage).toBeNull();
	});
});

describe("createMastraAgentRuntime task-wide tokens", () => {
	test("seeds totalTokensUsed from priorTaskTokens and reserves the previous turn", async () => {
		const fake = fakeAgent(() => ({
			text: "ok",
			totalUsage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
		}));
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
				priorTaskTokens: 85,
			},
		});
		expect(runtime.totalTokensUsed).toBe(85);

		await runtime.runTurn({ prompt: "first", context: CONTEXT, signal });
		expect(runtime.totalTokensUsed).toBe(95);

		// 95 used + 10 reserved for a turn of the previous size > 100.
		await expect(
			runtime.runTurn({ prompt: "second", context: CONTEXT, signal }),
		).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
		expect(fake.calls).toHaveLength(1);
	});

	test("blocks before the first turn when prior spend exhausts the task", async () => {
		const fake = fakeAgent(() => ({ text: "never" }));
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 100,
				maxSteps: 2,
				priorTaskTokens: 100,
			},
		});
		await expect(
			runtime.runTurn({ prompt: "go", context: CONTEXT, signal }),
		).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
		expect(fake.calls).toHaveLength(0);
		expect(runtime.turns).toHaveLength(0);
	});

	test("a later turn much larger than the previous one is stopped at the next pre-turn check", async () => {
		let turn = 0;
		const fake = fakeAgent(() => {
			turn += 1;
			const totalTokens = turn === 1 ? 10 : 95;
			return {
				text: "ok",
				totalUsage: {
					inputTokens: totalTokens - 5,
					outputTokens: 5,
					totalTokens,
				},
			};
		});
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 1000,
				maxTaskTokens: 100,
				maxSteps: 2,
			},
		});

		// Turn 1 (10 tokens) reserves 10, so turn 2 is allowed to start.
		await runtime.runTurn({ prompt: "first", context: CONTEXT, signal });
		await runtime.runTurn({ prompt: "second", context: CONTEXT, signal });
		expect(fake.calls).toHaveLength(2);
		// Turn 2 is far larger than turn 1: the heuristic reservation did not
		// prevent it, and only the NEXT pre-turn check stops the run.
		expect(runtime.totalTokensUsed).toBe(105);
		expect(runtime.turns.map((record) => record.status)).toEqual([
			"finished",
			"finished",
		]);

		await expect(
			runtime.runTurn({ prompt: "third", context: CONTEXT, signal }),
		).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
		expect(fake.calls).toHaveLength(2);
	});

	test("a usage-less turn preserves the previous reservation", () => {
		const previous: AgentUsage = {
			providerId: "baseten",
			modelId: "test-model",
			promptTokens: 60,
			completionTokens: 40,
			totalTokens: 100,
			costUsd: null,
		};
		// No usage reported: keep the reservation instead of resetting to zero.
		expect(nextTurnTokenReservation(40, null)).toBe(40);
		// Reported usage replaces it with the size of the turn that just ran.
		expect(nextTurnTokenReservation(40, previous)).toBe(100);
	});
});

describe("createMastraAgentRuntime prompt/context preflight", () => {
	const baseCaps = {
		maxOutputTokensPerTurn: 16,
		maxTaskTokens: 1000,
		maxSteps: 2,
	};

	test("a prompt that fits the configured window reaches the model", async () => {
		const fake = fakeAgent(() => ({ text: "ok" }));
		const runtime = runtimeWith(fake.agent, {
			caps: { ...baseCaps, contextWindowTokens: 40 },
		});
		await runtime.runTurn({ prompt: "hello", context: CONTEXT, signal });
		expect(fake.calls).toHaveLength(1);
	});

	test("an oversized prompt is rejected before generate and recorded", async () => {
		const fake = fakeAgent(() => ({ text: "unreachable" }));
		const runtime = runtimeWith(fake.agent, {
			caps: { ...baseCaps, contextWindowTokens: 40 },
		});
		let caught: unknown;
		try {
			await runtime.runTurn({
				prompt: "x".repeat(100),
				context: CONTEXT,
				signal,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("BUDGET_EXCEEDED");
		expect((caught as PlatformError).message).toBe(
			"prompt exceeds configured context window",
		);
		expect(fake.calls).toHaveLength(0);
		expect(runtime.turns[0]).toMatchObject({
			status: "failed",
			summary: "prompt exceeds configured context window",
			usage: null,
		});
		expect(runtime.totalTokensUsed).toBe(0);
	});

	test("counts multibyte prompts by UTF-8 bytes", async () => {
		const multibyte = fakeAgent(() => ({ text: "unreachable" }));
		const multibyteRuntime = runtimeWith(multibyte.agent, {
			caps: { ...baseCaps, contextWindowTokens: 34 },
		});
		await expect(
			multibyteRuntime.runTurn({
				prompt: "é".repeat(40),
				context: CONTEXT,
				signal,
			}),
		).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
		expect(multibyte.calls).toHaveLength(0);

		const ascii = fakeAgent(() => ({ text: "ok" }));
		const asciiRuntime = runtimeWith(ascii.agent, {
			caps: { ...baseCaps, contextWindowTokens: 34 },
		});
		await asciiRuntime.runTurn({
			prompt: "a".repeat(40),
			context: CONTEXT,
			signal,
		});
		expect(ascii.calls).toHaveLength(1);
	});

	test("an unset window keeps the preflight disabled", async () => {
		const fake = fakeAgent(() => ({ text: "ok" }));
		const runtime = runtimeWith(fake.agent, { caps: baseCaps });
		await runtime.runTurn({
			prompt: "x".repeat(100_000),
			context: CONTEXT,
			signal,
		});
		expect(fake.calls).toHaveLength(1);
	});

	test("the abort signal wins over the preflight", async () => {
		const fake = fakeAgent(() => ({ text: "unreachable" }));
		const runtime = runtimeWith(fake.agent, {
			caps: { ...baseCaps, contextWindowTokens: 40 },
		});
		const controller = new AbortController();
		controller.abort(new Error("aborted"));
		let caught: unknown;
		try {
			await runtime.runTurn({
				prompt: "x".repeat(100),
				context: CONTEXT,
				signal: controller.signal,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).not.toBeInstanceOf(PlatformError);
		expect((caught as Error).message).toBe("aborted");
		expect(fake.calls).toHaveLength(0);
	});

	test("invalid context windows and retry attempts fail at construction", () => {
		const fake = fakeAgent(() => ({ text: "ok" }));
		const invalid = [
			{ ...baseCaps, contextWindowTokens: 0 },
			{ ...baseCaps, contextWindowTokens: -1 },
			{ ...baseCaps, contextWindowTokens: 1.5 },
			{ ...baseCaps, contextWindowTokens: Number.NaN },
			{ ...baseCaps, providerRetryAttempts: -1 },
			{ ...baseCaps, providerRetryAttempts: 1.5 },
			{ ...baseCaps, providerRetryAttempts: 4 },
		];
		for (const caps of invalid) {
			expect(() => runtimeWith(fake.agent, { caps })).toThrow(PlatformError);
		}
	});
});

describe("createMastraAgentRuntime provider failure classification", () => {
	test("a provider failure becomes a classified PlatformError", async () => {
		const raw = Object.assign(new Error("too many requests"), { status: 429 });
		const fake = fakeAgent(() => {
			throw raw;
		});
		const runtime = runtimeWith(fake.agent);
		let caught: unknown;
		try {
			await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		const providerError = caught as PlatformError;
		expect(providerError.code).toBe("RATE_LIMITED");
		expect(providerError.retryable).toBe(true);
		expect(providerError.message).toBe("provider rate limited the request");
		expect(providerError.cause).toBe(raw);
		expect(fake.calls).toHaveLength(1); // default: classify once, no retry
		expect(runtime.turns[0]).toMatchObject({
			status: "failed",
			summary: "provider rate limited the request",
			usage: null,
		});
		expect(runtime.totalTokensUsed).toBe(0);
	});

	test("auth failures are not retried even when retries are enabled", async () => {
		const fake = fakeAgent(() => {
			throw Object.assign(new Error("nope"), { status: 401 });
		});
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 1000,
				maxSteps: 2,
				providerRetryAttempts: 2,
			},
		});
		await expect(
			runtime.runTurn({ prompt: "go", context: CONTEXT, signal }),
		).rejects.toMatchObject({
			code: "AGENT_EXECUTION_FAILED",
			retryable: false,
		});
		expect(fake.calls).toHaveLength(1);
	});

	test("unknown failures are non-retryable", async () => {
		const fake = fakeAgent(() => {
			throw new TypeError("boom");
		});
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 1000,
				maxSteps: 2,
				providerRetryAttempts: 3,
			},
		});
		await expect(
			runtime.runTurn({ prompt: "go", context: CONTEXT, signal }),
		).rejects.toMatchObject({
			code: "AGENT_EXECUTION_FAILED",
			retryable: false,
		});
		expect(fake.calls).toHaveLength(1);
	});

	test("retryable failures use the configured bounded attempt budget", async () => {
		let calls = 0;
		const fake = fakeAgent(() => {
			calls += 1;
			if (calls <= 2) {
				throw Object.assign(new Error("overloaded"), { status: 503 });
			}
			return {
				text: "recovered",
				totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
			};
		});
		const runtime = runtimeWith(fake.agent, {
			caps: {
				maxOutputTokensPerTurn: 16,
				maxTaskTokens: 1000,
				maxSteps: 2,
				providerRetryAttempts: 2,
			},
		});
		const text = await runtime.runTurn({
			prompt: "go",
			context: CONTEXT,
			signal,
		});
		expect(text).toBe("recovered");
		expect(fake.calls).toHaveLength(3);
		expect(runtime.turns[0]).toMatchObject({
			status: "finished",
			usage: { totalTokens: 7 },
		});
	});
});

describe("createFakeAgentRuntime", () => {
	test("records usage null for every turn", async () => {
		const runtime = createFakeAgentRuntime({ script: () => "hi" });
		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(runtime.turns[0].usage).toBeNull();
		expect(runtime.turns[0].summary).toBe(limitSummary("hi"));
	});

	test("reports an explicit conservative capability record", () => {
		const runtime = createFakeAgentRuntime({ script: () => "" });
		expect(runtime.capabilities).toEqual({
			streaming: false,
			toolCalls: false,
			approvals: false,
			session: false,
			context: false,
		});
	});

	test("honours a test-only capability override", () => {
		const runtime = createFakeAgentRuntime({
			script: () => "",
			capabilities: {
				streaming: false,
				toolCalls: true,
				approvals: true,
				session: false,
				context: true,
			},
		});
		expect(runtime.capabilities.toolCalls).toBe(true);
	});
});
