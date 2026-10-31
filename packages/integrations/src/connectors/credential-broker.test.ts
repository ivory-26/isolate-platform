import { describe, expect, test } from "bun:test";
import type { ConnectorCredentialSummary } from "@isolate/shared";
import {
	asOrganizationId,
	type ErrorCode,
	PlatformError,
} from "@isolate/shared";
import {
	type ConnectorCredentialBroker,
	type ConnectorCredentialReader,
	type ConnectorStoredSecret,
	createConnectorCredentialBroker,
} from "./credential-broker";
import {
	createConnectorCredentialCrypto,
	packConnectorCredentialEnvelope,
} from "./credential-crypto";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const ENV_SECRET = "env-fallback-secret-value";
const SECRET = "stored-secret-value";

function randomKeyBase64(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

const crypto = createConnectorCredentialCrypto({
	keyBase64: randomKeyBase64(),
});

function summary(
	overrides: Partial<ConnectorCredentialSummary> = {},
): ConnectorCredentialSummary {
	return {
		id: globalThis.crypto.randomUUID(),
		organizationId: ORG_A,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		scopes: ["issues:read"],
		status: "active",
		freeTierProfile: {
			requestsPerMinute: null,
			requestsPerDay: null,
			eventsPerMonth: 5000,
			retentionDays: 30,
		},
		metadata: {},
		keyVersion: 1,
		lastValidatedAt: new Date("2026-10-31T12:00:00.000Z"),
		lastUsedAt: null,
		createdAt: new Date("2026-10-31T11:00:00.000Z"),
		updatedAt: new Date("2026-10-31T12:00:00.000Z"),
		...overrides,
	};
}

class TestReader implements ConnectorCredentialReader {
	readonly rows = new Map<string, ConnectorStoredSecret>();
	readonly getSecretCalls: { organizationId: string; credentialId: string }[] =
		[];

	async listByOrganization(
		organizationId: string,
	): Promise<ConnectorCredentialSummary[]> {
		return [...this.rows.values()]
			.map((row) => row.credential)
			.filter((row) => row.organizationId === organizationId);
	}

	async getSecret(
		organizationId: string,
		credentialId: string,
	): Promise<ConnectorStoredSecret | null> {
		this.getSecretCalls.push({ organizationId, credentialId });
		const row = this.rows.get(credentialId);
		return row !== undefined && row.credential.organizationId === organizationId
			? row
			: null;
	}
}

async function seed(
	reader: TestReader,
	overrides: Partial<ConnectorCredentialSummary> = {},
	plaintext = JSON.stringify({
		secret: SECRET,
		config: { baseUrl: "https://sentry.example.com" },
	}),
): Promise<ConnectorCredentialSummary> {
	const credential = summary(overrides);
	const envelope = await crypto.seal({
		organizationId: credential.organizationId,
		connectorId: credential.connectorId,
		displayName: credential.displayName,
		plaintext,
	});
	const packed = packConnectorCredentialEnvelope(envelope);
	reader.rows.set(credential.id, {
		credential,
		encryptedPayload: packed.encryptedPayload,
		wrappedDek: packed.wrappedDek,
		keyVersion: packed.keyVersion,
	});
	return credential;
}

function broker(
	reader: ConnectorCredentialReader,
	options: {
		allowEnvFallback?: boolean;
		envLookup?: Parameters<
			typeof createConnectorCredentialBroker
		>[0]["envLookup"];
	} = {},
): ConnectorCredentialBroker {
	return createConnectorCredentialBroker({
		credentials: reader,
		crypto,
		allowEnvFallback: options.allowEnvFallback,
		envLookup: options.envLookup,
	});
}

async function expectCode(
	promise: Promise<unknown>,
	code: ErrorCode,
): Promise<PlatformError> {
	try {
		await promise;
		throw new Error("resolve unexpectedly succeeded");
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformError);
		const platformError = error as PlatformError;
		expect(platformError.code).toBe(code);
		return platformError;
	}
}

describe("connector credential broker", () => {
	test("resolves an active credential into a callback only", async () => {
		const reader = new TestReader();
		const credential = await seed(reader);
		let captured: unknown;
		const result = await broker(reader).resolve(ORG_A, "sentry", (material) => {
			captured = material;
			return "done";
		});
		expect(result).toBe("done");
		expect(captured).toEqual({
			secret: SECRET,
			config: { baseUrl: "https://sentry.example.com" },
			scopes: ["issues:read"],
		});
		expect(reader.getSecretCalls).toEqual([
			{ organizationId: ORG_A, credentialId: credential.id },
		]);
	});

	test("pending, invalid and revoked rows are unavailable and never decrypted", async () => {
		for (const status of [
			"pending_validation",
			"invalid",
			"revoked",
		] as const) {
			const reader = new TestReader();
			await seed(reader, { status });
			const callback = () => {
				throw new Error("callback must not run");
			};
			await expectCode(
				broker(reader).resolve(ORG_A, "sentry", callback),
				"INTEGRATION_UNAVAILABLE",
			);
			expect(reader.getSecretCalls).toHaveLength(0);
		}
	});

	test("a credential of another tenant is invisible", async () => {
		const reader = new TestReader();
		await seed(reader);
		const error = await expectCode(
			broker(reader).resolve(ORG_B, "sentry", () => "leaked"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(error.message).not.toContain(SECRET);
		expect(error.message).not.toContain("wrapped");
		expect(reader.getSecretCalls).toHaveLength(0);
	});

	test("tampered or non-JSON ciphertext fails closed without leaking", async () => {
		const reader = new TestReader();
		const credential = await seed(reader);
		const stored = reader.rows.get(credential.id);
		if (stored === undefined) throw new Error("seed failed");
		stored.encryptedPayload[0] ^= 0xff;
		const error = await expectCode(
			broker(reader).resolve(ORG_A, "sentry", () => "leaked"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(error.message).not.toContain(SECRET);

		const second = new TestReader();
		await seed(second, {}, JSON.stringify({ config: {} }));
		await expectCode(
			broker(second).resolve(ORG_A, "sentry", () => "leaked"),
			"INTEGRATION_UNAVAILABLE",
		);
	});

	test("the environment fallback is off by default", async () => {
		const reader = new TestReader();
		let lookups = 0;
		const instance = broker(reader, {
			envLookup: () => {
				lookups += 1;
				return { secret: ENV_SECRET, config: {}, scopes: [] };
			},
		});
		const error = await expectCode(
			instance.resolve(ORG_A, "sentry", () => "leaked"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(lookups).toBe(0);
		expect(error.message).not.toContain(ENV_SECRET);
	});

	test("an explicit environment fallback serves a single-tenant bridge", async () => {
		const reader = new TestReader();
		const lookedUp: string[] = [];
		const instance = broker(reader, {
			allowEnvFallback: true,
			envLookup: (connectorId) => {
				lookedUp.push(connectorId);
				return { secret: ENV_SECRET, config: {}, scopes: ["read"] };
			},
		});
		const material = await instance.resolve(
			ORG_A,
			"sentry",
			(current) => current,
		);
		expect(lookedUp).toEqual(["sentry"]);
		expect(material).toEqual({
			secret: ENV_SECRET,
			config: {},
			scopes: ["read"],
		});
	});

	test("an active row wins over the environment fallback", async () => {
		const reader = new TestReader();
		await seed(reader);
		let lookups = 0;
		const material = await broker(reader, {
			allowEnvFallback: true,
			envLookup: () => {
				lookups += 1;
				return { secret: ENV_SECRET, config: {}, scopes: [] };
			},
		}).resolve(ORG_A, "sentry", (current) => current);
		expect(lookups).toBe(0);
		expect(material.secret).toBe(SECRET);
	});

	test("invalid ids and a missing fallback lookup fail fast", async () => {
		const reader = new TestReader();
		await expectCode(
			broker(reader).resolve(ORG_A, "Sentry", () => "x"),
			"VALIDATION_FAILED",
		);
		await expectCode(
			broker(reader).resolve(ORG_A, "sentry", () => "x"),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(() =>
			createConnectorCredentialBroker({
				credentials: reader,
				crypto,
				allowEnvFallback: true,
			}),
		).toThrow(PlatformError);
	});
});
