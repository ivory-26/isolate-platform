import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import { META_DEFAULT_BASE_URL, META_MODEL_ID, metaModelConfig } from "./meta";

const KEY = "test-meta-key-never-echoed";

describe("metaModelConfig", () => {
	test("defaults to the contributor model and Meta base URL", () => {
		expect(metaModelConfig({ META_API_KEY: KEY })).toEqual({
			providerId: "meta",
			modelId: "muse-spark-1.3-contributor",
			url: META_DEFAULT_BASE_URL,
			apiKey: KEY,
		});
	});

	test("accepts the contributor id explicitly and rejects every other model", () => {
		expect(
			metaModelConfig({ META_API_KEY: KEY, META_MODEL_ID: META_MODEL_ID })
				.modelId,
		).toBe(META_MODEL_ID);
		expect(() =>
			metaModelConfig({
				META_API_KEY: KEY,
				META_MODEL_ID: "muse-spark-1.3",
			}),
		).toThrow(PlatformError);
		expect(() =>
			metaModelConfig({
				META_API_KEY: KEY,
				META_MODEL_ID: "some-other-vendor/model",
			}),
		).toThrow(/META_MODEL_ID must be/);
	});

	test("missing key fails closed without echoing values", () => {
		expect(() => metaModelConfig({})).toThrow(/META_API_KEY/);
		expect(() => metaModelConfig({ META_API_KEY: "   " })).toThrow(
			/META_API_KEY/,
		);
	});

	test("rejects non-https or credentialed base URLs", () => {
		expect(() =>
			metaModelConfig({
				META_API_KEY: KEY,
				META_BASE_URL: "http://api.meta.ai/v1",
			}),
		).toThrow(/https/);
		expect(() =>
			metaModelConfig({
				META_API_KEY: KEY,
				META_BASE_URL: "https://user:pass@api.meta.ai/v1",
			}),
		).toThrow(/https/);
	});
});
