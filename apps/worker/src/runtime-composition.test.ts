import { describe, expect, test } from "bun:test";
import type { PgSql } from "@isolate/db";
import { NullProvider } from "@isolate/sandbox";
import type { Logger } from "@isolate/shared";
import { workerConfigSchema } from "./config";
import {
	createConfiguredWorkerComposition,
	readInferenceProvider,
	selectRuntimeFactory,
	selectSandboxProvider,
} from "./runtime-composition";

function logger(): Logger {
	const make = (): Logger => ({
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => make(),
	});
	return make();
}

const CONFIG = workerConfigSchema.parse({ workerId: "test-worker" });

describe("sandbox provider selection", () => {
	test("defaults to the null provider without credentials", async () => {
		const selected = await selectSandboxProvider({});
		expect(selected.real).toBe(false);
		expect(selected.provider).toBeInstanceOf(NullProvider);
	});

	test("rejects an unknown provider name", async () => {
		await expect(
			selectSandboxProvider({ SANDBOX_PROVIDER: "docker" }),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("requires both Modal credentials", async () => {
		await expect(
			selectSandboxProvider({
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
			}),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("builds the Modal provider from an injected client", async () => {
		const seen: Array<{ appName: string }> = [];
		const selected = await selectSandboxProvider(
			{
				SANDBOX_PROVIDER: "modal",
				MODAL_TOKEN_ID: "id",
				MODAL_TOKEN_SECRET: "secret",
				MODAL_APP_NAME: "isolate-test",
			},
			{
				createModalClient: async (env) => {
					seen.push({ appName: env.appName });
					return {
						async create() {
							return { id: "sb-1" };
						},
						async exec() {
							return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
						},
						async terminate() {},
					};
				},
			},
		);
		expect(selected.real).toBe(true);
		expect(selected.provider.name).toBe("modal");
		expect(seen).toEqual([{ appName: "isolate-test" }]);
	});
});

describe("inference provider selection", () => {
	test("none yields no factory", () => {
		expect(readInferenceProvider({})).toBe("none");
		expect(selectRuntimeFactory({})).toBeUndefined();
	});

	test("unknown and key-free Baseten selections fail closed", () => {
		expect(() =>
			selectRuntimeFactory({ INFERENCE_PROVIDER: "openai" }),
		).toThrow(/INFERENCE_PROVIDER/);
		expect(() =>
			selectRuntimeFactory({ INFERENCE_PROVIDER: "baseten" }),
		).toThrow(/BASETEN_API_KEY/);
	});

	test("a configured Baseten key yields a factory", () => {
		const factory = selectRuntimeFactory({
			INFERENCE_PROVIDER: "baseten",
			BASETEN_API_KEY: "test-key",
		});
		expect(typeof factory).toBe("function");
	});

	test("meta requires its key and yields a factory when present", () => {
		expect(() => selectRuntimeFactory({ INFERENCE_PROVIDER: "meta" })).toThrow(
			/META_API_KEY/,
		);
		const factory = selectRuntimeFactory({
			INFERENCE_PROVIDER: "meta",
			META_API_KEY: "test-meta-key",
		});
		expect(typeof factory).toBe("function");
	});
});

describe("configured composition", () => {
	test("without a database it leaves every adapter unbound", async () => {
		const composition = await createConfiguredWorkerComposition(
			CONFIG,
			logger(),
			{},
		);
		expect(composition.overrides).toEqual({});
		expect(composition.queue).toBeUndefined();
	});

	test("with a database it binds the queue, usage sink and loader", async () => {
		const composition = await createConfiguredWorkerComposition(
			{ ...CONFIG, databaseUrl: "postgres://unused.invalid/db" },
			logger(),
			{},
			{ createDb: () => ({}) as PgSql },
		);
		expect(composition.queue).toBeDefined();
		expect(typeof composition.overrides.usageSink?.record).toBe("function");
		expect(typeof composition.overrides.loadTaskContext).toBe("function");
		expect(composition.overrides.provider).toBeUndefined();
		expect(composition.overrides.createRuntime).toBeUndefined();
	});
});
