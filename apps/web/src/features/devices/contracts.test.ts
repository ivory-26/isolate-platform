import { describe, expect, test } from "bun:test";
import {
	API_FAILURE_MESSAGES,
	buildConnectInput,
	connectorLabel,
	type DeviceView,
	deviceNameFor,
	failureKindForStatus,
	looksLikeCredentialSecret,
	MAX_CONNECTOR_SCOPES,
	parseScopeTokens,
	validateDeviceName,
} from "./contracts";

const DEVICE: DeviceView = {
	id: "11111111-1111-4111-8111-111111111111",
	displayName: "laptop-keychain",
	status: "active",
	lastSeenAt: null,
};

function values(
	overrides: Partial<Parameters<typeof buildConnectInput>[0]> = {},
) {
	return {
		deviceId: DEVICE.id,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team",
		scopesText: "issues:read, events:read issues:read",
		...overrides,
	};
}

describe("device name validation", () => {
	test("trims and accepts 1–100 characters", () => {
		expect(validateDeviceName("  laptop  ")).toEqual({
			ok: true,
			value: "laptop",
		});
		const long = validateDeviceName("x".repeat(101));
		expect(long.ok).toBe(false);
	});

	test("rejects blank names", () => {
		const result = validateDeviceName("   ");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("1 to 100");
	});
});

describe("scope tokens", () => {
	test("splits on whitespace and commas, then de-duplicates", () => {
		expect(parseScopeTokens("issues:read, events:read  issues:read")).toEqual({
			ok: true,
			scopes: ["issues:read", "events:read"],
		});
	});

	test("accepts an empty scope list", () => {
		expect(parseScopeTokens("  ")).toEqual({ ok: true, scopes: [] });
	});

	test("caps the number of scopes and rejects invalid tokens", () => {
		const tooMany = Array.from(
			{ length: MAX_CONNECTOR_SCOPES + 1 },
			(_, index) => `scope${index}`,
		);
		expect(parseScopeTokens(tooMany.join(" ")).ok).toBe(false);
		expect(parseScopeTokens("bad scope!").ok).toBe(false);
		expect(parseScopeTokens("-leading").ok).toBe(false);
	});
});

describe("credential-ref secret detection", () => {
	test("refuses values shaped like vendor keys", () => {
		expect(looksLikeCredentialSecret("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(
			true,
		);
		expect(looksLikeCredentialSecret("xoxb-1234567890-abcdef")).toBe(true);
		expect(looksLikeCredentialSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(looksLikeCredentialSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(
			true,
		);
		expect(looksLikeCredentialSecret("a".repeat(257))).toBe(true);
	});

	test("accepts an opaque keychain name", () => {
		expect(looksLikeCredentialSecret("keychain:isolate/sentry/team")).toBe(
			false,
		);
	});
});

describe("connect form", () => {
	test("builds metadata-only input with parsed scopes", () => {
		const result = buildConnectInput(values());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			deviceId: DEVICE.id,
			connectorId: "sentry",
			displayName: "Team Sentry",
			authKind: "api_key",
			credentialRef: "keychain:isolate/sentry/team",
			scopes: ["issues:read", "events:read"],
		});
		expect(Object.keys(result.value)).not.toContain("secret");
	});

	test("rejects a pasted vendor secret instead of sending it", () => {
		const result = buildConnectInput(
			values({ credentialRef: "ghp_abcdefghijklmnopqrstuvwxyz" }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("keychain item name only");
	});

	test("rejects a missing device or unsupported connector", () => {
		expect(buildConnectInput(values({ deviceId: "" })).ok).toBe(false);
		expect(buildConnectInput(values({ connectorId: "gitlab" })).ok).toBe(false);
		expect(buildConnectInput(values({ authKind: "password" })).ok).toBe(false);
	});

	test("rejects a blank display name and blank keychain name", () => {
		expect(buildConnectInput(values({ displayName: "  " })).ok).toBe(false);
		expect(buildConnectInput(values({ credentialRef: " " })).ok).toBe(false);
	});
});

describe("failure mapping and labels", () => {
	test("maps status codes to fixed failure kinds", () => {
		expect(failureKindForStatus(401)).toBe("auth");
		expect(failureKindForStatus(403)).toBe("forbidden");
		expect(failureKindForStatus(404)).toBe("not-found");
		expect(failureKindForStatus(429)).toBe("rate-limited");
		expect(failureKindForStatus(503)).toBe("unavailable");
		expect(failureKindForStatus(400)).toBe("invalid");
		expect(failureKindForStatus(500)).toBe("unknown");
	});

	test("every failure kind has fixed non-empty text", () => {
		for (const message of Object.values(API_FAILURE_MESSAGES)) {
			expect(message.length).toBeGreaterThan(0);
		}
	});

	test("labels connectors and resolves device names without inventing one", () => {
		expect(connectorLabel("sentry")).toBe("Sentry");
		expect(connectorLabel("unknown-vendor")).toBe("unknown-vendor");
		expect(deviceNameFor([DEVICE], DEVICE.id)).toBe("laptop-keychain");
		expect(deviceNameFor([], DEVICE.id)).toBe("Unknown device");
	});
});
