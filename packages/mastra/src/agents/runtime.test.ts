import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import type { Agent } from "@mastra/core/agent";
import {
	createFakeAgentRuntime,
	createMastraAgentRuntime,
	limitSummary,
	type MastraAgentRuntime,
} from "./runtime";
import type { TaskContext } from "./types";

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
		model: { providerId: "baseten", modelId: "meta-models/muse-spark-open" },
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
				modelId: "meta-models/muse-spark-open",
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
				"meta-models/muse-spark-open": {
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

describe("createFakeAgentRuntime", () => {
	test("records usage null for every turn", async () => {
		const runtime = createFakeAgentRuntime({ script: () => "hi" });
		await runtime.runTurn({ prompt: "go", context: CONTEXT, signal });
		expect(runtime.turns[0].usage).toBeNull();
		expect(runtime.turns[0].summary).toBe(limitSummary("hi"));
	});
});
