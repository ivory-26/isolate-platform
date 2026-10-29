import { describe, expect, test } from "bun:test";
import type { SandboxToolBackend } from "@isolate/mastra";
import { createBasetenRuntimeFactory } from "./runtime-factory";

const backend: SandboxToolBackend = {
	async readFile() {
		return { content: "", truncated: false };
	},
	async listFiles() {
		return [];
	},
	async search() {
		return [];
	},
	async exec() {
		return {
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: 0,
			truncated: false,
		};
	},
	async git() {
		return {
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: 0,
			truncated: false,
		};
	},
};

const caps = {
	maxOutputTokensPerTurn: 16,
	maxTaskTokens: 512,
	maxSteps: 2,
};

describe("createBasetenRuntimeFactory", () => {
	test("fails closed without the key", () => {
		expect(() => createBasetenRuntimeFactory({})).toThrow(/BASETEN_API_KEY/);
	});

	test("builds a runtime with and without a sandbox binding", () => {
		const factory = createBasetenRuntimeFactory({
			BASETEN_API_KEY: "test-key",
			BASETEN_MODEL_ID: "meta-models/muse-spark-open",
		});
		const plain = factory({ caps });
		expect(plain.id).toBe("coding-agent");
		expect(plain.name).toBe("Coding Agent");

		const bound = factory({
			caps,
			sandboxBackend: backend,
			toolContext: {
				organizationId: "11111111-1111-4111-8111-111111111111",
				taskId: "22222222-2222-4222-8222-222222222222",
			},
		});
		expect(bound.id).toBe("coding-agent");
	});
});
