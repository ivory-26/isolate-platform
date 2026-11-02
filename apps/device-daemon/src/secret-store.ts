import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
	assertNoCredentialMaterial,
	connectorCredentialRefSchema,
} from "@isolate/shared";
import { DEVICE_TOKEN_PATTERN } from "./config";

/**
 * Encrypted device-local secret store (`~/.isolate/secrets.json`).
 *
 * A provider secret received through the localhost pairing page is written
 * here and nowhere else: the server, logs, URLs and the config file never see
 * it. Each entry is AES-256-GCM with a random 96-bit IV and the credential ref
 * as associated data, so moving a ciphertext between entries fails
 * authentication. The 256-bit key is derived with HKDF-SHA256 from the device
 * token plus a random per-file salt; a different token cannot decrypt the file
 * and a tampered byte is detected.
 *
 * The file is written 0600 through a temp file and an atomic rename. Every
 * failure is a fixed message that never contains a secret, a field value or a
 * ciphertext fragment.
 */

export const SECRET_STORE_VERSION = 1;
export const SECRET_STORE_HKDF_INFO = "isolate-device-secrets-v1";
export const SECRET_STORE_KEY_BYTES = 32;
export const SECRET_STORE_SALT_BYTES = 16;
export const SECRET_STORE_IV_BYTES = 12;
export const SECRET_STORE_TAG_BYTES = 16;
export const SECRET_STORE_MAX_FIELDS = 16;
export const SECRET_STORE_MAX_FIELD_CHARS = 32_768;
export const SECRET_STORE_MAX_TOTAL_BYTES = 64 * 1024;
export const SECRET_STORE_MAX_SELECTORS = 16;
export const SECRET_STORE_MAX_SELECTOR_CHARS = 512;

export const DEVICE_SECRET_STORE_ERROR_CODES = [
	"INVALID_INPUT",
	"IO_ERROR",
	"CORRUPT",
	"DECRYPT_FAILED",
] as const;
export type DeviceSecretStoreErrorCode =
	(typeof DEVICE_SECRET_STORE_ERROR_CODES)[number];

const ERROR_MESSAGES: Record<DeviceSecretStoreErrorCode, string> = {
	INVALID_INPUT: "device secret store input is invalid",
	IO_ERROR: "device secret store could not be read or written",
	CORRUPT: "device secret store file is corrupt",
	DECRYPT_FAILED: "device secret store could not be decrypted",
};

export class DeviceSecretStoreError extends Error {
	readonly code: DeviceSecretStoreErrorCode;

	constructor(code: DeviceSecretStoreErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "DeviceSecretStoreError";
		this.code = code;
	}
}

const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SecretEntry = {
	readonly fields: Readonly<Record<string, string>>;
	readonly selectors: Readonly<Record<string, string>>;
};

export type SetSecretInput = {
	fields: Record<string, string>;
	selectors?: Record<string, string>;
};

export type SecretStore = {
	readonly path: string;
	getFields(credentialRef: string): Readonly<Record<string, string>> | null;
	getSelectors(credentialRef: string): Readonly<Record<string, string>> | null;
	setSecret(credentialRef: string, input: SetSecretInput): Promise<void>;
	removeSecret(credentialRef: string): Promise<boolean>;
	refs(): string[];
	reload(): Promise<void>;
};

type EncryptedEntry = {
	iv: string;
	tag: string;
	data: string;
};

type FileShape = {
	salt: Buffer;
	entries: Map<string, EncryptedEntry>;
};

function hasForbiddenControl(value: string, allowWhitespace: boolean): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f) return true;
		if (code < 0x20) {
			if (
				allowWhitespace &&
				(code === 0x09 || code === 0x0a || code === 0x0d)
			) {
				continue;
			}
			return true;
		}
	}
	return false;
}

function normalizeCredentialRef(value: unknown): string {
	const parsed = connectorCredentialRefSchema.safeParse(value);
	if (!parsed.success || hasForbiddenControl(parsed.data, false)) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	return parsed.data;
}

function normalizeFields(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0 || entries.length > SECRET_STORE_MAX_FIELDS) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	const fields: Record<string, string> = Object.create(null);
	let total = 0;
	for (const [key, fieldValue] of entries) {
		if (!FIELD_KEY_PATTERN.test(key)) {
			throw new DeviceSecretStoreError("INVALID_INPUT");
		}
		if (typeof fieldValue !== "string") {
			throw new DeviceSecretStoreError("INVALID_INPUT");
		}
		const trimmed = fieldValue.trim();
		if (
			trimmed.length === 0 ||
			fieldValue.length > SECRET_STORE_MAX_FIELD_CHARS ||
			hasForbiddenControl(fieldValue, true)
		) {
			throw new DeviceSecretStoreError("INVALID_INPUT");
		}
		total += Buffer.byteLength(fieldValue, "utf8");
		fields[key] = fieldValue;
	}
	if (total > SECRET_STORE_MAX_TOTAL_BYTES) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	return fields;
}

/**
 * Selectors are non-secret descriptors stored beside the secret (org slug,
 * base URL). They are credential-scanned, so a pasted key is refused here.
 */
function normalizeSelectors(value: unknown): Record<string, string> {
	if (value === undefined) return Object.create(null);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > SECRET_STORE_MAX_SELECTORS) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	const selectors: Record<string, string> = Object.create(null);
	for (const [key, selectorValue] of entries) {
		if (!FIELD_KEY_PATTERN.test(key)) {
			throw new DeviceSecretStoreError("INVALID_INPUT");
		}
		if (
			typeof selectorValue !== "string" ||
			selectorValue.length > SECRET_STORE_MAX_SELECTOR_CHARS ||
			hasForbiddenControl(selectorValue, false)
		) {
			throw new DeviceSecretStoreError("INVALID_INPUT");
		}
		selectors[key] = selectorValue;
	}
	try {
		assertNoCredentialMaterial(selectors, { maxDepth: 2 });
	} catch {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	return selectors;
}

function deriveKey(deviceToken: string, salt: Buffer): Buffer {
	return Buffer.from(
		hkdfSync(
			"sha256",
			Buffer.from(deviceToken, "utf8"),
			salt,
			Buffer.from(SECRET_STORE_HKDF_INFO, "utf8"),
			SECRET_STORE_KEY_BYTES,
		),
	);
}

function entryAad(credentialRef: string): Buffer {
	return Buffer.from(`isolate:secrets:v1:${credentialRef}`, "utf8");
}

function encryptEntry(
	key: Buffer,
	credentialRef: string,
	entry: SecretEntry,
): EncryptedEntry {
	const iv = randomBytes(SECRET_STORE_IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(entryAad(credentialRef));
	const plaintext = JSON.stringify({
		fields: entry.fields,
		selectors: entry.selectors,
	});
	const data = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return {
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: data.toString("base64"),
	};
}

function decryptEntry(
	key: Buffer,
	credentialRef: string,
	entry: EncryptedEntry,
): SecretEntry {
	let iv: Buffer;
	let tag: Buffer;
	let data: Buffer;
	try {
		iv = Buffer.from(entry.iv, "base64");
		tag = Buffer.from(entry.tag, "base64");
		data = Buffer.from(entry.data, "base64");
	} catch {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	if (
		iv.length !== SECRET_STORE_IV_BYTES ||
		tag.length !== SECRET_STORE_TAG_BYTES
	) {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	let plaintext: string;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(entryAad(credentialRef));
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([
			decipher.update(data),
			decipher.final(),
		]).toString("utf8");
	} catch {
		// A wrong device token and a tampered ciphertext are the same failure.
		throw new DeviceSecretStoreError("DECRYPT_FAILED");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		throw new DeviceSecretStoreError("DECRYPT_FAILED");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new DeviceSecretStoreError("DECRYPT_FAILED");
	}
	const record = parsed as Record<string, unknown>;
	try {
		return {
			fields: normalizeFields(record.fields),
			selectors: normalizeSelectors(record.selectors ?? undefined),
		};
	} catch {
		throw new DeviceSecretStoreError("DECRYPT_FAILED");
	}
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

async function readStoreFile(path: string): Promise<FileShape | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw new DeviceSecretStoreError("IO_ERROR");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== SECRET_STORE_VERSION) {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	if (typeof record.salt !== "string") {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	const salt = Buffer.from(record.salt, "base64");
	if (salt.length < SECRET_STORE_SALT_BYTES || salt.length > 64) {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	const rawEntries = record.entries;
	if (
		rawEntries === null ||
		typeof rawEntries !== "object" ||
		Array.isArray(rawEntries)
	) {
		throw new DeviceSecretStoreError("CORRUPT");
	}
	const entries = new Map<string, EncryptedEntry>();
	for (const [ref, value] of Object.entries(
		rawEntries as Record<string, unknown>,
	)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new DeviceSecretStoreError("CORRUPT");
		}
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.iv !== "string" ||
			typeof entry.tag !== "string" ||
			typeof entry.data !== "string"
		) {
			throw new DeviceSecretStoreError("CORRUPT");
		}
		entries.set(ref, {
			iv: entry.iv,
			tag: entry.tag,
			data: entry.data,
		});
	}
	return { salt, entries };
}

/** Writes a temp file in the same directory, then renames it into place. */
async function writeAtomic(path: string, text: string): Promise<void> {
	const directory = dirname(path);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch {
		throw new DeviceSecretStoreError("IO_ERROR");
	}
	const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(tempPath, "w", 0o600);
		await handle.writeFile(text, "utf8");
		await handle.sync();
	} catch {
		throw new DeviceSecretStoreError("IO_ERROR");
	} finally {
		await handle?.close().catch(() => undefined);
	}
	try {
		await rename(tempPath, path);
	} catch {
		await unlink(tempPath).catch(() => undefined);
		throw new DeviceSecretStoreError("IO_ERROR");
	}
	// Best effort: POSIX honors 0600; Windows has no equivalent mode bit.
	await chmod(path, 0o600).catch(() => undefined);
}

function serialize(salt: Buffer, entries: Map<string, EncryptedEntry>): string {
	const serializedEntries: Record<string, EncryptedEntry> = Object.create(null);
	for (const [ref, entry] of entries) {
		serializedEntries[ref] = entry;
	}
	return JSON.stringify({
		version: SECRET_STORE_VERSION,
		salt: salt.toString("base64"),
		entries: serializedEntries,
	});
}

export type OpenSecretStoreOptions = {
	path: string;
	deviceToken: string;
};

/**
 * Opens (or creates on first write) the encrypted store and decrypts every
 * entry once. `getFields` is synchronous so dispatch can resolve a secret
 * without making the tool table async; pairing writes update the in-memory map
 * after the atomic file write succeeds.
 */
export async function openSecretStore(
	options: OpenSecretStoreOptions,
): Promise<SecretStore> {
	if (
		typeof options.deviceToken !== "string" ||
		!DEVICE_TOKEN_PATTERN.test(options.deviceToken)
	) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	const path = options.path;
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new DeviceSecretStoreError("INVALID_INPUT");
	}
	let currentSalt: Buffer = randomBytes(SECRET_STORE_SALT_BYTES);
	let entries = new Map<string, SecretEntry>();

	const load = async (): Promise<void> => {
		const file = await readStoreFile(path);
		if (file === null) {
			entries = new Map<string, SecretEntry>();
			return;
		}
		currentSalt = file.salt;
		const key = deriveKey(options.deviceToken, currentSalt);
		const nextEntries = new Map<string, SecretEntry>();
		for (const [ref, ciphertext] of file.entries) {
			const normalizedRef = normalizeCredentialRef(ref);
			nextEntries.set(
				normalizedRef,
				decryptEntry(key, normalizedRef, ciphertext),
			);
		}
		entries = nextEntries;
	};

	await load();

	const persist = async (): Promise<void> => {
		const key = deriveKey(options.deviceToken, currentSalt);
		const nextEncrypted = new Map<string, EncryptedEntry>();
		for (const [ref, entry] of entries) {
			nextEncrypted.set(ref, encryptEntry(key, ref, entry));
		}
		await writeAtomic(path, serialize(currentSalt, nextEncrypted));
	};

	return {
		path,
		getFields(credentialRef) {
			const entry = entries.get(credentialRef);
			return entry === undefined ? null : { ...entry.fields };
		},
		getSelectors(credentialRef) {
			const entry = entries.get(credentialRef);
			return entry === undefined ? null : { ...entry.selectors };
		},
		async setSecret(credentialRef, input) {
			const ref = normalizeCredentialRef(credentialRef);
			const fields = normalizeFields(input.fields);
			const selectors = normalizeSelectors(input.selectors);
			const previous = entries.get(ref);
			entries.set(ref, { fields, selectors });
			try {
				await persist();
			} catch (error) {
				// Roll the in-memory map back so memory and disk never diverge.
				if (previous === undefined) {
					entries.delete(ref);
				} else {
					entries.set(ref, previous);
				}
				throw error;
			}
		},
		async removeSecret(credentialRef) {
			const ref = normalizeCredentialRef(credentialRef);
			if (!entries.has(ref)) return false;
			const previous = entries.get(ref);
			entries.delete(ref);
			try {
				await persist();
			} catch (error) {
				if (previous !== undefined) entries.set(ref, previous);
				throw error;
			}
			return true;
		},
		refs() {
			return [...entries.keys()].sort();
		},
		async reload() {
			await load();
		},
	};
}
