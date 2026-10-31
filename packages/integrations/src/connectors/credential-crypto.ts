import { PlatformError } from "@isolate/shared";

/**
 * AES-256-GCM envelope encryption for connector credentials.
 *
 * The KEK (`CONNECTOR_CREDENTIAL_KEY`, 32 random bytes base64) never leaves
 * this module and is never serialized. Each secret gets a fresh 32-byte DEK;
 * the payload is sealed under the DEK and the DEK is wrapped under the KEK.
 * AAD is exactly `organizationId|connectorId|displayName|keyVersion`, so a
 * ciphertext moved to another tenant, connector, display name or key version
 * fails authentication.
 *
 * Errors are fixed text: no key, plaintext, nonce or ciphertext fragment ever
 * appears in a message or a cause.
 */

const KEK_BYTES = 32;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = IV_BYTES + TAG_BYTES + DEK_BYTES;
const MAX_PLAINTEXT_BYTES = 16 * 1024;

const ENV_KEY_NAME = "CONNECTOR_CREDENTIAL_KEY";
const ENV_KEY_VERSION_NAME = "CONNECTOR_CREDENTIAL_KEY_VERSION";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type ConnectorCredentialEnvelope = {
	/** DEK sealed under the KEK: iv || tag || wrapped ciphertext. */
	readonly wrappedDek: Uint8Array;
	readonly nonce: Uint8Array;
	readonly ciphertext: Uint8Array;
	readonly tag: Uint8Array;
	readonly keyVersion: number;
};

/** Wire shape persisted in `encrypted_payload` + `wrapped_dek`. */
export type ConnectorCredentialCiphertext = {
	readonly encryptedPayload: Uint8Array;
	readonly wrappedDek: Uint8Array;
	readonly keyVersion: number;
};

export type ConnectorCredentialAad = {
	organizationId: string;
	connectorId: string;
	displayName: string;
};

export type ConnectorCredentialCrypto = {
	seal(
		input: ConnectorCredentialAad & { plaintext: string },
	): Promise<ConnectorCredentialEnvelope>;
	open(
		input: ConnectorCredentialAad & {
			envelope: ConnectorCredentialEnvelope;
		},
	): Promise<string>;
};

export type ConnectorCredentialCryptoOptions = {
	keyBase64: string;
	keyVersion?: number;
};

function configError(message: string): PlatformError {
	return new PlatformError("MISSING_CONFIG", message);
}

function decryptError(): PlatformError {
	return new PlatformError(
		"INTEGRATION_UNAVAILABLE",
		"connector credential could not be decrypted",
	);
}

function requireAadText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			`credential ${field} must be a non-empty string`,
		);
	}
	return value;
}

function parseKeyVersion(value: unknown): number {
	if (value === undefined) return 1;
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw configError(
			"connector credential key version must be a positive integer",
		);
	}
	return value as number;
}

function decodeKek(keyBase64: unknown): Uint8Array {
	const text = typeof keyBase64 === "string" ? keyBase64.trim() : "";
	if (text.length === 0) {
		throw configError(`connector credential key (${ENV_KEY_NAME}) is required`);
	}
	if (!BASE64_PATTERN.test(text)) {
		throw configError("connector credential key must be base64");
	}
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		throw configError("connector credential key must be base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	if (bytes.byteLength !== KEK_BYTES) {
		throw configError(
			`connector credential key must decode to ${KEK_BYTES} bytes`,
		);
	}
	return bytes;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer as ArrayBuffer;
}

function buildAad(
	input: ConnectorCredentialAad & { keyVersion: number },
): Uint8Array {
	return new TextEncoder().encode(
		`${input.organizationId}|${input.connectorId}|${input.displayName}|${input.keyVersion}`,
	);
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	globalThis.crypto.getRandomValues(bytes);
	return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}
	return joined;
}

function requireEnvelope(
	envelope: ConnectorCredentialEnvelope,
): ConnectorCredentialEnvelope {
	if (
		!(envelope.wrappedDek instanceof Uint8Array) ||
		envelope.wrappedDek.byteLength !== WRAPPED_DEK_BYTES ||
		!(envelope.nonce instanceof Uint8Array) ||
		envelope.nonce.byteLength !== IV_BYTES ||
		!(envelope.ciphertext instanceof Uint8Array) ||
		envelope.ciphertext.byteLength === 0 ||
		!(envelope.tag instanceof Uint8Array) ||
		envelope.tag.byteLength !== TAG_BYTES ||
		!Number.isSafeInteger(envelope.keyVersion) ||
		envelope.keyVersion < 1
	) {
		throw decryptError();
	}
	return envelope;
}

/**
 * Packs the AEAD output into the two database bytea columns. Layout is
 * nonce || tag || ciphertext; the lengths are fixed except for ciphertext.
 */
export function packConnectorCredentialEnvelope(
	envelope: ConnectorCredentialEnvelope,
): ConnectorCredentialCiphertext {
	requireEnvelope(envelope);
	return {
		encryptedPayload: concatBytes(
			envelope.nonce,
			envelope.tag,
			envelope.ciphertext,
		),
		wrappedDek: new Uint8Array(envelope.wrappedDek),
		keyVersion: envelope.keyVersion,
	};
}

export function unpackConnectorCredentialEnvelope(
	ciphertext: ConnectorCredentialCiphertext,
): ConnectorCredentialEnvelope {
	const payload = ciphertext.encryptedPayload;
	if (
		!(payload instanceof Uint8Array) ||
		payload.byteLength <= IV_BYTES + TAG_BYTES ||
		!(ciphertext.wrappedDek instanceof Uint8Array)
	) {
		throw decryptError();
	}
	return requireEnvelope({
		nonce: payload.slice(0, IV_BYTES),
		tag: payload.slice(IV_BYTES, IV_BYTES + TAG_BYTES),
		ciphertext: payload.slice(IV_BYTES + TAG_BYTES),
		wrappedDek: new Uint8Array(ciphertext.wrappedDek),
		keyVersion: ciphertext.keyVersion,
	});
}

export function createConnectorCredentialCrypto(
	options: ConnectorCredentialCryptoOptions,
): ConnectorCredentialCrypto {
	const kekBytes = decodeKek(options.keyBase64);
	const keyVersion = parseKeyVersion(options.keyVersion);
	let kekPromise: Promise<CryptoKey> | null = null;

	const importKek = (): Promise<CryptoKey> => {
		if (kekPromise === null) {
			kekPromise = globalThis.crypto.subtle
				.importKey("raw", asBuffer(kekBytes), { name: "AES-GCM" }, false, [
					"encrypt",
					"decrypt",
				])
				.catch(() => {
					throw configError("connector credential key could not be imported");
				});
		}
		return kekPromise;
	};

	return {
		async seal(input) {
			const organizationId = requireAadText(
				input.organizationId,
				"organizationId",
			);
			const connectorId = requireAadText(input.connectorId, "connectorId");
			const displayName = requireAadText(input.displayName, "displayName");
			if (typeof input.plaintext !== "string" || input.plaintext.length === 0) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					"credential plaintext must be a non-empty string",
				);
			}
			const plaintext = new TextEncoder().encode(input.plaintext);
			if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
				throw new PlatformError(
					"VALIDATION_FAILED",
					`credential plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`,
				);
			}
			const aad = buildAad({
				organizationId,
				connectorId,
				displayName,
				keyVersion,
			});
			try {
				const dekBytes = randomBytes(DEK_BYTES);
				const dek = await globalThis.crypto.subtle.importKey(
					"raw",
					asBuffer(dekBytes),
					{ name: "AES-GCM" },
					false,
					["encrypt"],
				);
				const nonce = randomBytes(IV_BYTES);
				const sealed = await globalThis.crypto.subtle.encrypt(
					{
						name: "AES-GCM",
						iv: asBuffer(nonce),
						additionalData: asBuffer(aad),
					},
					dek,
					asBuffer(plaintext),
				);
				const sealedBytes = new Uint8Array(sealed);
				const tag = sealedBytes.slice(sealedBytes.byteLength - TAG_BYTES);
				const ciphertext = sealedBytes.slice(
					0,
					sealedBytes.byteLength - TAG_BYTES,
				);

				const kek = await importKek();
				const wrapNonce = randomBytes(IV_BYTES);
				const wrapped = await globalThis.crypto.subtle.encrypt(
					{
						name: "AES-GCM",
						iv: asBuffer(wrapNonce),
						additionalData: asBuffer(aad),
					},
					kek,
					asBuffer(dekBytes),
				);
				const wrappedBytes = new Uint8Array(wrapped);
				const wrappedTag = wrappedBytes.slice(
					wrappedBytes.byteLength - TAG_BYTES,
				);
				const wrappedCiphertext = wrappedBytes.slice(
					0,
					wrappedBytes.byteLength - TAG_BYTES,
				);
				return {
					wrappedDek: concatBytes(wrapNonce, wrappedTag, wrappedCiphertext),
					nonce,
					ciphertext,
					tag,
					keyVersion,
				};
			} catch (error) {
				if (error instanceof PlatformError) throw error;
				throw new PlatformError(
					"INTERNAL",
					"connector credential could not be encrypted",
				);
			}
		},

		async open(input) {
			const organizationId = requireAadText(
				input.organizationId,
				"organizationId",
			);
			const connectorId = requireAadText(input.connectorId, "connectorId");
			const displayName = requireAadText(input.displayName, "displayName");
			const envelope = requireEnvelope(input.envelope);
			const aad = buildAad({
				organizationId,
				connectorId,
				displayName,
				keyVersion: envelope.keyVersion,
			});
			try {
				const kek = await importKek();
				const wrapped = envelope.wrappedDek;
				const wrapNonce = wrapped.slice(0, IV_BYTES);
				const wrapTag = wrapped.slice(IV_BYTES, IV_BYTES + TAG_BYTES);
				const wrappedCiphertext = wrapped.slice(IV_BYTES + TAG_BYTES);
				const dekBytes = new Uint8Array(
					await globalThis.crypto.subtle.decrypt(
						{
							name: "AES-GCM",
							iv: asBuffer(wrapNonce),
							additionalData: asBuffer(aad),
							tagLength: 128,
						},
						kek,
						asBuffer(concatBytes(wrappedCiphertext, wrapTag)),
					),
				);
				const dek = await globalThis.crypto.subtle.importKey(
					"raw",
					asBuffer(dekBytes),
					{ name: "AES-GCM" },
					false,
					["decrypt"],
				);
				const opened = await globalThis.crypto.subtle.decrypt(
					{
						name: "AES-GCM",
						iv: asBuffer(envelope.nonce),
						additionalData: asBuffer(aad),
						tagLength: 128,
					},
					dek,
					asBuffer(concatBytes(envelope.ciphertext, envelope.tag)),
				);
				return new TextDecoder().decode(opened);
			} catch {
				throw decryptError();
			}
		},
	};
}

/**
 * Reads the KEK from the deployment environment. Missing, malformed or
 * wrong-length values fail closed as `MISSING_CONFIG`; the value itself is
 * never included in the error.
 */
export function createConnectorCredentialCryptoFromEnv(
	env: Record<string, string | undefined> = process.env,
): ConnectorCredentialCrypto {
	const keyBase64 = env[ENV_KEY_NAME];
	if (typeof keyBase64 !== "string" || keyBase64.trim().length === 0) {
		throw configError(`connector credential key (${ENV_KEY_NAME}) is required`);
	}
	const rawVersion = env[ENV_KEY_VERSION_NAME];
	let keyVersion = 1;
	if (rawVersion !== undefined && rawVersion.trim().length > 0) {
		const parsed = Number(rawVersion);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw configError(
				"connector credential key version must be a positive integer",
			);
		}
		keyVersion = parsed;
	}
	return createConnectorCredentialCrypto({ keyBase64, keyVersion });
}
