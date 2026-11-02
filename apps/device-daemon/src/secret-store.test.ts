import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DeviceSecretStoreError,
	openSecretStore,
	SECRET_STORE_MAX_FIELDS,
} from "./secret-store";

const directories: string[] = [];

/** Token-shaped and secret-shaped fixtures are built at runtime. */
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

function randomSecret(): string {
	return `sk-${randomToken()}-${randomToken()}`;
}

function randomHash(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("hex");
}

async function storePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "isolate-secrets-"));
	directories.push(directory);
	return join(directory, "secrets.json");
}

afterEach(async () => {
	while (directories.length > 0) {
		const directory = directories.pop();
		if (directory !== undefined) {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

describe("encrypted device secret store", () => {
	test("round-trips fields and selectors without writing plaintext", async () => {
		const path = await storePath();
		const token = randomToken();
		const secret = randomSecret();
		const store = await openSecretStore({ path, deviceToken: token });
		await store.setSecret("keychain:isolate/sentry/prod", {
			fields: { token: secret },
			selectors: { orgSlug: "acme" },
		});

		expect(store.getFields("keychain:isolate/sentry/prod")).toEqual({
			token: secret,
		});
		expect(store.getSelectors("keychain:isolate/sentry/prod")).toEqual({
			orgSlug: "acme",
		});
		expect(store.refs()).toEqual(["keychain:isolate/sentry/prod"]);

		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain("orgSlug");
		expect(raw).toContain("keychain:isolate/sentry/prod");

		// A new process (new open) with the same token decrypts the same value.
		const reopened = await openSecretStore({ path, deviceToken: token });
		expect(reopened.getFields("keychain:isolate/sentry/prod")).toEqual({
			token: secret,
		});
	});

	test("writes 0600 on POSIX and leaves no temp file behind", async () => {
		const path = await storePath();
		const store = await openSecretStore({
			path,
			deviceToken: randomToken(),
		});
		await store.setSecret("keychain:isolate/grafana", {
			fields: { token: randomSecret() },
		});
		const files = await readdir(join(path, ".."));
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
		if (process.platform !== "win32") {
			const info = await stat(path);
			expect(info.mode & 0o777).toBe(0o600);
		}
	});

	test("a wrong device token cannot decrypt the file", async () => {
		const path = await storePath();
		const rightToken = randomToken();
		const wrongToken = randomToken();
		const secret = randomSecret();
		const store = await openSecretStore({
			path,
			deviceToken: rightToken,
		});
		await store.setSecret("keychain:isolate/sentry", {
			fields: { token: secret },
		});

		let caught: unknown;
		try {
			await openSecretStore({ path, deviceToken: wrongToken });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DeviceSecretStoreError);
		const failure = caught as DeviceSecretStoreError;
		expect(failure.code).toBe("DECRYPT_FAILED");
		expect(failure.message).toBe("device secret store could not be decrypted");
		expect(failure.message).not.toContain(secret);
		expect(failure.message).not.toContain(wrongToken);
	});

	test("a tampered ciphertext is detected", async () => {
		const path = await storePath();
		const token = randomToken();
		const store = await openSecretStore({ path, deviceToken: token });
		await store.setSecret("keychain:isolate/axiom", {
			fields: { token: randomSecret() },
		});
		const raw = JSON.parse(await readFile(path, "utf8")) as {
			entries: Record<string, { data: string }>;
		};
		const entry = raw.entries["keychain:isolate/axiom"];
		if (entry === undefined) throw new Error("entry missing");
		const original = entry.data;
		entry.data = `${original.startsWith("A") ? "B" : "A"}${original.slice(1)}`;
		await writeFile(path, JSON.stringify(raw), "utf8");

		let caught: unknown;
		try {
			await openSecretStore({ path, deviceToken: token });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DeviceSecretStoreError);
		expect((caught as DeviceSecretStoreError).code).toBe("DECRYPT_FAILED");
	});

	test("moving a ciphertext between credential refs fails the AAD check", async () => {
		const path = await storePath();
		const token = randomToken();
		const store = await openSecretStore({ path, deviceToken: token });
		await store.setSecret("keychain:isolate/sentry", {
			fields: { token: randomSecret() },
		});
		await store.setSecret("keychain:isolate/grafana", {
			fields: { token: randomSecret() },
		});
		const raw = JSON.parse(await readFile(path, "utf8")) as {
			entries: Record<string, { iv: string; tag: string; data: string }>;
		};
		const sentry = raw.entries["keychain:isolate/sentry"];
		const grafana = raw.entries["keychain:isolate/grafana"];
		if (sentry === undefined || grafana === undefined) {
			throw new Error("entries missing");
		}
		raw.entries["keychain:isolate/sentry"] = grafana;
		raw.entries["keychain:isolate/grafana"] = sentry;
		await writeFile(path, JSON.stringify(raw), "utf8");

		await expect(
			openSecretStore({ path, deviceToken: token }),
		).rejects.toBeInstanceOf(DeviceSecretStoreError);
	});

	test("removeSecret deletes the entry and keeps the rest", async () => {
		const path = await storePath();
		const token = randomToken();
		const store = await openSecretStore({ path, deviceToken: token });
		await store.setSecret("keychain:isolate/sentry", {
			fields: { token: randomSecret() },
		});
		await store.setSecret("keychain:isolate/grafana", {
			fields: { token: randomSecret() },
		});
		expect(await store.removeSecret("keychain:isolate/sentry")).toBe(true);
		expect(await store.removeSecret("keychain:isolate/sentry")).toBe(false);
		expect(store.refs()).toEqual(["keychain:isolate/grafana"]);
		const reopened = await openSecretStore({ path, deviceToken: token });
		expect(reopened.getFields("keychain:isolate/sentry")).toBeNull();
		expect(reopened.getFields("keychain:isolate/grafana")).not.toBeNull();
	});

	test("rejects malformed input with fixed text", async () => {
		const path = await storePath();
		const store = await openSecretStore({
			path,
			deviceToken: randomToken(),
		});
		for (const fields of [
			{},
			{ token: "" },
			{ "bad key": randomSecret() },
			{ apiKey: 42 },
		]) {
			await expect(
				store.setSecret("keychain:isolate/sentry", {
					fields: fields as Record<string, string>,
				}),
			).rejects.toBeInstanceOf(DeviceSecretStoreError);
		}
		const tooMany: Record<string, string> = {};
		for (let index = 0; index < SECRET_STORE_MAX_FIELDS + 1; index += 1) {
			tooMany[`field${index}`] = randomSecret();
		}
		await expect(
			store.setSecret("keychain:isolate/sentry", { fields: tooMany }),
		).rejects.toBeInstanceOf(DeviceSecretStoreError);
		// A secret-shaped selector is refused: selectors are not a secret channel.
		await expect(
			store.setSecret("keychain:isolate/sentry", {
				fields: { token: randomSecret() },
				selectors: { note: `ghp_${randomHash()}` },
			}),
		).rejects.toBeInstanceOf(DeviceSecretStoreError);
	});

	test("rejects a malformed device token before touching the file", async () => {
		const path = await storePath();
		await expect(
			openSecretStore({ path, deviceToken: "short" }),
		).rejects.toBeInstanceOf(DeviceSecretStoreError);
	});
});
