import { describe, expect, test } from "bun:test";
import { type ErrorCode, PlatformError } from "@isolate/shared";
import {
	type ConnectorCredentialEnvelope,
	createConnectorCredentialCrypto,
	createConnectorCredentialCryptoFromEnv,
	packConnectorCredentialEnvelope,
	unpackConnectorCredentialEnvelope,
} from "./credential-crypto";

const AAD = {
	organizationId: "11111111-1111-4111-8111-111111111111",
	connectorId: "sentry",
	displayName: "Team Sentry",
};

function randomKeyBase64(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

const PLAINTEXT = JSON.stringify({
	secret: "sntrys_secret_value",
	config: { baseUrl: "https://sentry.example.com", region: "eu" },
});

function expectPlatformError(
	error: unknown,
	code: ErrorCode,
	plaintext?: string,
): void {
	expect(error).toBeInstanceOf(PlatformError);
	const platformError = error as PlatformError;
	expect(platformError.code).toBe(code);
	if (plaintext !== undefined) {
		expect(platformError.message).not.toContain(plaintext);
		expect(platformError.message).not.toContain("sntrys_");
	}
}

async function seal(
	crypto = createConnectorCredentialCrypto({ keyBase64: randomKeyBase64() }),
): Promise<ConnectorCredentialEnvelope> {
	return crypto.seal({ ...AAD, plaintext: PLAINTEXT });
}

describe("connector credential crypto", () => {
	test("roundtrips a UTF-8 payload with a per-secret DEK", async () => {
		const crypto = createConnectorCredentialCrypto({
			keyBase64: randomKeyBase64(),
			keyVersion: 3,
		});
		const envelope = await crypto.seal({
			...AAD,
			plaintext: `${PLAINTEXT} \u00e9\u00e8 \u2713`,
		});
		expect(envelope.keyVersion).toBe(3);
		expect(envelope.nonce).toHaveLength(12);
		expect(envelope.tag).toHaveLength(16);
		expect(envelope.wrappedDek).toHaveLength(60);
		expect(envelope.ciphertext.byteLength).toBeGreaterThan(0);
		expect(
			await crypto.open({
				...AAD,
				envelope,
			}),
		).toBe(`${PLAINTEXT} \u00e9\u00e8 \u2713`);
	});

	test("two seals of the same plaintext use different DEKs and nonces", async () => {
		const crypto = createConnectorCredentialCrypto({
			keyBase64: randomKeyBase64(),
		});
		const first = await crypto.seal({ ...AAD, plaintext: PLAINTEXT });
		const second = await crypto.seal({ ...AAD, plaintext: PLAINTEXT });
		expect(first.wrappedDek).not.toEqual(second.wrappedDek);
		expect(first.nonce).not.toEqual(second.nonce);
		expect(first.ciphertext).not.toEqual(second.ciphertext);
	});

	test("pack/unpack preserves the AEAD output", async () => {
		const envelope = await seal();
		const packed = packConnectorCredentialEnvelope(envelope);
		expect(packed.encryptedPayload.byteLength).toBe(
			envelope.nonce.byteLength +
				envelope.tag.byteLength +
				envelope.ciphertext.byteLength,
		);
		expect(unpackConnectorCredentialEnvelope(packed)).toEqual(envelope);
	});

	test("tampering with any ciphertext part fails authentication", async () => {
		const crypto = createConnectorCredentialCrypto({
			keyBase64: randomKeyBase64(),
		});
		const envelope = await crypto.seal({ ...AAD, plaintext: PLAINTEXT });
		const tampered: ConnectorCredentialEnvelope[] = [];
		for (const field of ["ciphertext", "tag", "nonce", "wrappedDek"] as const) {
			const bytes = new Uint8Array(envelope[field]);
			bytes[0] ^= 0xff;
			tampered.push({ ...envelope, [field]: bytes });
		}
		for (const candidate of tampered) {
			try {
				await crypto.open({ ...AAD, envelope: candidate });
				throw new Error("tampered envelope was accepted");
			} catch (error) {
				expectPlatformError(error, "INTEGRATION_UNAVAILABLE", PLAINTEXT);
			}
		}
	});

	test("a moved ciphertext fails on organization, connector or display-name AAD", async () => {
		const crypto = createConnectorCredentialCrypto({
			keyBase64: randomKeyBase64(),
		});
		const envelope = await crypto.seal({ ...AAD, plaintext: PLAINTEXT });
		const moved = [
			{ ...AAD, organizationId: "22222222-2222-4222-8222-222222222222" },
			{ ...AAD, connectorId: "pagerduty" },
			{ ...AAD, displayName: "Other Sentry" },
		];
		for (const aad of moved) {
			try {
				await crypto.open({ ...aad, envelope });
				throw new Error("moved ciphertext was accepted");
			} catch (error) {
				expectPlatformError(error, "INTEGRATION_UNAVAILABLE", PLAINTEXT);
			}
		}
	});

	test("a different KEK cannot open the envelope", async () => {
		const envelope = await seal();
		const other = createConnectorCredentialCrypto({
			keyBase64: randomKeyBase64(),
		});
		try {
			await other.open({ ...AAD, envelope });
			throw new Error("wrong key was accepted");
		} catch (error) {
			expectPlatformError(error, "INTEGRATION_UNAVAILABLE", PLAINTEXT);
		}
	});

	test("config fails closed without echoing the key", async () => {
		const key = Buffer.from(new Uint8Array(31)).toString("base64");
		for (const options of [
			{ keyBase64: "" },
			{ keyBase64: "not base64 !!" },
			{ keyBase64: key },
			{ keyBase64: randomKeyBase64(), keyVersion: 0 },
			{ keyBase64: randomKeyBase64(), keyVersion: 1.5 },
		]) {
			try {
				createConnectorCredentialCrypto(options);
				throw new Error("invalid key config was accepted");
			} catch (error) {
				expectPlatformError(error, "MISSING_CONFIG");
				if (options.keyBase64.length > 4) {
					expect((error as PlatformError).message).not.toContain(
						options.keyBase64,
					);
				}
			}
		}
	});

	test("reads the KEK and version from the environment", async () => {
		const key = randomKeyBase64();
		const crypto = createConnectorCredentialCryptoFromEnv({
			CONNECTOR_CREDENTIAL_KEY: key,
			CONNECTOR_CREDENTIAL_KEY_VERSION: "4",
		});
		const envelope = await crypto.seal({ ...AAD, plaintext: PLAINTEXT });
		expect(envelope.keyVersion).toBe(4);
		for (const env of [
			{},
			{ CONNECTOR_CREDENTIAL_KEY: key, CONNECTOR_CREDENTIAL_KEY_VERSION: "0" },
			{ CONNECTOR_CREDENTIAL_KEY: key, CONNECTOR_CREDENTIAL_KEY_VERSION: "x" },
		]) {
			try {
				createConnectorCredentialCryptoFromEnv(env);
				throw new Error("invalid environment was accepted");
			} catch (error) {
				expectPlatformError(error, "MISSING_CONFIG");
			}
		}
	});
});
