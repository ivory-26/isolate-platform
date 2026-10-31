import { createHash, timingSafeEqual } from "node:crypto";
import { PlatformError } from "@isolate/shared";

/**
 * Device authentication tokens.
 *
 * A device token is 256 random bits encoded as base64url (43 characters). The
 * platform stores only its sha256 hex digest (`connector_devices.token_hash`);
 * the token itself lives on the user's device and is never logged, echoed or
 * persisted. Verification recomputes the digest and compares in constant time.
 *
 * Every error is fixed text and contains no token material.
 */

export const CONNECTOR_DEVICE_TOKEN_BYTES = 32;
export const CONNECTOR_DEVICE_TOKEN_CHARS = 43;
export const CONNECTOR_DEVICE_TOKEN_HASH_CHARS = 64;
export const MAX_CONNECTOR_DEVICE_TOKEN_CHARS = 512;

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function invalidToken(): PlatformError {
	return new PlatformError(
		"VALIDATION_FAILED",
		"connector device token is invalid",
	);
}

/** Generates a fresh 256-bit device token (base64url, no padding). */
export function generateConnectorDeviceToken(): string {
	const bytes = new Uint8Array(CONNECTOR_DEVICE_TOKEN_BYTES);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/** True for the canonical base64url shape produced by the generator. */
export function isConnectorDeviceToken(value: unknown): value is string {
	return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** True for a lowercase sha256 hex digest. */
export function isConnectorDeviceTokenHash(value: unknown): value is string {
	return typeof value === "string" && TOKEN_HASH_PATTERN.test(value);
}

/**
 * sha256 hex of a presented device token. Accepts any bounded string so a
 * non-canonical bearer token can be hashed and compared to no effect; rejects
 * empty and oversized input with fixed text.
 */
export function hashConnectorDeviceToken(token: unknown): string {
	if (
		typeof token !== "string" ||
		token.length === 0 ||
		token.length > MAX_CONNECTOR_DEVICE_TOKEN_CHARS
	) {
		throw invalidToken();
	}
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented token against a stored sha256 hex
 * digest. Malformed input is a non-match, never an error, so an auth check
 * fails closed.
 */
export function verifyConnectorDeviceToken(
	token: unknown,
	expectedHash: unknown,
): boolean {
	if (
		typeof token !== "string" ||
		token.length === 0 ||
		token.length > MAX_CONNECTOR_DEVICE_TOKEN_CHARS ||
		!isConnectorDeviceTokenHash(expectedHash)
	) {
		return false;
	}
	const actual = createHash("sha256").update(token, "utf8").digest();
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
