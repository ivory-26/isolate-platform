import { describe, expect, test } from "bun:test";
import type { SandboxToolBackend } from "@isolate/mastra";
import {
	createBasetenRuntimeFactory,
	createMetaRuntimeFactory,
} from "./runtime-factory";

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
			BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
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

	test("builds a Meta runtime pinned to the contributor model", () => {
		const factory = createMetaRuntimeFactory({ META_API_KEY: "test-meta-key" });
		const runtime = factory({ caps });
		expect(runtime.id).toBe("coding-agent");
		expect(runtime.name).toBe("Coding Agent");
	});

	test("Meta factory fails closed without its key or with another model", () => {
		expect(() => createMetaRuntimeFactory({})).toThrow(/META_API_KEY/);
		expect(() =>
			createMetaRuntimeFactory({
				META_API_KEY: "test-meta-key",
				META_MODEL_ID: "muse-spark-1.3",
			}),
		).toThrow(/META_MODEL_ID/);
	});
});
