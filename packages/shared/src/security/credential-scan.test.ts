import { describe, expect, test } from "bun:test";
import { PlatformError } from "../types/errors";
import {
	assertNoCredentialMaterial,
	findCredentialMaterial,
	isCredentialMaterialKey,
	MAX_CREDENTIAL_SCAN_DEPTH,
} from "./credential-scan";

const GITHUB_TOKEN = `ghp_${"a".repeat(30)}`;
const OPENAI_KEY = `sk-proj-${"A".repeat(32)}`;
const JWT = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(10)}`;

describe("findCredentialMaterial", () => {
	test("flags nested authorization headers and reports the path", () => {
		const hit = findCredentialMaterial({
			headers: { authorization: `Bearer ${"x".repeat(20)}` },
		});
		expect(hit).toEqual({
			path: "$.headers.authorization",
			reason: "credential-shaped key",
		});
	});

	test("flags credential values under innocuous keys", () => {
		expect(findCredentialMaterial({ note: OPENAI_KEY })).toEqual({
			path: "$.note",
			reason: "credential-shaped value",
		});
		expect(
			findCredentialMaterial({ note: `deploy ${GITHUB_TOKEN}` }),
		).not.toBeNull();
		expect(findCredentialMaterial({ note: JWT })).not.toBeNull();
		expect(
			findCredentialMaterial({ note: "-----BEGIN RSA PRIVATE KEY-----" }),
		).not.toBeNull();
		expect(
			findCredentialMaterial({ note: "AKIA-REDACTED-SAMPLE" }),
		).not.toBeNull();
		expect(
			findCredentialMaterial({ note: "xoxb-1234567890-abcdef" }),
		).not.toBeNull();
		expect(
			findCredentialMaterial({ note: `github_pat_${"A".repeat(30)}` }),
		).not.toBeNull();
	});

	test("flags credential-shaped keys in every spelling variant", () => {
		for (const key of [
			"authorization",
			"Authorization",
			"apiKey",
			"api_key",
			"api-key",
			"accessToken",
			"access_token",
			"refreshToken",
			"clientSecret",
			"client_secret",
			"privateKey",
			"private_key",
			"secret",
			"password",
			"bearer",
			"token",
			"cookie",
			"sessionId",
			"session_id",
			"accessKey",
			"access_key",
			"headers.authorization",
		]) {
			expect(isCredentialMaterialKey(key)).toBe(true);
			expect(findCredentialMaterial({ [key]: "plain" })).not.toBeNull();
		}
	});

	test("allows ordinary metadata keys that merely contain a denylisted word", () => {
		for (const key of [
			"tokenCount",
			"tokenBudget",
			"expiresAt",
			"tokens",
			"enabledTools",
			"issueId",
			"secretary",
		]) {
			expect(isCredentialMaterialKey(key)).toBe(false);
		}
		expect(
			findCredentialMaterial({ tokenBudget: 1000, tokenCount: 12 }),
		).toBeNull();
	});

	test("walks arrays and reports bracket paths", () => {
		const hit = findCredentialMaterial({
			items: [{ name: "ok" }, { authorization: "x" }],
		});
		expect(hit?.path).toBe("$.items[1].authorization");
	});

	test("stops at the depth cap and honors an explicit maxDepth", () => {
		// `nest(n)` places the object holding `token` at depth n.
		const nest = (levels: number): Record<string, unknown> => {
			let node: Record<string, unknown> = { token: "x" };
			for (let index = 0; index < levels; index += 1) node = { a: node };
			return node;
		};
		expect(
			findCredentialMaterial(nest(MAX_CREDENTIAL_SCAN_DEPTH)),
		).not.toBeNull();
		expect(
			findCredentialMaterial(nest(MAX_CREDENTIAL_SCAN_DEPTH + 1)),
		).toBeNull();
		expect(
			findCredentialMaterial(nest(MAX_CREDENTIAL_SCAN_DEPTH + 1), {
				maxDepth: MAX_CREDENTIAL_SCAN_DEPTH + 1,
			}),
		).not.toBeNull();
	});

	test("returns the first hit in traversal order", () => {
		const hit = findCredentialMaterial({
			first: { note: GITHUB_TOKEN },
			second: { password: "x" },
		});
		expect(hit?.path).toBe("$.first.note");
	});

	test("tolerates cycles, class instances and primitives", () => {
		const cyclic: Record<string, unknown> = { ok: true };
		cyclic.self = cyclic;
		expect(findCredentialMaterial(cyclic)).toBeNull();
		expect(findCredentialMaterial(new Date())).toBeNull();
		expect(findCredentialMaterial(null)).toBeNull();
		expect(findCredentialMaterial("plain text")).toBeNull();
	});
});

describe("assertNoCredentialMaterial", () => {
	test("throws one fixed, value-free VALIDATION_FAILED", () => {
		try {
			assertNoCredentialMaterial({ nested: { apiKey: OPENAI_KEY } });
			throw new Error("expected a rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(PlatformError);
			const platformError = error as PlatformError;
			expect(platformError.code).toBe("VALIDATION_FAILED");
			expect(platformError.message).toBe("credential material is not allowed");
			expect(platformError.message).not.toContain("sk-proj");
			expect(platformError.message).not.toContain(OPENAI_KEY);
			expect(platformError.message).not.toContain("apiKey");
		}
	});

	test("accepts ordinary bounded metadata", () => {
		expect(() =>
			assertNoCredentialMaterial({
				tokenBudget: 1000,
				tokenCount: 3,
				expiresAt: "2026-11-01T00:00:00.000Z",
				labels: ["prod", "web"],
			}),
		).not.toThrow();
	});

	test("honors a deeper maxDepth for boundaries with a deeper JSON cap", () => {
		const nest = (levels: number): Record<string, unknown> => {
			let node: Record<string, unknown> = { password: "x" };
			for (let index = 0; index < levels; index += 1) node = { a: node };
			return node;
		};
		expect(() => assertNoCredentialMaterial(nest(8))).not.toThrow();
		expect(() => assertNoCredentialMaterial(nest(8), { maxDepth: 8 })).toThrow(
			PlatformError,
		);
	});
});
