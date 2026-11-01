import { afterEach, describe, expect, test } from "bun:test";
import {
	connectConnector,
	DeviceApiError,
	listConnectorCredentials,
	listDevices,
	registerDevice,
	revokeConnector,
	revokeDevice,
	rotateDevice,
} from "./api";
import type { ConnectConnectorInput } from "./contracts";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(43);

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function mockFetch(handler: (call: FetchCall) => Response) {
	calls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
}

function parseBody(call: FetchCall): Record<string, unknown> {
	if (typeof call.init?.body !== "string") {
		throw new Error("expected a JSON string body");
	}
	return JSON.parse(call.init.body) as Record<string, unknown>;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	calls = [];
});

describe("device API", () => {
	test("lists devices with a same-origin GET and parses the envelope", async () => {
		mockFetch(() =>
			jsonResponse({
				devices: [
					{
						id: DEVICE_ID,
						displayName: "laptop-keychain",
						status: "active",
						lastSeenAt: null,
					},
				],
			}),
		);
		const devices = await listDevices();
		expect(devices).toHaveLength(1);
		expect(devices[0]?.displayName).toBe("laptop-keychain");
		expect(calls[0]?.url).toBe("/api/device/list");
		expect(calls[0]?.init?.method).toBe("GET");
		expect(calls[0]?.init?.credentials).toBe("same-origin");
		expect(calls[0]?.init?.body).toBeUndefined();
	});

	test("registers a device with a JSON POST and returns the one-time token", async () => {
		const expiresAt = "2027-01-30T00:00:00.000Z";
		mockFetch(() =>
			jsonResponse({ deviceId: DEVICE_ID, token: TOKEN, expiresAt }),
		);
		const issued = await registerDevice("laptop-keychain");
		expect(issued.token).toBe(TOKEN);
		expect(issued.expiresAt).toBe(expiresAt);
		expect(calls[0]?.init?.method).toBe("POST");
		expect(calls[0]?.init?.credentials).toBe("same-origin");
		const headers = calls[0]?.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(parseBody(calls[0] as FetchCall)).toEqual({
			displayName: "laptop-keychain",
		});
	});

	test("rotates and revokes by device id", async () => {
		mockFetch(() =>
			jsonResponse({ deviceId: DEVICE_ID, token: TOKEN, expiresAt: "x" }),
		);
		await rotateDevice(DEVICE_ID);
		expect(parseBody(calls[0] as FetchCall)).toEqual({ deviceId: DEVICE_ID });
		expect(calls[0]?.url).toBe("/api/device/rotate");

		mockFetch(() => jsonResponse({ deviceId: DEVICE_ID, status: "revoked" }));
		expect(await revokeDevice(DEVICE_ID)).toBe(DEVICE_ID);
		expect(parseBody(calls[0] as FetchCall)).toEqual({ deviceId: DEVICE_ID });
	});

	test("maps a disabled gateway (503) to fixed unavailable text", async () => {
		mockFetch(() => jsonResponse({ error: "raw driver text" }, 503));
		try {
			await listDevices();
			throw new Error("expected the request to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(DeviceApiError);
			expect((error as DeviceApiError).kind).toBe("unavailable");
			expect((error as DeviceApiError).message).toContain("not enabled");
			expect((error as DeviceApiError).message).not.toContain("raw driver");
		}
	});

	test("maps 401 and 403 to fixed auth text without echoing the body", async () => {
		mockFetch(() => jsonResponse({ error: "leak" }, 401));
		await expect(listDevices()).rejects.toBeInstanceOf(DeviceApiError);
		mockFetch(() => jsonResponse({ error: "leak" }, 403));
		try {
			await listDevices();
		} catch (error) {
			expect(error).toBeInstanceOf(DeviceApiError);
			expect((error as DeviceApiError).kind).toBe("forbidden");
			expect((error as DeviceApiError).message).not.toContain("leak");
		}
	});

	test("fails closed on an unexpected payload shape", async () => {
		mockFetch(() => jsonResponse({ devices: "not-an-array" }));
		await expect(listDevices()).rejects.toMatchObject({ kind: "unknown" });
	});

	test("fails closed when the network rejects", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		await expect(listDevices()).rejects.toMatchObject({ kind: "unknown" });
	});
});

describe("connector API", () => {
	const input: ConnectConnectorInput = {
		deviceId: DEVICE_ID,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team",
		scopes: ["issues:read"],
	};

	test("sends metadata and an opaque credential ref only", async () => {
		mockFetch(() => jsonResponse({ credentialId: CREDENTIAL_ID }));
		const credentialId = await connectConnector(input);
		expect(credentialId).toBe(CREDENTIAL_ID);
		expect(calls[0]?.url).toBe("/api/connectors/connect");
		const body = parseBody(calls[0] as FetchCall);
		expect(body).toEqual({
			deviceId: DEVICE_ID,
			connectorId: "sentry",
			displayName: "Team Sentry",
			authKind: "api_key",
			credentialRef: "keychain:isolate/sentry/team",
			scopes: ["issues:read"],
		});
		expect(Object.keys(body)).not.toContain("apiKey");
		expect(Object.keys(body)).not.toContain("secret");
	});

	test("lists connector metadata and caps the parsed array", async () => {
		mockFetch(() =>
			jsonResponse({
				credentials: [
					{
						id: CREDENTIAL_ID,
						deviceId: DEVICE_ID,
						connectorId: "sentry",
						displayName: "Team Sentry",
						authKind: "api_key",
						credentialRef: "keychain:isolate/sentry/team",
						scopes: ["issues:read"],
						status: "active",
						freeTierProfile: {
							requestsPerMinute: null,
							requestsPerDay: null,
							eventsPerMonth: null,
							retentionDays: null,
						},
						metadata: {},
						lastValidatedAt: null,
						lastUsedAt: null,
					},
				],
			}),
		);
		const credentials = await listConnectorCredentials();
		expect(credentials[0]?.connectorId).toBe("sentry");
		expect(credentials[0]?.status).toBe("active");
	});

	test("revokes a connector by credential id", async () => {
		mockFetch(() =>
			jsonResponse({ credentialId: CREDENTIAL_ID, status: "revoked" }),
		);
		expect(await revokeConnector(CREDENTIAL_ID)).toBe(CREDENTIAL_ID);
		expect(calls[0]?.url).toBe("/api/connectors/revoke");
		expect(parseBody(calls[0] as FetchCall)).toEqual({
			credentialId: CREDENTIAL_ID,
		});
	});
});
