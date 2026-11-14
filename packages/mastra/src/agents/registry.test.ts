import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import { BASETEN_DEFAULT_MODEL_ID, BASETEN_PROVIDER_ID } from "./baseten";
import { META_MODEL_ID, META_PROVIDER_ID } from "./meta";
import {
	MODEL_CATALOG,
	PROVIDER_CAPABILITY_KEYS,
	resolveModelDescriptor,
	UNKNOWN_PROVIDER_CAPABILITIES,
} from "./registry";

describe("MODEL_CATALOG", () => {
	test("declares exactly the two current hosted models", () => {
		expect(MODEL_CATALOG).toHaveLength(2);
		expect(MODEL_CATALOG.map((descriptor) => descriptor.providerId)).toEqual([
			META_PROVIDER_ID,
			BASETEN_PROVIDER_ID,
		]);
		expect(MODEL_CATALOG.map((descriptor) => descriptor.modelId)).toEqual([
			META_MODEL_ID,
			BASETEN_DEFAULT_MODEL_ID,
		]);
		for (const descriptor of MODEL_CATALOG) {
			expect(descriptor.instanceId).toBe(descriptor.providerId);
			expect(descriptor.priceKey).toBe(descriptor.modelId);
			expect(descriptor.maxOutputTokens).toBe(8192);
			expect(descriptor.supportsToolCalls).toBe(true);
			expect(descriptor.supportsReasoning).toBe(true);
			// No window has been verified: it must stay null, never guessed.
			expect(descriptor.contextWindowTokens).toBeNull();
		}
	});

	test("every descriptor has a complete, non-empty capability record", () => {
		for (const descriptor of MODEL_CATALOG) {
			expect(Object.keys(descriptor.capabilities).sort()).toEqual(
				[...PROVIDER_CAPABILITY_KEYS].sort(),
			);
			expect(Object.values(descriptor.capabilities)).toContain(true);
			// Streaming is not implemented; advertising it would be dishonest.
			expect(descriptor.capabilities.streaming).toBe(false);
		}
	});

	test("the unknown-provider record advertises nothing", () => {
		expect(Object.values(UNKNOWN_PROVIDER_CAPABILITIES)).toEqual([
			false,
			false,
			false,
			false,
			false,
		]);
	});
});

describe("resolveModelDescriptor", () => {
	test("resolves each declared provider", () => {
		expect(resolveModelDescriptor(META_PROVIDER_ID).modelId).toBe(
			META_MODEL_ID,
		);
		expect(resolveModelDescriptor(BASETEN_PROVIDER_ID).modelId).toBe(
			BASETEN_DEFAULT_MODEL_ID,
		);
	});

	test("unknown providers fail closed without echoing the value", () => {
		let caught: unknown;
		try {
			resolveModelDescriptor("openai");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlatformError);
		expect((caught as PlatformError).code).toBe("MISSING_CONFIG");
		expect((caught as PlatformError).message).not.toContain("openai");
	});
});
