import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEVICE_SECRETS_PATH,
	DEVICE_VENDOR_NAMES,
	DeviceConfigError,
	describeVendors,
	loadDeviceConfig,
	PAIRING_DEFAULT_PORT,
	readDeviceToken,
	resolveSecret,
	resolveSecretsPath,
	resolveVendorSecret,
} from "./config";

const TOKEN = "A".repeat(43);

function validConfig(): Record<string, unknown> {
	return {
		serverUrl: "https://isolate.example.com/",
		deviceTokenEnv: "ISOLATE_DEVICE_TOKEN",
		pollIntervalMs: 1_000,
		vendors: {
			sentry: {
				secretEnv: { token: "SENTRY_API_KEY" },
				baseUrl: "https://sentry.io",
			},
		},
	};
}

function load(value: unknown, env: Record<string, string | undefined> = {}) {
	return loadDeviceConfig({
		env,
		configPath: "/tmp/connectors.json",
		readFile: async () => JSON.stringify(value),
	});
}

describe("device config", () => {
	test("accepts the documented shape and normalizes the server origin", async () => {
		const config = await load(validConfig());
		expect(config.serverUrl).toBe("https://isolate.example.com");
		expect(config.pollIntervalMs).toBe(1_000);
		expect(describeVendors(config)).toEqual(["sentry"]);
	});

	test("defaults the poll interval and vendors", async () => {
		const raw = validConfig();
		delete raw.pollIntervalMs;
		raw.vendors = {};
		const config = await load(raw);
		expect(config.pollIntervalMs).toBe(2_000);
		expect(describeVendors(config)).toEqual([]);
	});

	test("rejects a non-https server url without echoing the value", async () => {
		const raw = validConfig();
		raw.serverUrl = "http://insecure.example.com";
		let message = "";
		try {
			await load(raw);
		} catch (error) {
			expect(error).toBeInstanceOf(DeviceConfigError);
			message = (error as Error).message;
		}
		expect(message).toContain("device config is invalid");
		expect(message).not.toContain("insecure");
	});

	test("rejects an unknown vendor and an unknown field", async () => {
		const unknownVendor = validConfig();
		unknownVendor.vendors = { splunk: {} };
		await expect(load(unknownVendor)).rejects.toThrow(DeviceConfigError);

		const unknownField = validConfig();
		(unknownField.vendors as Record<string, unknown>).sentry = {
			secretEnv: { token: "SENTRY_API_KEY" },
			token: "should-have-used-secretEnv",
		};
		await expect(load(unknownField)).rejects.toThrow(DeviceConfigError);
	});

	test("never puts a misplaced secret value in the error", async () => {
		const raw = validConfig();
		(raw.vendors as Record<string, Record<string, unknown>>).sentry.baseUrl =
			"https://user:sekret-value@example.com";
		let message = "";
		try {
			await load(raw);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("vendors.sentry.baseUrl");
		expect(message).not.toContain("sekret-value");
	});

	test("reports an unreadable file without echoing its path contents", async () => {
		await expect(
			loadDeviceConfig({
				env: {},
				configPath: "/tmp/missing.json",
				readFile: async () => {
					throw new Error("ENOENT");
				},
			}),
		).rejects.toThrow("device config could not be read at /tmp/missing.json");
	});

	test("rejects malformed JSON", async () => {
		await expect(
			loadDeviceConfig({
				env: {},
				configPath: "/tmp/connectors.json",
				readFile: async () => "{not json",
			}),
		).rejects.toThrow("device config is not valid JSON");
	});

	test("lists all nine vendors in canonical order", async () => {
		expect([...DEVICE_VENDOR_NAMES]).toEqual([
			"sentry",
			"grafana",
			"pagerduty",
			"kubernetes",
			"datadog",
			"newrelic",
			"honeycomb",
			"axiom",
			"signoz",
		]);
	});
});

describe("device token", () => {
	test("reads the env var named by config", async () => {
		const config = await load(validConfig());
		expect(readDeviceToken(config, { ISOLATE_DEVICE_TOKEN: TOKEN })).toBe(
			TOKEN,
		);
	});

	test("fails closed without echoing the env name or value", async () => {
		const config = await load(validConfig());
		expect(() => readDeviceToken(config, {})).toThrow(
			"device token is not configured",
		);
		expect(() =>
			readDeviceToken(config, { ISOLATE_DEVICE_TOKEN: "short-token" }),
		).toThrow("device token is malformed");
	});
});

describe("secret resolution", () => {
	test("reads only the env var named by secretEnv", () => {
		expect(
			resolveSecret({ token: "SENTRY_API_KEY" }, "token", {
				SENTRY_API_KEY: "  value  ",
			}),
		).toBe("value");
		expect(resolveSecret({ token: "SENTRY_API_KEY" }, "token", {})).toBeNull();
		expect(
			resolveSecret({ token: "SENTRY_API_KEY" }, "token", {
				SENTRY_API_KEY: "   ",
			}),
		).toBeNull();
	});

	test("a paired store entry wins over the environment", () => {
		const store = {
			getFields: (ref: string) =>
				ref === "keychain:isolate/sentry" ? { token: "stored" } : null,
		};
		expect(
			resolveVendorSecret(
				{ token: "SENTRY_API_KEY" },
				"token",
				{ SENTRY_API_KEY: "from-env" },
				"keychain:isolate/sentry",
				store,
			),
		).toBe("stored");
		expect(
			resolveVendorSecret(
				{ token: "SENTRY_API_KEY" },
				"token",
				{ SENTRY_API_KEY: "from-env" },
				"keychain:isolate/other",
				store,
			),
		).toBe("from-env");
	});

	test("a single-value entry satisfies any requested field name", () => {
		const store = {
			getFields: () => ({ token: "single-value" }) as Record<string, string>,
		};
		expect(
			resolveVendorSecret(undefined, "apiKey", {}, "keychain:x", store),
		).toBe("single-value");
		// A multi-field entry only answers the exact field name.
		const multi = {
			getFields: () => ({ apiKey: "a", appKey: "b" }) as Record<string, string>,
		};
		expect(
			resolveVendorSecret(undefined, "appKey", {}, "keychain:x", multi),
		).toBe("b");
		expect(
			resolveVendorSecret(undefined, "token", {}, "keychain:x", multi),
		).toBeNull();
	});

	test("without a store the environment remains the only source", () => {
		expect(
			resolveVendorSecret(
				{ token: "SENTRY_API_KEY" },
				"token",
				{ SENTRY_API_KEY: "from-env" },
				"keychain:isolate/sentry",
			),
		).toBe("from-env");
	});
});

describe("pairing configuration", () => {
	test("defaults to enabled on the loopback port", async () => {
		const config = await load(validConfig());
		expect(config.pairing.enabled).toBe(true);
		expect(config.pairing.port).toBe(PAIRING_DEFAULT_PORT);
		expect(resolveSecretsPath(config, {})).toBe(DEFAULT_DEVICE_SECRETS_PATH);
	});

	test("accepts an explicit port, disable switch and secrets path", async () => {
		const raw = validConfig();
		raw.pairing = {
			enabled: false,
			port: 49_000,
			secretsPath: "/tmp/device-secrets.json",
		};
		const config = await load(raw);
		expect(config.pairing.enabled).toBe(false);
		expect(config.pairing.port).toBe(49_000);
		expect(resolveSecretsPath(config, {})).toBe("/tmp/device-secrets.json");
		expect(
			resolveSecretsPath(config, {
				ISOLATE_DEVICE_SECRETS: "/tmp/override.json",
			}),
		).toBe("/tmp/override.json");
	});

	test("rejects an out-of-range port and unknown pairing keys", async () => {
		const badPort = validConfig();
		badPort.pairing = { port: 80 };
		await expect(load(badPort)).rejects.toThrow(DeviceConfigError);
		const unknown = validConfig();
		unknown.pairing = { hostname: "0.0.0.0" };
		await expect(load(unknown)).rejects.toThrow(DeviceConfigError);
	});
});
