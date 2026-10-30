import { describe, expect, test } from "bun:test";
import { costPriceTableSchema, PlatformError } from "@isolate/shared";
import {
	loadCostPriceTable,
	PRICE_TABLE_ERROR_CODE,
	parseCostPriceTable,
} from "./pricing";

const VALID = {
	models: [
		{
			modelId: "meta-llama/test-model",
			promptTokenUsdPerMillion: 0.27,
			completionTokenUsdPerMillion: 0.85,
		},
	],
	sandbox: { cpuSecondUsd: 0.00005, gibSecondUsd: 0.00001 },
};

describe("trusted price table parsing", () => {
	test("absent configuration means null (unknown cost), never a guess", () => {
		expect(parseCostPriceTable(undefined)).toBeNull();
		expect(parseCostPriceTable(null)).toBeNull();
	});

	test("blank configuration is treated as absent", () => {
		expect(parseCostPriceTable("")).toBeNull();
		expect(parseCostPriceTable("   \n\t")).toBeNull();
	});

	test("malformed JSON present in config is a bounded validation error", () => {
		try {
			parseCostPriceTable('{"models": [}');
			throw new Error("expected a PlatformError");
		} catch (error) {
			expect(error).toBeInstanceOf(PlatformError);
			const platform = error as PlatformError;
			expect(platform.code).toBe(PRICE_TABLE_ERROR_CODE);
			// The message names the variable and the rule, never the value.
			expect(platform.message).toContain("COST_PRICE_TABLE");
			expect(platform.message).not.toContain("models");
		}
	});

	test("a schema mismatch present in config fails closed", () => {
		expect(() => parseCostPriceTable('{"models": []}')).toThrow(PlatformError);
		expect(() =>
			parseCostPriceTable(
				JSON.stringify({ ...VALID, models: [{ modelId: "" }] }),
			),
		).toThrow(/schema/);
		// Unknown keys are rejected (strict schema), so a typo cannot silently
		// price a run at zero.
		expect(() =>
			parseCostPriceTable(
				JSON.stringify({
					...VALID,
					models: [{ ...VALID.models[0], price: 1 }],
				}),
			),
		).toThrow(PlatformError);
	});

	test("a valid table parses through the shared schema", () => {
		const parsed = parseCostPriceTable(JSON.stringify(VALID));
		expect(parsed).toEqual(VALID);
		expect(costPriceTableSchema.safeParse(parsed).success).toBe(true);
	});

	test("env loading reads only COST_PRICE_TABLE", () => {
		expect(loadCostPriceTable({})).toBeNull();
		expect(loadCostPriceTable({ COST_PRICE_TABLE: " " })).toBeNull();
		expect(
			loadCostPriceTable({ COST_PRICE_TABLE: JSON.stringify(VALID) }),
		).toEqual(VALID);
		expect(() => loadCostPriceTable({ COST_PRICE_TABLE: "not-json" })).toThrow(
			PlatformError,
		);
	});
});
