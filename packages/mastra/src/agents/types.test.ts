import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { basetenModelConfig } from "./baseten";
import { defineCodingAgent } from "./types";

const MODEL = basetenModelConfig({ BASETEN_API_KEY: "test-api-key" });

function readTool() {
	return createTool({
		id: "repo.read_file",
		description: "read a file",
		inputSchema: z.object({ path: z.string() }),
		outputSchema: z.object({ content: z.string() }),
		execute: async () => ({ content: "" }),
	});
}

describe("defineCodingAgent", () => {
	test("accepts a trusted tool collection and a default step bound", () => {
		const agent = defineCodingAgent(MODEL, {
			id: "coding-agent",
			name: "Coding Agent",
			instructions: "do the work",
			tools: { "repo.read_file": readTool() },
			maxSteps: 3,
		});
		expect(agent.id).toBe("coding-agent");
		expect(agent.name).toBe("Coding Agent");
	});

	test("rejects invalid maxSteps at definition time", () => {
		for (const maxSteps of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				defineCodingAgent(MODEL, {
					id: "coding-agent",
					name: "Coding Agent",
					instructions: "do the work",
					maxSteps,
				}),
			).toThrow(PlatformError);
		}
	});
});
