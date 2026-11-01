import { describe, expect, spyOn, test } from "bun:test";
import {
	type CreateConnectorDeviceInput,
	InMemoryConnectorCredentialRepository,
	InMemoryConnectorDeviceRepository,
	InMemoryRateLimitRepository,
	type UserRole,
} from "@isolate/db";
import {
	createConnectorDeviceBroker,
	hashConnectorDeviceToken,
	isConnectorDeviceToken,
} from "@isolate/integrations";
import {
	asOrganizationId,
	asUserId,
	type OrganizationId,
} from "@isolate/shared";
import {
	createDeviceRegistrationRoutes,
	type DeviceRegistrationRoutes,
	handleDeviceListRoute,
	handleDeviceRegisterRoute,
	handleDeviceRevokeRoute,
	handleDeviceRotateRoute,
} from "./device-registration.server";
import {
	createUserRateLimitGate,
	type UserRateLimitGate,
} from "./rate-limit.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER_A = asUserId("33333333-3333-4333-8333-333333333333");
const FOREIGN_DEVICE_ID = "44444444-4444-4444-8444-444444444444";
/** Test fixture, not a credential: 43 base64url characters. */
const FIXED_TOKEN = "A".repeat(43);

/** A distinct, valid base64url token per call; a hash is never reused. */
function tokenSequence(): () => string {
	let index = 0;
	return () => `A`.repeat(42) + String.fromCharCode(65 + index++);
}

class RecordingDeviceRepository extends InMemoryConnectorDeviceRepository {
	readonly created: CreateConnectorDeviceInput[] = [];

	override async create(input: CreateConnectorDeviceInput) {
		this.created.push(input);
		return super.create(input);
	}
}

type Harness = {
	devices: RecordingDeviceRepository;
	routes: DeviceRegistrationRoutes;
	token: string;
	scope: CallerScope;
};

function setup(
	options: {
		role?: UserRole;
		organizationId?: OrganizationId;
		resolveScope?: () => Promise<CallerScope>;
		rateLimiter?: UserRateLimitGate;
		generateToken?: () => string;
	} = {},
): Harness {
	const devices = new RecordingDeviceRepository();
	const scope: CallerScope = {
		organizationId: options.organizationId ?? ORG_A,
		userId: USER_A,
		role: options.role ?? "owner",
	};
	const routes = createDeviceRegistrationRoutes({
		resolveScope: options.resolveScope ?? (async () => ({ ...scope })),
		devices,
		generateToken: options.generateToken ?? (() => FIXED_TOKEN),
		...(options.rateLimiter === undefined
			? {}
			: { rateLimiter: options.rateLimiter }),
	});
	return { devices, routes, token: FIXED_TOKEN, scope };
}

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function get(path: string): Request {
	return new Request(`http://localhost${path}`, { method: "GET" });
}

async function jsonObject(
	response: Response,
): Promise<Record<string, unknown>> {
	const parsed: unknown = await response.json();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

async function registerDevice(h: Harness): Promise<{
	deviceId: string;
	token: string;
}> {
	const response = await h.routes.register(
		post("/api/device/register", { displayName: "Laptop A" }),
	);
	expect(response.status).toBe(200);
	const body = await jsonObject(response);
	const deviceId = body.deviceId;
	const token = body.token;
	if (typeof deviceId !== "string" || typeof token !== "string") {
		throw new Error("registration response is missing fields");
	}
	return { deviceId, token };
}

describe("device registration", () => {
	test("registers for an owner, returns the token once and stores only its hash", async () => {
		const h = setup();
		const response = await h.routes.register(
			post("/api/device/register", { displayName: "  Laptop A  " }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");

		const body = await jsonObject(response);
		expect(Object.keys(body).sort()).toEqual([
			"deviceId",
			"expiresAt",
			"token",
		]);
		expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now());
		expect(body.token).toBe(FIXED_TOKEN);
		expect(isConnectorDeviceToken(body.token)).toBe(true);
		const deviceId = body.deviceId;
		if (typeof deviceId !== "string") {
			throw new Error("registration response has no device id");
		}

		expect(h.devices.created).toHaveLength(1);
		const created = h.devices.created[0];
		expect(created.organizationId).toBe(ORG_A);
		expect(created.userId).toBe(USER_A);
		expect(created.displayName).toBe("Laptop A");
		expect(created.status).toBe("active");
		expect(created.tokenHash).toBe(hashConnectorDeviceToken(FIXED_TOKEN));
		expect(created.tokenHash).not.toBe(FIXED_TOKEN);
		expect(JSON.stringify(created)).not.toContain(FIXED_TOKEN);

		// The stored hash is enough to authenticate the device; the row is active.
		const verified = await h.devices.verifyByTokenHash(
			ORG_A,
			hashConnectorDeviceToken(FIXED_TOKEN),
		);
		expect(verified?.id).toBe(deviceId);
		expect(verified?.status).toBe("active");
	});

	test("never returns the token from list or revoke", async () => {
		const h = setup();
		const { deviceId, token } = await registerDevice(h);

		const list = await h.routes.list(get("/api/device/list"));
		expect(list.status).toBe(200);
		const listText = await list.text();
		expect(listText).not.toContain(token);
		const listed = JSON.parse(listText) as {
			devices: Record<string, unknown>[];
		};
		expect(listed.devices).toHaveLength(1);
		expect(Object.keys(listed.devices[0]).sort()).toEqual([
			"displayName",
			"id",
			"lastSeenAt",
			"status",
		]);
		expect(listed.devices[0].id).toBe(deviceId);
		expect(listed.devices[0].displayName).toBe("Laptop A");
		expect(listed.devices[0].lastSeenAt).toBeNull();
		expect(listText).not.toContain(hashConnectorDeviceToken(token));

		const revoke = await h.routes.revoke(
			post("/api/device/revoke", { deviceId }),
		);
		expect(revoke.status).toBe(200);
		const revokeText = await revoke.text();
		expect(revokeText).not.toContain(token);
		expect(JSON.parse(revokeText)).toEqual({
			deviceId,
			status: "revoked",
		});
	});

	test("forbids a caller without member:manage", async () => {
		for (const role of ["member", "viewer"] as const) {
			const h = setup({ role });
			const register = await h.routes.register(
				post("/api/device/register", { displayName: "Laptop A" }),
			);
			expect(register.status).toBe(403);
			expect(await jsonObject(register)).toEqual({ error: "forbidden" });

			const revoke = await h.routes.revoke(
				post("/api/device/revoke", { deviceId: FOREIGN_DEVICE_ID }),
			);
			expect(revoke.status).toBe(403);
			expect(h.devices.created).toHaveLength(0);
		}
	});

	test("requires an authenticated session", async () => {
		const h = setup({
			resolveScope: async () => {
				throw new ControlPlaneError("AUTH_REQUIRED");
			},
		});
		const response = await h.routes.register(
			post("/api/device/register", { displayName: "Laptop A" }),
		);
		expect(response.status).toBe(401);
		expect(await jsonObject(response)).toEqual({
			error: "authentication required",
		});
		expect(h.devices.created).toHaveLength(0);
	});

	test("rejects invalid registration input without echoing it", async () => {
		const h = setup();
		const bodies: unknown[] = [
			{},
			{ displayName: "" },
			{ displayName: "   " },
			{ displayName: "x".repeat(101) },
			{ displayName: "Laptop A", tokenHash: "a".repeat(64) },
			{ displayName: "Laptop A", role: "owner" },
			{ displayName: 42 },
		];
		for (const body of bodies) {
			const response = await h.routes.register(
				post("/api/device/register", body),
			);
			expect(response.status).toBe(400);
			const text = await response.text();
			expect(JSON.parse(text)).toEqual({ error: "device request is invalid" });
			expect(text).not.toContain("tokenHash");
		}

		const malformed = await h.routes.register(
			new Request("http://localhost/api/device/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			}),
		);
		expect(malformed.status).toBe(400);

		const oversized = await h.routes.register(
			new Request("http://localhost/api/device/register", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ displayName: "x".repeat(5000) }),
			}),
		);
		expect(oversized.status).toBe(400);
		expect(h.devices.created).toHaveLength(0);
	});

	test("lists only the caller's organization", async () => {
		const hA = setup();
		const hB = setup({ organizationId: ORG_B });
		await registerDevice(hA);
		await registerDevice(hB);

		const listA = await jsonObject(
			await hA.routes.list(get("/api/device/list")),
		);
		const devicesA = listA.devices as Record<string, unknown>[];
		expect(devicesA).toHaveLength(1);

		const listB = await jsonObject(
			await hB.routes.list(get("/api/device/list")),
		);
		const devicesB = listB.devices as Record<string, unknown>[];
		expect(devicesB).toHaveLength(1);
		expect(devicesB[0].id).not.toBe(devicesA[0].id);
	});

	test("revokes idempotently and the revoked token stops authenticating", async () => {
		const h = setup();
		const { deviceId, token } = await registerDevice(h);

		const first = await h.routes.revoke(
			post("/api/device/revoke", { deviceId }),
		);
		const second = await h.routes.revoke(
			post("/api/device/revoke", { deviceId }),
		);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await first.json()).toEqual({ deviceId, status: "revoked" });
		expect(await second.json()).toEqual({ deviceId, status: "revoked" });

		expect(
			await h.devices.verifyByTokenHash(ORG_A, hashConnectorDeviceToken(token)),
		).toBeNull();
		const list = await jsonObject(await h.routes.list(get("/api/device/list")));
		const devices = list.devices as Record<string, unknown>[];
		expect(devices[0].status).toBe("revoked");
	});

	test("treats a foreign-tenant device as not found", async () => {
		const hA = setup();
		const hB = setup({ organizationId: ORG_B });
		const foreign = await registerDevice(hB);

		const response = await hA.routes.revoke(
			post("/api/device/revoke", { deviceId: foreign.deviceId }),
		);
		expect(response.status).toBe(404);
		expect(await jsonObject(response)).toEqual({ error: "device not found" });

		// Still active for its own tenant.
		const verified = await hB.devices.verifyByTokenHash(
			ORG_B,
			hashConnectorDeviceToken(foreign.token),
		);
		expect(verified?.id).toBe(foreign.deviceId);
		expect(verified?.status).toBe("active");
	});

	test("revoking a device makes its credentials unusable to the broker", async () => {
		const h = setup();
		const { deviceId } = await registerDevice(h);
		const credentials = new InMemoryConnectorCredentialRepository();
		await credentials.create({
			organizationId: ORG_A,
			deviceId,
			connectorId: "sentry",
			displayName: "Team Sentry",
			authKind: "api_key",
			credentialRef: "keychain:isolate/sentry/team-a",
			status: "active",
		});
		const broker = createConnectorDeviceBroker({
			devices: h.devices,
			credentials,
			proxyFactory: () => ({ execute: async () => ({ ok: true, data: {} }) }),
		});

		const before = await broker.resolve(ORG_A, "sentry");
		expect(before.credentialRef).toBe("keychain:isolate/sentry/team-a");

		await h.routes.revoke(post("/api/device/revoke", { deviceId }));

		await expect(broker.resolve(ORG_A, "sentry")).rejects.toMatchObject({
			code: "INTEGRATION_UNAVAILABLE",
		});
	});

	test("never writes the token to a log", async () => {
		const spies = [
			spyOn(console, "log"),
			spyOn(console, "warn"),
			spyOn(console, "error"),
		];
		try {
			const h = setup();
			const { deviceId, token } = await registerDevice(h);
			await h.routes.list(get("/api/device/list"));
			await h.routes.revoke(post("/api/device/revoke", { deviceId }));
			for (const spy of spies) {
				for (const call of spy.mock.calls) {
					expect(JSON.stringify(call)).not.toContain(token);
				}
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("device token rotation", () => {
	test("returns a fresh token once, kills the old one and renews the expiry", async () => {
		const h = setup({ generateToken: tokenSequence() });
		const { deviceId, token: oldToken } = await registerDevice(h);
		const before = (await h.devices.listByOrganization(ORG_A))[0];

		const response = await h.routes.rotate(
			post("/api/device/rotate", { deviceId }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");

		const body = await jsonObject(response);
		expect(Object.keys(body).sort()).toEqual([
			"deviceId",
			"expiresAt",
			"token",
		]);
		expect(body.deviceId).toBe(deviceId);
		const newToken = body.token;
		if (typeof newToken !== "string") {
			throw new Error("rotation response has no token");
		}
		expect(newToken).not.toBe(oldToken);
		expect(isConnectorDeviceToken(newToken)).toBe(true);
		expect(JSON.stringify(body)).not.toContain(
			hashConnectorDeviceToken(newToken),
		);

		const newExpiry = Date.parse(String(body.expiresAt));
		expect(newExpiry).toBeGreaterThan(Date.now());
		expect(newExpiry).toBeGreaterThanOrEqual(before.expiresAt?.getTime() ?? 0);

		const after = (await h.devices.listByOrganization(ORG_A))[0];
		expect(after.status).toBe("active");
		expect(after.expiresAt?.toISOString()).toBe(String(body.expiresAt));

		// The old token stops authenticating immediately.
		expect(
			await h.devices.verifyByTokenHash(
				ORG_A,
				hashConnectorDeviceToken(oldToken),
			),
		).toBeNull();
		expect(
			(
				await h.devices.verifyByTokenHash(
					ORG_A,
					hashConnectorDeviceToken(newToken),
				)
			)?.id,
		).toBe(deviceId);
	});

	test("answers one 404 for a foreign, revoked or missing device", async () => {
		const hA = setup({ generateToken: tokenSequence() });
		const hB = setup({
			organizationId: ORG_B,
			generateToken: tokenSequence(),
		});
		const foreign = await registerDevice(hB);
		const own = await registerDevice(hA);
		await hA.routes.revoke(
			post("/api/device/revoke", { deviceId: own.deviceId }),
		);

		const attempts: string[] = [
			foreign.deviceId,
			own.deviceId,
			FOREIGN_DEVICE_ID,
		];
		for (const deviceId of attempts) {
			const response = await hA.routes.rotate(
				post("/api/device/rotate", { deviceId }),
			);
			expect(response.status).toBe(404);
			expect(await jsonObject(response)).toEqual({ error: "device not found" });
		}

		// The foreign device still authenticates with its own token.
		const verified = await hB.devices.verifyByTokenHash(
			ORG_B,
			hashConnectorDeviceToken(foreign.token),
		);
		expect(verified?.id).toBe(foreign.deviceId);
		expect(verified?.status).toBe("active");
	});

	test("allows admin and owner, forbids member and viewer", async () => {
		for (const role of ["member", "viewer"] as const) {
			const h = setup({ role, generateToken: tokenSequence() });
			const response = await h.routes.rotate(
				post("/api/device/rotate", { deviceId: FOREIGN_DEVICE_ID }),
			);
			expect(response.status).toBe(403);
			expect(await jsonObject(response)).toEqual({ error: "forbidden" });
		}
		for (const role of ["owner", "admin"] as const) {
			const h = setup({ role, generateToken: tokenSequence() });
			const { deviceId, token } = await registerDevice(h);
			const response = await h.routes.rotate(
				post("/api/device/rotate", { deviceId }),
			);
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).not.toContain(token);
		}
	});

	test("rejects an invalid body, a wrong method and a non-POST caller", async () => {
		const h = setup({ generateToken: tokenSequence() });
		const { deviceId, token } = await registerDevice(h);

		for (const body of [
			{},
			{ deviceId: "not-a-uuid" },
			{ deviceId, displayName: "Laptop A" },
			{ deviceId: 42 },
		]) {
			const response = await h.routes.rotate(post("/api/device/rotate", body));
			expect(response.status).toBe(400);
			expect(await jsonObject(response)).toEqual({
				error: "device request is invalid",
			});
		}

		const wrongMethod = await h.routes.rotate(get("/api/device/rotate"));
		expect(wrongMethod.status).toBe(405);

		// Nothing above minted a token or changed the device.
		expect(
			(
				await h.devices.verifyByTokenHash(
					ORG_A,
					hashConnectorDeviceToken(token),
				)
			)?.id,
		).toBe(deviceId);
	});

	test("runs the same-origin and JSON guards before touching the device", async () => {
		const h = setup({ generateToken: tokenSequence() });
		const { deviceId, token } = await registerDevice(h);

		const crossSite = new Request("http://localhost/api/device/rotate", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({ deviceId }),
		});
		const crossSiteResponse = await h.routes.rotate(crossSite);
		expect(crossSiteResponse.status).toBe(403);
		expect(await jsonObject(crossSiteResponse)).toEqual({
			error: "request rejected",
		});

		const crossOrigin = new Request("http://localhost/api/device/rotate", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://evil.example",
			},
			body: JSON.stringify({ deviceId }),
		});
		expect((await h.routes.rotate(crossOrigin)).status).toBe(403);

		const notJson = new Request("http://localhost/api/device/rotate", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ deviceId }),
		});
		expect((await h.routes.rotate(notJson)).status).toBe(415);

		// The token survived every rejected request.
		expect(
			(
				await h.devices.verifyByTokenHash(
					ORG_A,
					hashConnectorDeviceToken(token),
				)
			)?.id,
		).toBe(deviceId);
	});

	test("the eleventh rotation in a minute is a fixed 429 that mints nothing", async () => {
		let minted = 0;
		const next = tokenSequence();
		const h = setup({
			rateLimiter: createUserRateLimitGate(new InMemoryRateLimitRepository()),
			generateToken: () => {
				minted += 1;
				return next();
			},
		});
		const { deviceId } = await registerDevice(h);
		for (let index = 0; index < 10; index += 1) {
			const response = await h.routes.rotate(
				post("/api/device/rotate", { deviceId }),
			);
			expect(response.status).toBe(200);
		}
		expect(minted).toBe(11);

		const denied = await h.routes.rotate(
			post("/api/device/rotate", { deviceId }),
		);
		expect(denied.status).toBe(429);
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(await denied.json()).toEqual({ error: "too many requests" });
		expect(minted).toBe(11);
	});

	test("never writes either token to a log", async () => {
		const spies = [
			spyOn(console, "log"),
			spyOn(console, "warn"),
			spyOn(console, "error"),
		];
		try {
			const h = setup({ generateToken: tokenSequence() });
			const { deviceId, token: oldToken } = await registerDevice(h);
			const rotated = await h.routes.rotate(
				post("/api/device/rotate", { deviceId }),
			);
			const newToken = (await jsonObject(rotated)).token;
			for (const spy of spies) {
				for (const call of spy.mock.calls) {
					const serialized = JSON.stringify(call);
					expect(serialized).not.toContain(oldToken);
					expect(serialized).not.toContain(String(newToken));
				}
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("device registration route adapters", () => {
	test("return 503 when the device gateway is disabled", async () => {
		const register = await handleDeviceRegisterRoute(
			post("/api/device/register", { displayName: "Laptop A" }),
			{},
		);
		expect(register.status).toBe(503);
		expect(register.headers.get("cache-control")).toBe("no-store");
		expect(await jsonObject(register)).toEqual({
			error: "device registration is unavailable",
		});

		const list = await handleDeviceListRoute(get("/api/device/list"), {});
		expect(list.status).toBe(503);

		const revoke = await handleDeviceRevokeRoute(
			post("/api/device/revoke", { deviceId: FOREIGN_DEVICE_ID }),
			{},
		);
		expect(revoke.status).toBe(503);

		const rotate = await handleDeviceRotateRoute(
			post("/api/device/rotate", { deviceId: FOREIGN_DEVICE_ID }),
			{},
		);
		expect(rotate.status).toBe(503);
		expect(rotate.headers.get("cache-control")).toBe("no-store");
	});

	test("return 503 when the database is not configured", async () => {
		const env = { DEVICE_GATEWAY_ENABLED: "true" };
		expect(
			(
				await handleDeviceRegisterRoute(
					post("/api/device/register", { displayName: "Laptop A" }),
					env,
				)
			).status,
		).toBe(503);
		expect(
			(await handleDeviceListRoute(get("/api/device/list"), env)).status,
		).toBe(503);
		expect(
			(
				await handleDeviceRotateRoute(
					post("/api/device/rotate", { deviceId: FOREIGN_DEVICE_ID }),
					env,
				)
			).status,
		).toBe(503);
	});

	test("return 503 when auth is not configured", async () => {
		const env = {
			DEVICE_GATEWAY_ENABLED: "true",
			DATABASE_URL: "postgres://localhost:5432/isolate",
		};
		expect(
			(
				await handleDeviceRegisterRoute(
					post("/api/device/register", { displayName: "Laptop A" }),
					env,
				)
			).status,
		).toBe(503);
	});
});

describe("device registration throttling", () => {
	test("the eleventh register in a minute is a fixed 429 with Retry-After", async () => {
		let lastToken = 0;
		const h = setup({
			rateLimiter: createUserRateLimitGate(new InMemoryRateLimitRepository()),
			// A distinct token per device: a token hash must never be reused.
			generateToken: () =>
				`A`.repeat(42) + String.fromCharCode(65 + lastToken++),
		});
		for (let index = 0; index < 10; index += 1) {
			const response = await h.routes.register(
				post("/api/device/register", { displayName: `Laptop ${index}` }),
			);
			expect(response.status).toBe(200);
		}
		const denied = await h.routes.register(
			post("/api/device/register", { displayName: "Laptop 11" }),
		);
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(await denied.json()).toEqual({ error: "too many requests" });
		// The refused request minted nothing.
		expect(h.devices.created).toHaveLength(10);
		// A different action has its own bucket.
		const listed = await h.routes.list(get("/api/device/list"));
		expect(listed.status).toBe(200);
	});

	test("list is denied only after its own 120-per-minute budget", async () => {
		const h = setup({
			rateLimiter: createUserRateLimitGate(new InMemoryRateLimitRepository()),
		});
		for (let index = 0; index < 120; index += 1) {
			expect((await h.routes.list(get("/api/device/list"))).status).toBe(200);
		}
		const denied = await h.routes.list(get("/api/device/list"));
		expect(denied.status).toBe(429);
		expect(Number(denied.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
	});
});
