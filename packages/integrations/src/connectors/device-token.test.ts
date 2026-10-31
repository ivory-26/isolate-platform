import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	CONNECTOR_DEVICE_TOKEN_CHARS,
	CONNECTOR_DEVICE_TOKEN_HASH_CHARS,
	generateConnectorDeviceToken,
	hashConnectorDeviceToken,
	isConnectorDeviceToken,
	isConnectorDeviceTokenHash,
	MAX_CONNECTOR_DEVICE_TOKEN_CHARS,
	verifyConnectorDeviceToken,
} from "./device-token";

describe("connector device tokens", () => {
	test("generate returns 43 base64url characters and never repeats", () => {
		const tokens = new Set<string>();
		for (let index = 0; index < 100; index += 1) {
			const token = generateConnectorDeviceToken();
			expect(token).toHaveLength(CONNECTOR_DEVICE_TOKEN_CHARS);
			expect(isConnectorDeviceToken(token)).toBe(true);
			expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(token).not.toContain("=");
			tokens.add(token);
		}
		expect(tokens.size).toBe(100);
	});

	test("hash returns a deterministic sha256 hex digest", () => {
		const token = generateConnectorDeviceToken();
		const digest = hashConnectorDeviceToken(token);
		expect(digest).toHaveLength(CONNECTOR_DEVICE_TOKEN_HASH_CHARS);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(isConnectorDeviceTokenHash(digest)).toBe(true);
		expect(hashConnectorDeviceToken(token)).toBe(digest);
		expect(hashConnectorDeviceToken(generateConnectorDeviceToken())).not.toBe(
			digest,
		);
	});

	test("verify accepts the matching token and rejects everything else", () => {
		const token = generateConnectorDeviceToken();
		const digest = hashConnectorDeviceToken(token);
		expect(verifyConnectorDeviceToken(token, digest)).toBe(true);
		expect(
			verifyConnectorDeviceToken(generateConnectorDeviceToken(), digest),
		).toBe(false);
		expect(verifyConnectorDeviceToken(token, "not-a-hash")).toBe(false);
		expect(verifyConnectorDeviceToken(token, digest.toUpperCase())).toBe(false);
		expect(verifyConnectorDeviceToken("", digest)).toBe(false);
		expect(verifyConnectorDeviceToken(null, digest)).toBe(false);
		expect(verifyConnectorDeviceToken(token, null)).toBe(false);
	});

	test("hash rejects empty and oversized input with fixed, token-free text", () => {
		for (const invalid of ["", null, undefined, 42, "x".repeat(513)]) {
			try {
				hashConnectorDeviceToken(invalid);
				throw new Error("hash unexpectedly succeeded");
			} catch (error) {
				expect(error).toBeInstanceOf(PlatformError);
				const platformError = error as PlatformError;
				expect(platformError.code).toBe("VALIDATION_FAILED");
				expect(platformError.message).toBe("connector device token is invalid");
			}
		}
	});

	test("a generated token never appears in an error or a digest", () => {
		const token = generateConnectorDeviceToken();
		const digest = hashConnectorDeviceToken(token);
		expect(digest).not.toContain(token);
		expect(JSON.stringify({ digest })).not.toContain(token);
		for (const invalid of [
			null,
			"",
			"x".repeat(MAX_CONNECTOR_DEVICE_TOKEN_CHARS + 1),
		]) {
			try {
				hashConnectorDeviceToken(invalid);
			} catch (error) {
				expect(String(error)).not.toContain(token);
				expect((error as PlatformError).message).not.toContain(token);
			}
		}
		expect(isConnectorDeviceToken("short")).toBe(false);
		expect(isConnectorDeviceToken("a".repeat(43))).toBe(true);
		expect(isConnectorDeviceToken(`${"a".repeat(42)}!`)).toBe(false);
	});
});
