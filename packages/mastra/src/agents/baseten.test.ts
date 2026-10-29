import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	BASETEN_DEFAULT_BASE_URL,
	BASETEN_DEFAULT_MODEL_ID,
	basetenModelConfig,
	estimateUsageCostUsd,
} from "./baseten";

const KEY = "test-key-value-never-echoed";

describe("basetenModelConfig", () => {
	test("applies documented defaults when only the key is present", () => {
		expect(basetenModelConfig({ BASETEN_API_KEY: KEY })).toEqual({
			providerId: "baseten",
			modelId: BASETEN_DEFAULT_MODEL_ID,
			url: BASETEN_DEFAULT_BASE_URL,
			apiKey: KEY,
		});
	});

	test("env overrides model id and base url", () => {
		const config = basetenModelConfig({
			BASETEN_API_KEY: KEY,
			BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
			BASETEN_BASE_URL: "https://inference.example.test/v1",
		});
		expect(config.modelId).toBe("meta-models/muse-spark-open-1026");
		expect(config.url).toBe("https://inference.example.test/v1");
		expect(config.providerId).toBe("baseten");
	});

	test("blank optional overrides fall back to defaults", () => {
		const config = basetenModelConfig({
			BASETEN_API_KEY: KEY,
			BASETEN_MODEL_ID: "   ",
			BASETEN_BASE_URL: "  ",
		});
		expect(config.modelId).toBe(BASETEN_DEFAULT_MODEL_ID);
		expect(config.url).toBe(BASETEN_DEFAULT_BASE_URL);
	});

	test("missing key fails closed with MISSING_CONFIG", () => {
		let caught: unknown;
		try {
			basetenModelConfig({});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("MISSING_CONFIG");
		expect((caught as PlatformError).message).toBe(
			"BASETEN_API_KEY is required when INFERENCE_PROVIDER=baseten",
		);
	});

	test("blank key fails closed and never echoes its value", () => {
		const blank = "   ";
		let caught: unknown;
		try {
			basetenModelConfig({ BASETEN_API_KEY: blank });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("MISSING_CONFIG");
		expect(String(caught)).not.toContain(blank);
	});

	test("non-https base url is rejected without echoing it", () => {
		let caught: unknown;
		try {
			basetenModelConfig({
				BASETEN_API_KEY: KEY,
				BASETEN_BASE_URL: "http://inference.baseten.co/v1",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("VALIDATION_FAILED");
		expect(String(caught)).not.toContain("inference.baseten.co");
	});

	test("malformed and credential-bearing urls are rejected", () => {
		const cases = [
			"not a url",
			"https://user:pass@inference.baseten.co/v1",
			`https://inference.baseten.co/${"a".repeat(3000)}`,
		];
		for (const value of cases) {
			expect(() =>
				basetenModelConfig({
					BASETEN_API_KEY: KEY,
					BASETEN_BASE_URL: value,
				}),
			).toThrow(PlatformError);
		}
	});
});

describe("estimateUsageCostUsd", () => {
	const usage = {
		modelId: "meta-models/muse-spark-open-1026",
		promptTokens: 1000,
		completionTokens: 500,
	};
	const table = {
		"meta-models/muse-spark-open-1026": {
			promptUsdPerMillion: 3,
			completionUsdPerMillion: 15,
		},
	};

	test("null when no table or no model entry is configured", () => {
		expect(estimateUsageCostUsd(usage, undefined)).toBeNull();
		expect(estimateUsageCostUsd(usage, {})).toBeNull();
		expect(
			estimateUsageCostUsd({ ...usage, modelId: "other-model" }, table),
		).toBeNull();
	});

	test("computes cost from injected prices", () => {
		expect(estimateUsageCostUsd(usage, table)).toBeCloseTo(0.0105, 10);
		expect(
			estimateUsageCostUsd(
				{ ...usage, promptTokens: 0, completionTokens: 0 },
				table,
			),
		).toBe(0);
	});

	test("null for non-finite or negative prices and token counts", () => {
		const broken = (
			promptUsdPerMillion: number,
			completionUsdPerMillion: number,
		) => ({
			"meta-models/muse-spark-open-1026": {
				promptUsdPerMillion,
				completionUsdPerMillion,
			},
		});
		expect(estimateUsageCostUsd(usage, broken(Number.NaN, 15))).toBeNull();
		expect(estimateUsageCostUsd(usage, broken(-1, 15))).toBeNull();
		expect(
			estimateUsageCostUsd(usage, broken(Number.POSITIVE_INFINITY, 15)),
		).toBeNull();
		expect(
			estimateUsageCostUsd({ ...usage, promptTokens: Number.NaN }, table),
		).toBeNull();
	});
});
