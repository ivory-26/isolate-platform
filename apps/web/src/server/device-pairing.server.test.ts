import { beforeEach, describe, expect, test } from "bun:test";
import {
	InMemoryConnectorCredentialRepository,
	InMemoryConnectorDeviceRepository,
	InMemoryConnectorPairingRepository,
	type UserRole,
} from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	createDevicePairingService,
	DEVICE_PAIRING_FAILURE_MESSAGES,
	DEVICE_PAIRING_LOCAL_PORT,
	DEVICE_PAIRING_TTL_MS,
	type DevicePairingService,
	handleDevicePairingCancelRoute,
	handleDevicePairingClaimRoute,
	handleDevicePairingCompleteRoute,
	handleDevicePairingCreateRoute,
	handleDevicePairingStatusRoute,
	hashPairingCode,
	readDevicePairingId,
	resetDevicePairingForTests,
} from "./device-pairing.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER_ID = asUserId("33333333-3333-4333-8333-333333333333");
const APP_ORIGIN = "https://app.example.com";

/** Token-shaped fixtures are built at runtime, never static literals. */
function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

function randomHash(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("hex");
}

function secretShapedRef(): string {
	return `ghp_${randomHash()}`;
}

type HarnessOptions = {
	role?: UserRole;
	scopeError?: "AUTH_REQUIRED" | "FORBIDDEN";
};

type Harness = {
	service: DevicePairingService;
	devices: InMemoryConnectorDeviceRepository;
	credentials: InMemoryConnectorCredentialRepository;
	pairings: InMemoryConnectorPairingRepository;
	deviceAId: string;
	deviceBId: string;
	pendingDeviceId: string;
	revokedDeviceId: string;
	foreignDeviceId: string;
	tokenA: string;
	tokenB: string;
	setNow: (value: Date) => void;
	advance: (ms: number) => void;
	now: () => Date;
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const devices = new InMemoryConnectorDeviceRepository();
	const credentials = new InMemoryConnectorCredentialRepository();
	const pairings = new InMemoryConnectorPairingRepository();
	const tokenA = randomToken();
	const tokenB = randomToken();
	const deviceA = await devices.create({
		organizationId: ORG_A,
		displayName: "Relay A",
		tokenHash: randomHash(),
		status: "active",
	});
	const deviceB = await devices.create({
		organizationId: ORG_A,
		displayName: "Relay B",
		tokenHash: randomHash(),
		status: "active",
	});
	const pending = await devices.create({
		organizationId: ORG_A,
		displayName: "Pending relay",
		tokenHash: randomHash(),
		status: "pending",
	});
	const revoked = await devices.create({
		organizationId: ORG_A,
		displayName: "Revoked relay",
		tokenHash: randomHash(),
		status: "revoked",
	});
	const foreign = await devices.create({
		organizationId: ORG_B,
		displayName: "Other org relay",
		tokenHash: randomHash(),
		status: "active",
	});
	const scope: CallerScope = {
		organizationId: ORG_A,
		userId: USER_ID,
		role: options.role ?? "owner",
	};
	let current = new Date("2026-11-02T12:00:00.000Z");
	const tokens = new Map([
		[tokenA, { deviceId: deviceA.id, organizationId: ORG_A }],
		[tokenB, { deviceId: deviceB.id, organizationId: ORG_A }],
	]);
	const service = createDevicePairingService({
		devices,
		credentials,
		pairings,
		resolveScope: async () => {
			if (options.scopeError !== undefined) {
				throw new ControlPlaneError(options.scopeError);
			}
			return scope;
		},
		authenticateDevice: async (request) => {
			const header = request.headers.get("authorization");
			if (header === null) return null;
			const token = header.replace(/^Bearer /i, "");
			return tokens.get(token) ?? null;
		},
		now: () => new Date(current.getTime()),
	});
	return {
		service,
		devices,
		credentials,
		pairings,
		deviceAId: deviceA.id,
		deviceBId: deviceB.id,
		pendingDeviceId: pending.id,
		revokedDeviceId: revoked.id,
		foreignDeviceId: foreign.id,
		tokenA,
		tokenB,
		setNow: (value) => {
			current = new Date(value.getTime());
		},
		advance: (ms) => {
			current = new Date(current.getTime() + ms);
		},
		now: () => new Date(current.getTime()),
	};
}

function createBody(relayId: string, overrides: Record<string, unknown> = {}) {
	return {
		relayId,
		connectorId: "sentry",
		displayName: "Sentry production",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/prod",
		scopes: ["event:read"],
		...overrides,
	};
}

function deviceRequest(
	url: string,
	token: string | null,
	body: unknown,
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return new Request(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

function sessionRequest(
	url: string,
	body: unknown,
	options: { origin?: string; site?: string; contentType?: string } = {},
): Request {
	const headers: Record<string, string> = {
		"content-type": options.contentType ?? "application/json",
		origin: options.origin ?? APP_ORIGIN,
		host: new URL(APP_ORIGIN).host,
		...(options.site === undefined ? {} : { "sec-fetch-site": options.site }),
	};
	return new Request(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("device pairing create", () => {
	test("returns a 256-bit code and a localhost URL with the 10-minute TTL", async () => {
		const harness = await createHarness();
		const result = await harness.service.create(createBody(harness.deviceAId));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.code).toHaveLength(43);
		expect(result.value.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(result.value.localUrl).toBe(
			`http://127.0.0.1:${DEVICE_PAIRING_LOCAL_PORT}/pair?code=${result.value.code}&connector=sentry`,
		);
		const expiresAt = Date.parse(result.value.expiresAt);
		expect(expiresAt - harness.now().getTime()).toBe(DEVICE_PAIRING_TTL_MS);
		const stored = await harness.pairings.get(ORG_A, result.value.pairingId);
		expect(stored?.status).toBe("pending");
		// The code itself is never stored or echoed by a repository read.
		expect(JSON.stringify(stored)).not.toContain(result.value.code);
	});

	test("requires an owner or admin", async () => {
		for (const role of ["member", "viewer"] as const) {
			const harness = await createHarness({ role });
			const result = await harness.service.create(
				createBody(harness.deviceAId),
			);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error.code).toBe("FORBIDDEN");
		}
	});

	test("returns AUTH_REQUIRED when the session is absent", async () => {
		const harness = await createHarness({ scopeError: "AUTH_REQUIRED" });
		const result = await harness.service.create(createBody(harness.deviceAId));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("AUTH_REQUIRED");
	});

	test("refuses pending, revoked and foreign relays", async () => {
		const harness = await createHarness();
		for (const relayId of [
			harness.pendingDeviceId,
			harness.revokedDeviceId,
			harness.foreignDeviceId,
			"99999999-9999-4999-8999-999999999999",
		]) {
			const result = await harness.service.create(createBody(relayId));
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error.code).toBe("NOT_FOUND");
		}
	});

	test("rejects secret-shaped refs and a smuggled secret field", async () => {
		const harness = await createHarness();
		const shaped = await harness.service.create(
			createBody(harness.deviceAId, { credentialRef: secretShapedRef() }),
		);
		expect(shaped.ok).toBe(false);
		if (!shaped.ok) expect(shaped.error.code).toBe("INVALID_INPUT");

		const smuggled = await harness.service.create({
			...createBody(harness.deviceAId),
			secret: randomToken(),
		});
		expect(smuggled.ok).toBe(false);
		if (!smuggled.ok) expect(smuggled.error.code).toBe("INVALID_INPUT");
	});

	test("rejects a tampered code generator", async () => {
		const harness = await createHarness();
		const service = createDevicePairingService({
			devices: harness.devices,
			credentials: harness.credentials,
			pairings: harness.pairings,
			resolveScope: async () => ({
				organizationId: ORG_A,
				userId: USER_ID,
				role: "owner",
			}),
			authenticateDevice: async () => null,
			generateCode: () => "short",
		});
		const result = await service.create(createBody(harness.deviceAId));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNAVAILABLE");
	});
});

describe("device pairing claim", () => {
	test("claims once with the relay token and returns bounded metadata", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const claim = await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenA,
				{},
			),
		);
		expect(claim.ok).toBe(true);
		if (!claim.ok) return;
		expect(claim.value).toEqual({
			pairingId: created.value.pairingId,
			relayId: harness.deviceAId,
			connectorId: "sentry",
			authKind: "api_key",
			credentialRef: "keychain:isolate/sentry/prod",
			displayName: "Sentry production",
			scopes: ["event:read"],
			expiresAt: created.value.expiresAt,
		});
		expect(JSON.stringify(claim.value)).not.toContain(created.value.code);

		const replay = await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenA,
				{},
			),
		);
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.error.code).toBe("NOT_FOUND");
	});

	test("a different relay cannot claim the same code", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const other = await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenB,
				{},
			),
		);
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.error.code).toBe("NOT_FOUND");
	});

	test("an expired code cannot be claimed", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		harness.advance(DEVICE_PAIRING_TTL_MS + 1);
		const claim = await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenA,
				{},
			),
		);
		expect(claim.ok).toBe(false);
		if (!claim.ok) expect(claim.error.code).toBe("NOT_FOUND");
	});

	test("requires a device bearer token", async () => {
		const harness = await createHarness();
		const noToken = await harness.service.claim(
			{ code: randomToken() },
			deviceRequest(`${APP_ORIGIN}/api/device/pairing/claim`, null, {}),
		);
		expect(noToken.ok).toBe(false);
		if (!noToken.ok) expect(noToken.error.code).toBe("AUTH_REQUIRED");
		const bogus = await harness.service.claim(
			{ code: randomToken() },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				randomToken(),
				{},
			),
		);
		expect(bogus.ok).toBe(false);
		if (!bogus.ok) expect(bogus.error.code).toBe("AUTH_REQUIRED");
	});
});

describe("device pairing complete", () => {
	async function claimHarness(): Promise<{
		harness: Harness;
		pairingId: string;
	}> {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const claim = await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenA,
				{},
			),
		);
		if (!claim.ok) throw new Error(`claim failed: ${claim.error.code}`);
		return { harness, pairingId: created.value.pairingId };
	}

	test("creates one pending_validation credential and is idempotent", async () => {
		const { harness, pairingId } = await claimHarness();
		const complete = await harness.service.complete(
			{ pairingId },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{},
			),
		);
		expect(complete.ok).toBe(true);
		if (!complete.ok) return;
		expect(complete.value.status).toBe("pending_validation");
		const rows = await harness.credentials.listByOrganization(ORG_A);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(complete.value.credentialId);
		expect(rows[0]?.status).toBe("pending_validation");

		const replay = await harness.service.complete(
			{ pairingId },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{},
			),
		);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.credentialId).toBe(complete.value.credentialId);
		expect(await harness.credentials.listByOrganization(ORG_A)).toHaveLength(1);

		const status = await harness.service.status(pairingId);
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.value.status).toBe("completed");
		expect(status.value.credentialId).toBe(complete.value.credentialId);
	});

	test("a different device or org cannot complete", async () => {
		const { harness, pairingId } = await claimHarness();
		const otherDevice = await harness.service.complete(
			{ pairingId },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenB,
				{},
			),
		);
		expect(otherDevice.ok).toBe(false);
		if (!otherDevice.ok) expect(otherDevice.error.code).toBe("NOT_FOUND");
	});

	test("an unclaimed pairing is a fixed conflict", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const complete = await harness.service.complete(
			{ pairingId: created.value.pairingId },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{},
			),
		);
		expect(complete.ok).toBe(false);
		if (!complete.ok) expect(complete.error.code).toBe("CONFLICT");
	});

	test("never accepts a secret field", async () => {
		const { harness, pairingId } = await claimHarness();
		const complete = await harness.service.complete(
			{ pairingId, secret: randomToken() },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{},
			),
		);
		expect(complete.ok).toBe(false);
		if (!complete.ok) expect(complete.error.code).toBe("INVALID_INPUT");
	});
});

describe("device pairing status and cancel", () => {
	test("status reports pending, expired and cancelled", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const pending = await harness.service.status(created.value.pairingId);
		expect(pending.ok && pending.value.status).toBe("pending");

		harness.advance(DEVICE_PAIRING_TTL_MS + 1);
		const expired = await harness.service.status(created.value.pairingId);
		expect(expired.ok && expired.value.status).toBe("expired");
		const stored = await harness.pairings.get(ORG_A, created.value.pairingId);
		expect(stored?.status).toBe("expired");

		const second = await harness.service.create(createBody(harness.deviceAId));
		if (!second.ok) throw new Error("create failed");
		const cancelled = await harness.service.cancel({
			pairingId: second.value.pairingId,
		});
		expect(cancelled.ok && cancelled.value.status).toBe("cancelled");
		const replay = await harness.service.cancel({
			pairingId: second.value.pairingId,
		});
		expect(replay.ok).toBe(true);
	});

	test("a completed pairing cannot be cancelled", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		await harness.service.claim(
			{ code: created.value.code },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/claim`,
				harness.tokenA,
				{},
			),
		);
		await harness.service.complete(
			{ pairingId: created.value.pairingId },
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{},
			),
		);
		const cancel = await harness.service.cancel({
			pairingId: created.value.pairingId,
		});
		expect(cancel.ok).toBe(false);
		if (!cancel.ok) expect(cancel.error.code).toBe("CONFLICT");
	});

	test("status is tenant-scoped and validates the id", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const invalid = await harness.service.status("not-a-uuid");
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_INPUT");
		expect(
			readDevicePairingId(
				new Request(
					`${APP_ORIGIN}/api/device/pairing/${created.value.pairingId}`,
				),
			),
		).toBe(created.value.pairingId);
		expect(
			readDevicePairingId(
				new Request(`${APP_ORIGIN}/api/device/pairing/claim`),
			),
		).toBeNull();
	});
});

describe("device pairing routes", () => {
	beforeEach(() => {
		resetDevicePairingForTests();
	});

	test("fail closed with 503 when the gateway is disabled", async () => {
		const create = await handleDevicePairingCreateRoute(
			sessionRequest(`${APP_ORIGIN}/api/device/pairing`, {}),
			{ env: {} },
		);
		expect(create.status).toBe(503);
		const body = await jsonBody(create);
		expect(body.error).toBe(DEVICE_PAIRING_FAILURE_MESSAGES.UNAVAILABLE);
		const claim = await handleDevicePairingClaimRoute(
			deviceRequest(`${APP_ORIGIN}/api/device/pairing/claim`, randomToken(), {
				code: randomToken(),
			}),
			{ env: { DEVICE_GATEWAY_ENABLED: "false" } },
		);
		expect(claim.status).toBe(503);
	});

	test("create route sets no-store and returns the code once", async () => {
		const harness = await createHarness();
		const response = await handleDevicePairingCreateRoute(
			sessionRequest(
				`${APP_ORIGIN}/api/device/pairing`,
				createBody(harness.deviceAId),
			),
			{ service: harness.service },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await jsonBody(response);
		expect(body.code).toHaveLength(43);
		expect(typeof body.pairingId).toBe("string");
		expect(String(body.localUrl).startsWith("http://127.0.0.1:")).toBe(true);
	});

	test("create route rejects cross-site, non-JSON and oversized requests", async () => {
		const harness = await createHarness();
		const url = `${APP_ORIGIN}/api/device/pairing`;
		const crossSite = await handleDevicePairingCreateRoute(
			sessionRequest(url, createBody(harness.deviceAId), {
				origin: "https://evil.example",
			}),
			{ service: harness.service },
		);
		expect(crossSite.status).toBe(403);

		const opaque = await handleDevicePairingCreateRoute(
			sessionRequest(url, createBody(harness.deviceAId), {
				site: "cross-site",
			}),
			{ service: harness.service },
		);
		expect(opaque.status).toBe(403);

		const notJson = await handleDevicePairingCreateRoute(
			sessionRequest(url, createBody(harness.deviceAId), {
				contentType: "text/plain",
			}),
			{ service: harness.service },
		);
		expect(notJson.status).toBe(415);

		const oversized = await handleDevicePairingCreateRoute(
			sessionRequest(url, {
				...createBody(harness.deviceAId),
				displayName: "x".repeat(8 * 1024),
			}),
			{ service: harness.service },
		);
		expect(oversized.status).toBe(413);
	});

	test("claim and complete routes require the device bearer token", async () => {
		const harness = await createHarness();
		const claim = await handleDevicePairingClaimRoute(
			deviceRequest(`${APP_ORIGIN}/api/device/pairing/claim`, null, {
				code: randomToken(),
			}),
			{ service: harness.service },
		);
		expect(claim.status).toBe(401);
		expect((await jsonBody(claim)).error).toBe(
			DEVICE_PAIRING_FAILURE_MESSAGES.AUTH_REQUIRED,
		);
		const complete = await handleDevicePairingCompleteRoute(
			deviceRequest(`${APP_ORIGIN}/api/device/pairing/complete`, null, {
				pairingId: "99999999-9999-4999-8999-999999999999",
			}),
			{ service: harness.service },
		);
		expect(complete.status).toBe(401);
	});

	test("claim and complete routes answer bounded metadata without a secret", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const claim = await handleDevicePairingClaimRoute(
			deviceRequest(`${APP_ORIGIN}/api/device/pairing/claim`, harness.tokenA, {
				code: created.value.code,
			}),
			{ service: harness.service },
		);
		expect(claim.status).toBe(200);
		expect(claim.headers.get("cache-control")).toBe("no-store");
		const claimBody = await jsonBody(claim);
		expect(claimBody.connectorId).toBe("sentry");
		expect(JSON.stringify(claimBody)).not.toContain(created.value.code);

		const complete = await handleDevicePairingCompleteRoute(
			deviceRequest(
				`${APP_ORIGIN}/api/device/pairing/complete`,
				harness.tokenA,
				{ pairingId: created.value.pairingId },
			),
			{ service: harness.service },
		);
		expect(complete.status).toBe(200);
		const completeBody = await jsonBody(complete);
		expect(completeBody.status).toBe("pending_validation");
		expect(JSON.stringify(completeBody)).not.toContain("secret");
	});

	test("status and cancel routes are session-guarded", async () => {
		const harness = await createHarness();
		const created = await harness.service.create(createBody(harness.deviceAId));
		if (!created.ok) throw new Error("create failed");
		const status = await handleDevicePairingStatusRoute(
			new Request(
				`${APP_ORIGIN}/api/device/pairing/${created.value.pairingId}`,
				{ headers: { host: new URL(APP_ORIGIN).host, origin: APP_ORIGIN } },
			),
			{ service: harness.service },
		);
		expect(status.status).toBe(200);
		const statusBody = await jsonBody(status);
		expect(statusBody.status).toBe("pending");

		const cancel = await handleDevicePairingCancelRoute(
			sessionRequest(`${APP_ORIGIN}/api/device/pairing/cancel`, {
				pairingId: created.value.pairingId,
			}),
			{ service: harness.service },
		);
		expect(cancel.status).toBe(200);
		expect((await jsonBody(cancel)).status).toBe("cancelled");
	});
});

describe("pairing helpers", () => {
	test("hash is deterministic sha256 hex and never the code", () => {
		const code = randomToken();
		const digest = hashPairingCode(code);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digest).toBe(hashPairingCode(code));
		expect(digest).not.toContain(code);
	});
});
