import { describe, expect, test } from "bun:test";
import {
	CONNECTOR_CALL_MAX_RESULT_BYTES,
	InMemoryConnectorCallRepository,
	InMemoryConnectorCredentialRepository,
	InMemoryConnectorDeviceRepository,
	InMemoryRateLimitRepository,
} from "@isolate/db";
import { hashConnectorDeviceToken } from "@isolate/integrations";
import { asOrganizationId, type OrganizationId } from "@isolate/shared";
import {
	createDeviceGateway,
	type DeviceGateway,
	type DeviceGatewayDependencies,
	DeviceGatewayNotConfiguredError,
	getDeviceGateway,
	handleDeviceClaimRoute,
	handleDeviceHeartbeatRoute,
	handleDeviceResultRoute,
	isDeviceGatewayEnabled,
	parseDeviceResultBody,
	readDeviceCallId,
	resetDeviceGatewayForTests,
} from "./device-gateway.server";
import type { RateLimitCounter } from "./rate-limit.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const TOKEN_C = "E".repeat(43);
const REVOKED_TOKEN = "C".repeat(43);
const PENDING_TOKEN = "D".repeat(43);
const REF_A = "keychain:isolate/sentry/team-a";

type Harness = {
	gateway: DeviceGateway;
	calls: InMemoryConnectorCallRepository;
	devices: InMemoryConnectorDeviceRepository;
	credentials: InMemoryConnectorCredentialRepository;
	rateLimits: RateLimitCounter;
	deviceAId: string;
	deviceBId: string;
	deviceCId: string;
	credentialAId: string;
	credentialBId: string;
	credentialCId: string;
};

async function createHarness(
	options: {
		now?: () => Date;
		usage?: {
			consume: (
				credentialId: string,
				input: { limitPerPeriod: number; period: string },
			) => Promise<{ consumed: boolean; requestCount: number }>;
		};
		trustProxyHeaders?: boolean;
		rateLimits?: RateLimitCounter;
	} = {},
): Promise<Harness> {
	const devices = new InMemoryConnectorDeviceRepository();
	const credentials = new InMemoryConnectorCredentialRepository();
	const calls = new InMemoryConnectorCallRepository(
		options.now === undefined ? {} : { now: options.now },
	);
	const rateLimits: RateLimitCounter =
		options.rateLimits ?? new InMemoryRateLimitRepository();
	const owners = new Map<string, OrganizationId>();
	const deviceA = await devices.create({
		organizationId: ORG_A,
		displayName: "Laptop A",
		tokenHash: hashConnectorDeviceToken(TOKEN_A),
		status: "active",
	});
	const deviceB = await devices.create({
		organizationId: ORG_B,
		displayName: "Laptop B",
		tokenHash: hashConnectorDeviceToken(TOKEN_B),
		status: "active",
	});
	const revoked = await devices.create({
		organizationId: ORG_A,
		displayName: "Retired laptop",
		tokenHash: hashConnectorDeviceToken(REVOKED_TOKEN),
		status: "revoked",
	});
	const pending = await devices.create({
		organizationId: ORG_A,
		displayName: "Unpaired laptop",
		tokenHash: hashConnectorDeviceToken(PENDING_TOKEN),
		status: "pending",
	});
	const deviceC = await devices.create({
		organizationId: ORG_A,
		displayName: "Grafana laptop",
		tokenHash: hashConnectorDeviceToken(TOKEN_C),
		status: "active",
	});
	owners.set(hashConnectorDeviceToken(TOKEN_A), ORG_A);
	owners.set(hashConnectorDeviceToken(TOKEN_B), ORG_B);
	owners.set(hashConnectorDeviceToken(TOKEN_C), ORG_A);
	owners.set(hashConnectorDeviceToken(REVOKED_TOKEN), revoked.organizationId);
	owners.set(hashConnectorDeviceToken(PENDING_TOKEN), pending.organizationId);
	const credentialA = await credentials.create({
		organizationId: ORG_A,
		deviceId: deviceA.id,
		connectorId: "sentry",
		displayName: "Team A Sentry",
		authKind: "api_key",
		credentialRef: REF_A,
		status: "active",
	});
	const credentialB = await credentials.create({
		organizationId: ORG_B,
		deviceId: deviceB.id,
		connectorId: "sentry",
		displayName: "Team B Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team-b",
		status: "active",
	});
	const credentialC = await credentials.create({
		organizationId: ORG_A,
		deviceId: deviceC.id,
		connectorId: "grafana",
		displayName: "Pending Grafana",
		authKind: "api_key",
		credentialRef: "keychain:isolate/grafana",
		status: "pending_validation",
	});
	const dependencies: DeviceGatewayDependencies = {
		devices,
		credentials,
		calls,
		lookupTokenHash: async (tokenHash) => {
			const organizationId = owners.get(tokenHash);
			return organizationId === undefined ? null : { organizationId };
		},
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.usage === undefined ? {} : { usage: options.usage }),
		rateLimits,
		trustProxyHeaders: options.trustProxyHeaders === true,
	};
	return {
		gateway: createDeviceGateway(dependencies),
		calls,
		devices,
		credentials,
		rateLimits,
		deviceAId: deviceA.id,
		deviceBId: deviceB.id,
		deviceCId: deviceC.id,
		credentialAId: credentialA.id,
		credentialBId: credentialB.id,
		credentialCId: credentialC.id,
	};
}

function claimRequest(token?: string): Request {
	return new Request("http://localhost/api/device/claim", {
		method: "POST",
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	});
}

function claimRequestWith(
	options: { token?: string; limit?: string; forwardedFor?: string } = {},
): Request {
	const search = options.limit === undefined ? "" : `?limit=${options.limit}`;
	const headers: Record<string, string> = {};
	if (options.token !== undefined) {
		headers.authorization = `Bearer ${options.token}`;
	}
	if (options.forwardedFor !== undefined) {
		headers["x-forwarded-for"] = options.forwardedFor;
	}
	return new Request(`http://localhost/api/device/claim${search}`, {
		method: "POST",
		headers,
	});
}

function resultRequest(callId: string, body: unknown, token?: string): Request {
	return new Request(`http://localhost/api/device/calls/${callId}/result`, {
		method: "POST",
		headers:
			token === undefined
				? { "content-type": "application/json" }
				: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function heartbeatRequest(token?: string): Request {
	return new Request("http://localhost/api/device/heartbeat", {
		method: "POST",
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	});
}

async function readResponse(
	response: Response,
	forbidden: readonly string[] = [],
): Promise<Record<string, unknown>> {
	expect(response.headers.get("cache-control")).toBe("no-store");
	const text = await response.text();
	for (const value of forbidden) {
		if (value.length === 0) continue;
		expect(text).not.toContain(value);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

async function enqueueCall(
	harness: Harness,
	overrides: { deviceId?: string; credentialId?: string } = {},
): Promise<string> {
	const call = await harness.calls.enqueue({
		organizationId: ORG_A,
		deviceId: overrides.deviceId ?? harness.deviceAId,
		credentialId: overrides.credentialId ?? harness.credentialAId,
		taskId: "99999999-9999-4999-8999-999999999999",
		connectorId: "sentry",
		toolName: "sentry.issue_context",
		params: { issueId: "SENTRY-1" },
		ttlMs: 60_000,
	});
	return call.id;
}

describe("device gateway authentication", () => {
	test("missing, malformed and unknown bearer tokens are a generic 401", async () => {
		const harness = await createHarness();
		const tokens: (string | undefined)[] = [
			undefined,
			"",
			"not-a-token",
			"Z".repeat(43),
		];
		for (const token of tokens) {
			const response = await harness.gateway.handleClaim(claimRequest(token));
			expect(response.status).toBe(401);
			const body = await readResponse(
				response,
				token === undefined ? [] : [token],
			);
			expect(body).toEqual({ error: "device authentication failed" });
		}
	});

	test("pending and revoked devices cannot claim, post results or heartbeat", async () => {
		const harness = await createHarness();
		for (const token of [REVOKED_TOKEN, PENDING_TOKEN]) {
			for (const response of [
				await harness.gateway.handleClaim(claimRequest(token)),
				await harness.gateway.handleHeartbeat(heartbeatRequest(token)),
			]) {
				expect(response.status).toBe(401);
				await readResponse(response, [token]);
			}
			const callId = await enqueueCall(harness);
			const rejected = await harness.gateway.handleResult(
				resultRequest(callId, { ok: true, data: {} }, token),
			);
			expect(rejected.status).toBe(401);
			await readResponse(rejected, [token]);
		}
	});

	test("a malformed Authorization header is refused without echoing it", async () => {
		const harness = await createHarness();
		const request = new Request("http://localhost/api/device/claim", {
			method: "POST",
			headers: { authorization: `Basic ${TOKEN_A}` },
		});
		const response = await harness.gateway.handleClaim(request);
		expect(response.status).toBe(401);
		await readResponse(response, [TOKEN_A]);
	});
});

describe("device gateway claim", () => {
	test("claims one call and returns only the credential reference", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(response.status).toBe(200);
		const body = await readResponse(response, [
			TOKEN_A,
			hashConnectorDeviceToken(TOKEN_A),
			"api_key",
		]);
		const call = body.call as Record<string, unknown>;
		expect(call.id).toBe(callId);
		expect(call.connectorId).toBe("sentry");
		expect(call.credentialRef).toBe(REF_A);
		expect(call.toolName).toBe("sentry.issue_context");
		expect(call.params).toEqual({ issueId: "SENTRY-1" });
		expect(typeof call.deadlineAt).toBe("string");
		expect(call).not.toHaveProperty("credentialId");
		expect(call).not.toHaveProperty("token");
		expect(call).not.toHaveProperty("secret");
		const device = await harness.devices.listByOrganization(ORG_A);
		expect(
			device.find((row) => row.id === harness.deviceAId)?.lastSeenAt,
		).not.toBeNull();
	});

	test("returns a null call when the queue is empty", async () => {
		const harness = await createHarness();
		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(response.status).toBe(200);
		expect(await readResponse(response, [TOKEN_A])).toEqual({ call: null });
	});

	test("two concurrent polls never receive the same call", async () => {
		const harness = await createHarness();
		const first = await enqueueCall(harness);
		const second = await enqueueCall(harness);
		const [left, right] = await Promise.all([
			harness.gateway.handleClaim(claimRequest(TOKEN_A)),
			harness.gateway.handleClaim(claimRequest(TOKEN_A)),
		]);
		const leftCall = (await readResponse(left, [TOKEN_A])).call as {
			id: string;
		} | null;
		const rightCall = (await readResponse(right, [TOKEN_A])).call as {
			id: string;
		} | null;
		const ids = [leftCall?.id, rightCall?.id].filter(
			(value): value is string => value !== undefined,
		);
		expect(ids).toHaveLength(2);
		expect(new Set(ids)).toEqual(new Set([first, second]));
	});

	test("a device only sees calls enqueued for itself", async () => {
		const harness = await createHarness();
		await enqueueCall(harness, {
			deviceId: harness.deviceBId,
			credentialId: harness.credentialBId,
		});
		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(await readResponse(response, [TOKEN_A])).toEqual({ call: null });
	});

	test("a claim with an inactive credential fails closed as no work", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness, {
			deviceId: harness.deviceCId,
			credentialId: harness.credentialCId,
		});
		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_C));
		expect(await readResponse(response, [TOKEN_C])).toEqual({
			call: null,
		});
		expect(harness.calls.peek(callId)?.status).toBe("failed");
	});

	test("an expired call is never claimed", async () => {
		let now = new Date("2026-11-01T00:00:00.000Z");
		const harness = await createHarness({ now: () => now });
		await enqueueCall(harness);
		now = new Date("2026-11-01T00:02:00.000Z");
		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(await readResponse(response, [TOKEN_A])).toEqual({ call: null });
	});
});

describe("device gateway result", () => {
	test("a successful result completes the owned call", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		const claim = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(claim.status).toBe(200);
		const response = await harness.gateway.handleResult(
			resultRequest(callId, { ok: true, data: { issue: "SENTRY-1" } }, TOKEN_A),
		);
		expect(response.status).toBe(200);
		expect(
			await readResponse(response, [
				TOKEN_A,
				hashConnectorDeviceToken(TOKEN_A),
			]),
		).toEqual({ ok: true });
		const stored = harness.calls.peek(callId);
		expect(stored?.status).toBe("completed");
		expect(stored?.result).toEqual({ issue: "SENTRY-1" });
	});

	test("a replayed result is idempotent and never overwrites the first one", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const first = await harness.gateway.handleResult(
			resultRequest(callId, { ok: true, data: { issue: "SENTRY-1" } }, TOKEN_A),
		);
		expect(first.status).toBe(200);
		const replay = await harness.gateway.handleResult(
			resultRequest(
				callId,
				{ ok: true, data: { issue: "OVERWRITE" } },
				TOKEN_A,
			),
		);
		expect(replay.status).toBe(200);
		expect(await readResponse(replay, [TOKEN_A])).toEqual({ ok: true });
		expect(harness.calls.peek(callId)?.result).toEqual({ issue: "SENTRY-1" });
	});

	test("a failure result records the device error code", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const response = await harness.gateway.handleResult(
			resultRequest(callId, { ok: false, errorCode: "RATE_LIMITED" }, TOKEN_A),
		);
		expect(response.status).toBe(200);
		expect(await readResponse(response, [TOKEN_A])).toEqual({ ok: true });
		const stored = harness.calls.peek(callId);
		expect(stored?.status).toBe("failed");
		expect(stored?.errorCode).toBe("RATE_LIMITED");
	});

	test("another device cannot complete a call it does not own", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const response = await harness.gateway.handleResult(
			resultRequest(callId, { ok: true, data: { issue: "STOLEN" } }, TOKEN_B),
		);
		expect(response.status).toBe(404);
		expect(await readResponse(response, [TOKEN_B])).toEqual({
			error: "connector call not found",
		});
		expect(harness.calls.peek(callId)?.status).toBe("claimed");
	});

	test("an unclaimed call is a conflict, not a silent success", async () => {
		const harness = await createHarness();
		const queuedId = await enqueueCall(harness);
		const queued = await harness.gateway.handleResult(
			resultRequest(queuedId, { ok: true, data: {} }, TOKEN_A),
		);
		expect(queued.status).toBe(409);
	});

	test("an expired claimed call is a conflict", async () => {
		let now = new Date("2026-11-01T00:00:00.000Z");
		const harness = await createHarness({ now: () => now });
		const claimedId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		now = new Date("2026-11-01T00:02:00.000Z");
		const expired = await harness.gateway.handleResult(
			resultRequest(claimedId, { ok: true, data: {} }, TOKEN_A),
		);
		expect(expired.status).toBe(409);
	});

	test("rejects malformed, oversized and credential-shaped results", async () => {
		const harness = await createHarness();
		const callId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const invalidBodies: unknown[] = [
			"not json",
			{},
			{ ok: true },
			{ ok: true, data: [], extra: 1 },
			{ ok: false, errorCode: "lowercase" },
			{ ok: false, errorCode: "NOT_A_DEVICE_CODE" },
			{ ok: true, data: { token: `ghp_${"a".repeat(30)}` } },
		];
		for (const body of invalidBodies) {
			const response = await harness.gateway.handleResult(
				resultRequest(callId, body, TOKEN_A),
			);
			expect(response.status).toBe(400);
			await readResponse(response, [TOKEN_A]);
		}
		const oversized = JSON.stringify({
			ok: true,
			data: { blob: "a".repeat(CONNECTOR_CALL_MAX_RESULT_BYTES) },
		});
		const tooLarge = await harness.gateway.handleResult(
			resultRequest(callId, oversized, TOKEN_A),
		);
		expect(tooLarge.status).toBe(413);
		await readResponse(tooLarge, [TOKEN_A]);
		expect(harness.calls.peek(callId)?.status).toBe("claimed");
	});

	test("an unknown call id is a 404 and a malformed id never reaches the store", async () => {
		const harness = await createHarness();
		const missing = await harness.gateway.handleResult(
			resultRequest(
				"77777777-7777-4777-8777-777777777777",
				{ ok: true, data: {} },
				TOKEN_A,
			),
		);
		expect(missing.status).toBe(404);
		const malformed = new Request(
			"http://localhost/api/device/calls/not-a-uuid/result",
			{
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN_A}` },
				body: JSON.stringify({ ok: true, data: {} }),
			},
		);
		const response = await harness.gateway.handleResult(malformed);
		expect(response.status).toBe(404);
	});
});

describe("device gateway heartbeat", () => {
	test("touches last_seen_at and returns ok", async () => {
		const harness = await createHarness();
		const response = await harness.gateway.handleHeartbeat(
			heartbeatRequest(TOKEN_A),
		);
		expect(response.status).toBe(200);
		expect(await readResponse(response, [TOKEN_A])).toEqual({ ok: true });
		const rows = await harness.devices.listByOrganization(ORG_A);
		expect(
			rows.find((row) => row.id === harness.deviceAId)?.lastSeenAt,
		).not.toBeNull();
	});
});

describe("device gateway configuration", () => {
	test("requires DEVICE_GATEWAY_ENABLED=true and fails closed otherwise", () => {
		expect(isDeviceGatewayEnabled({})).toBe(false);
		expect(isDeviceGatewayEnabled({ DEVICE_GATEWAY_ENABLED: "false" })).toBe(
			false,
		);
		expect(isDeviceGatewayEnabled({ DEVICE_GATEWAY_ENABLED: "1" })).toBe(false);
		expect(isDeviceGatewayEnabled({ DEVICE_GATEWAY_ENABLED: " true " })).toBe(
			true,
		);
		expect(resetDeviceGatewayForTests).toBeTypeOf("function");
		expect(() => getDeviceGateway({})).toThrow(DeviceGatewayNotConfiguredError);
		expect(() => getDeviceGateway({ DEVICE_GATEWAY_ENABLED: "true" })).toThrow(
			DeviceGatewayNotConfiguredError,
		);
	});

	test("route adapters return a fixed 503 when configuration is absent", async () => {
		const previous = process.env.DEVICE_GATEWAY_ENABLED;
		const previousUrl = process.env.DATABASE_URL;
		process.env.DEVICE_GATEWAY_ENABLED = "false";
		process.env.DATABASE_URL = "";
		resetDeviceGatewayForTests();
		try {
			for (const response of [
				await handleDeviceClaimRoute(claimRequest(TOKEN_A)),
				await handleDeviceResultRoute(
					resultRequest(
						"77777777-7777-4777-8777-777777777777",
						{ ok: true, data: {} },
						TOKEN_A,
					),
				),
				await handleDeviceHeartbeatRoute(heartbeatRequest(TOKEN_A)),
			]) {
				expect(response.status).toBe(503);
				await readResponse(response, [TOKEN_A]);
			}
		} finally {
			resetDeviceGatewayForTests();
			if (previous === undefined) delete process.env.DEVICE_GATEWAY_ENABLED;
			else process.env.DEVICE_GATEWAY_ENABLED = previous;
			if (previousUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousUrl;
		}
	});
});

describe("device gateway parsing helpers", () => {
	test("readDeviceCallId accepts only /api/device/calls/{uuid}/result", () => {
		const valid = new Request(
			"http://localhost/api/device/calls/77777777-7777-4777-8777-777777777777/result",
		);
		expect(readDeviceCallId(valid)).toBe(
			"77777777-7777-4777-8777-777777777777",
		);
		for (const path of [
			"/api/device/claim",
			"/api/device/calls/not-a-uuid/result",
			"/api/device/calls/77777777-7777-4777-8777-777777777777",
			"/api/device/calls/77777777-7777-4777-8777-777777777777/other",
		]) {
			expect(readDeviceCallId(new Request(`http://localhost${path}`))).toBe(
				null,
			);
		}
	});

	test("parseDeviceResultBody enforces the strict envelope", () => {
		expect(
			parseDeviceResultBody('{"ok":true,"data":{"issue":"SENTRY-1"}}'),
		).toEqual({ ok: true, data: { issue: "SENTRY-1" } });
		expect(
			parseDeviceResultBody('{"ok":false,"errorCode":"POLICY_DENIED"}'),
		).toEqual({ ok: false, errorCode: "POLICY_DENIED" });
		expect(() => parseDeviceResultBody("[]")).toThrow();
		expect(() => parseDeviceResultBody('{"ok":true,"data":{}}')).not.toThrow();
	});
});

describe("device gateway free-tier guard", () => {
	test("consumes one ledger unit before handing a call to the device", async () => {
		const consumed: Array<{
			credentialId: string;
			limitPerPeriod: number;
			period: string;
		}> = [];
		const harness = await createHarness({
			usage: {
				async consume(credentialId, input) {
					consumed.push({ credentialId, ...input });
					return { consumed: true, requestCount: 1 };
				},
			},
		});
		const callId = await enqueueCall(harness);

		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const body = await readResponse(response);

		expect((body.call as { id?: string }).id).toBe(callId);
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.credentialId).toBe(harness.credentialAId);
		expect(consumed[0]?.limitPerPeriod).toBe(1000);
		expect(consumed[0]?.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test("refuses the call when the free-tier budget is exhausted", async () => {
		const harness = await createHarness({
			usage: {
				async consume() {
					return { consumed: false, requestCount: 1000 };
				},
			},
		});
		const callId = await enqueueCall(harness);

		const response = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		const body = await readResponse(response);

		expect(body.call).toBeNull();
		const row = harness.calls.peek(callId);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("RATE_LIMITED");
	});
});

describe("device gateway batch claim", () => {
	test("claims a bounded oldest-first batch and answers with calls", async () => {
		let clock = new Date("2026-11-01T00:00:00.000Z").getTime();
		const harness = await createHarness({ now: () => new Date(clock) });
		const first = await enqueueCall(harness);
		clock += 1_000;
		const second = await enqueueCall(harness);
		clock += 1_000;
		const third = await enqueueCall(harness);

		const batch = await readResponse(
			await harness.gateway.handleClaim(
				claimRequestWith({ token: TOKEN_A, limit: "2" }),
			),
			[TOKEN_A],
		);
		expect(batch).not.toHaveProperty("call");
		expect(
			(batch.calls as Array<{ id: string }>).map((call) => call.id),
		).toEqual([first, second]);
		expect(harness.calls.peek(third)?.status).toBe("queued");

		const drained = await readResponse(
			await harness.gateway.handleClaim(
				claimRequestWith({ token: TOKEN_A, limit: "4" }),
			),
		);
		expect(
			(drained.calls as Array<{ id: string }>).map((call) => call.id),
		).toEqual([third]);

		const empty = await readResponse(
			await harness.gateway.handleClaim(
				claimRequestWith({ token: TOKEN_A, limit: "4" }),
			),
		);
		expect(empty).toEqual({ calls: [] });
	});

	test("rejects a limit outside 1..10 and an absent limit stays single", async () => {
		const harness = await createHarness();
		for (const limit of ["0", "11", "2.5", "abc", ""]) {
			const response = await harness.gateway.handleClaim(
				claimRequestWith({ token: TOKEN_A, limit }),
			);
			expect(response.status).toBe(400);
			await readResponse(response, [TOKEN_A]);
		}
		const single = await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		expect(await readResponse(single, [TOKEN_A])).toEqual({ call: null });
	});

	test("a batch never includes a foreign call or an unusable credential", async () => {
		const harness = await createHarness();
		const valid = await enqueueCall(harness);
		const unusable = await enqueueCall(harness, {
			credentialId: harness.credentialCId,
		});
		const foreign = await enqueueCall(harness, {
			deviceId: harness.deviceBId,
			credentialId: harness.credentialBId,
		});
		const body = await readResponse(
			await harness.gateway.handleClaim(
				claimRequestWith({ token: TOKEN_A, limit: "10" }),
			),
		);
		expect(
			(body.calls as Array<{ id: string }>).map((call) => call.id),
		).toEqual([valid]);
		expect(harness.calls.peek(unusable)?.status).toBe("failed");
		expect(harness.calls.peek(foreign)?.status).toBe("queued");
	});
});

describe("device gateway throttling", () => {
	test("applies the documented budget to the pre-auth and per-device buckets", async () => {
		const seen: Array<{ key: string; limit: number; windowSeconds: number }> =
			[];
		const counter: RateLimitCounter = {
			async consume(input) {
				seen.push({
					key: input.key,
					limit: input.limit,
					windowSeconds: input.windowSeconds,
				});
				return {
					allowed: true,
					count: 1,
					remaining: input.limit - 1,
					retryAfterSeconds: 0,
				};
			},
		};
		const harness = await createHarness({ rateLimits: counter });
		const callId = await enqueueCall(harness);
		await harness.gateway.handleClaim(claimRequest(TOKEN_A));
		await harness.gateway.handleHeartbeat(heartbeatRequest(TOKEN_A));
		await harness.gateway.handleResult(
			resultRequest(callId, { ok: true, data: {} }, TOKEN_A),
		);
		expect(seen).toEqual([
			{ key: "ip:direct:device", limit: 600, windowSeconds: 60 },
			{
				key: `device:${harness.deviceAId}:claim`,
				limit: 120,
				windowSeconds: 60,
			},
			{ key: "ip:direct:device", limit: 600, windowSeconds: 60 },
			{
				key: `device:${harness.deviceAId}:heartbeat`,
				limit: 60,
				windowSeconds: 60,
			},
			{ key: "ip:direct:device", limit: 600, windowSeconds: 60 },
			{
				key: `device:${harness.deviceAId}:result`,
				limit: 240,
				windowSeconds: 60,
			},
		]);
	});

	test("denies the 601st pre-auth request with Retry-After and no-store", async () => {
		const harness = await createHarness();
		for (let index = 0; index < 600; index += 1) {
			const response = await harness.gateway.handleClaim(claimRequest());
			expect(response.status).toBe(401);
		}
		const denied = await harness.gateway.handleClaim(claimRequest());
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(await readResponse(denied)).toEqual({ error: "too many requests" });
	});

	test("a denial on any device action is the same fixed 429", async () => {
		const counter: RateLimitCounter = {
			async consume() {
				return {
					allowed: false,
					count: 1,
					remaining: 0,
					retryAfterSeconds: 17,
				};
			},
		};
		const harness = await createHarness({ rateLimits: counter });
		const callId = await enqueueCall(harness);
		for (const response of [
			await harness.gateway.handleClaim(claimRequest(TOKEN_A)),
			await harness.gateway.handleHeartbeat(heartbeatRequest(TOKEN_A)),
			await harness.gateway.handleResult(
				resultRequest(callId, { ok: true, data: {} }, TOKEN_A),
			),
		]) {
			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe("17");
			await readResponse(response);
		}
		// A throttled result never touches the call row.
		expect(harness.calls.peek(callId)?.status).toBe("queued");
	});

	test("buckets by x-forwarded-for only when proxy headers are trusted", async () => {
		const untrusted = await createHarness();
		for (let index = 0; index < 600; index += 1) {
			await untrusted.gateway.handleClaim(
				claimRequestWith({ forwardedFor: "198.51.100.1" }),
			);
		}
		// The header is ignored, so a "different" address shares one bucket.
		const denied = await untrusted.gateway.handleClaim(
			claimRequestWith({ forwardedFor: "198.51.100.2" }),
		);
		expect(denied.status).toBe(429);

		const trusted = await createHarness({ trustProxyHeaders: true });
		for (let index = 0; index < 600; index += 1) {
			await trusted.gateway.handleClaim(
				claimRequestWith({ forwardedFor: "198.51.100.1" }),
			);
		}
		expect(
			(
				await trusted.gateway.handleClaim(
					claimRequestWith({ forwardedFor: "198.51.100.1" }),
				)
			).status,
		).toBe(429);
		// A second address starts a fresh bucket: still unauthenticated, not 429.
		expect(
			(
				await trusted.gateway.handleClaim(
					claimRequestWith({ forwardedFor: "198.51.100.2" }),
				)
			).status,
		).toBe(401);
	});
});
