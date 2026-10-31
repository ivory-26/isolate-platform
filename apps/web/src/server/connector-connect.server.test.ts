import { describe, expect, test } from "bun:test";
import {
	InMemoryConnectorCredentialRepository,
	InMemoryConnectorDeviceRepository,
	type UserRole,
} from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	CONNECTOR_CONNECT_FAILURE_MESSAGES,
	CONNECTOR_CONNECT_IDS,
	type ConnectorConnectFailureCode,
	type ConnectorConnectResult,
	type ConnectorConnectService,
	createConnectorConnectService,
	handleConnectorConnectRoute,
	handleConnectorListRoute,
	handleConnectorRevokeRoute,
	looksLikeCredentialSecret,
	resetConnectorConnectForTests,
} from "./connector-connect.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER_ID = asUserId("33333333-3333-4333-8333-333333333333");
const NO_STORE = "no-store";

type HarnessOptions = {
	role?: UserRole;
	scopeError?: "AUTH_REQUIRED" | "FORBIDDEN";
};

type Harness = {
	service: ConnectorConnectService;
	devices: InMemoryConnectorDeviceRepository;
	credentials: InMemoryConnectorCredentialRepository;
	deviceAId: string;
	deviceA2Id: string;
	pendingDeviceId: string;
	revokedDeviceId: string;
	deviceBId: string;
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const devices = new InMemoryConnectorDeviceRepository();
	const credentials = new InMemoryConnectorCredentialRepository();
	const deviceA = await devices.create({
		organizationId: ORG_A,
		displayName: "Laptop A",
		tokenHash: "a".repeat(64),
		status: "active",
	});
	const deviceA2 = await devices.create({
		organizationId: ORG_A,
		displayName: "Desktop A",
		tokenHash: "b".repeat(64),
		status: "active",
	});
	const pending = await devices.create({
		organizationId: ORG_A,
		displayName: "Unpaired laptop",
		tokenHash: "c".repeat(64),
		status: "pending",
	});
	const revoked = await devices.create({
		organizationId: ORG_A,
		displayName: "Retired laptop",
		tokenHash: "d".repeat(64),
		status: "revoked",
	});
	const deviceB = await devices.create({
		organizationId: ORG_B,
		displayName: "Laptop B",
		tokenHash: "e".repeat(64),
		status: "active",
	});
	const scope: CallerScope = {
		organizationId: ORG_A,
		userId: USER_ID,
		role: options.role ?? "owner",
	};
	const service = createConnectorConnectService({
		devices,
		credentials,
		resolveScope: async () => {
			if (options.scopeError !== undefined) {
				throw new ControlPlaneError(options.scopeError);
			}
			return scope;
		},
	});
	return {
		service,
		devices,
		credentials,
		deviceAId: deviceA.id,
		deviceA2Id: deviceA2.id,
		pendingDeviceId: pending.id,
		revokedDeviceId: revoked.id,
		deviceBId: deviceB.id,
	};
}

function payload(
	deviceId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		deviceId,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/team-a",
		...overrides,
	};
}

function connectRequest(
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request("http://localhost/api/connectors/connect", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body:
			typeof body === "string"
				? body
				: JSON.stringify(body as Record<string, unknown>),
	});
}

function listRequest(query = ""): Request {
	return new Request(`http://localhost/api/connectors/list${query}`, {
		method: "GET",
	});
}

function revokeRequest(body: unknown): Request {
	return new Request("http://localhost/api/connectors/revoke", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body as Record<string, unknown>),
	});
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
	expect(response.headers.get("cache-control")).toBe(NO_STORE);
	return (await response.json()) as Record<string, unknown>;
}

async function expectFailure<T>(
	result: ConnectorConnectResult<T>,
	code: ConnectorConnectFailureCode,
	forbiddenEcho: readonly string[] = [],
): Promise<void> {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.code).toBe(code);
	const serialized = JSON.stringify(result);
	for (const value of forbiddenEcho) {
		expect(serialized).not.toContain(value);
	}
}

const SECRET_SHAPES = [
	`ghp_${"A".repeat(36)}`,
	`gho_${"B".repeat(36)}`,
	`ghu_${"C".repeat(36)}`,
	`ghs_${"D".repeat(36)}`,
	`ghr_${"E".repeat(36)}`,
	`github_pat_${"F".repeat(30)}`,
	"xoxb-1234567890-abcdefghij",
	"xoxp-9876543210-klmnopqrst",
	"AKIAIOSFODNN7EXAMPLE",
	"-----BEGIN RSA PRIVATE KEY-----",
];

describe("connector connect capability boundary", () => {
	for (const role of ["member", "viewer"] as const) {
		test(`${role} cannot connect or revoke`, async () => {
			const harness = await createHarness({ role });
			const connect = await harness.service.connect(payload(harness.deviceAId));
			await expectFailure(connect, "FORBIDDEN");
			expect(harness.credentials.rowCount).toBe(0);

			const created = await createHarness().then((owner) =>
				owner.service.connect(payload(owner.deviceAId)),
			);
			if (!created.ok) throw new Error("fixture connect failed");
			const revoke = await harness.service.revoke({
				credentialId: created.value.credentialId,
			});
			await expectFailure(revoke, "FORBIDDEN");
		});
	}

	test("owner and admin may connect", async () => {
		for (const role of ["owner", "admin"] as const) {
			const harness = await createHarness({ role });
			const result = await harness.service.connect(payload(harness.deviceAId));
			expect(result.ok).toBe(true);
		}
	});

	test("a missing session is AUTH_REQUIRED for connect, list and revoke", async () => {
		const harness = await createHarness({ scopeError: "AUTH_REQUIRED" });
		await expectFailure(
			await harness.service.connect(payload(harness.deviceAId)),
			"AUTH_REQUIRED",
		);
		const list = await harness.service.list({});
		expect(list.ok).toBe(false);
		if (!list.ok) expect(list.error.code).toBe("AUTH_REQUIRED");
		const revoke = await harness.service.revoke({
			credentialId: crypto.randomUUID(),
		});
		expect(revoke.ok).toBe(false);
		if (!revoke.ok) expect(revoke.error.code).toBe("AUTH_REQUIRED");
	});
});

describe("connector connect device scope", () => {
	test("a device from another organization is a 404", async () => {
		const harness = await createHarness();
		const result = await harness.service.connect(payload(harness.deviceBId));
		await expectFailure(result, "NOT_FOUND");
		expect(harness.credentials.rowCount).toBe(0);
	});

	test("pending, revoked and unknown devices are a 404", async () => {
		const harness = await createHarness();
		for (const deviceId of [
			harness.pendingDeviceId,
			harness.revokedDeviceId,
			crypto.randomUUID(),
		]) {
			await expectFailure(
				await harness.service.connect(payload(deviceId)),
				"NOT_FOUND",
			);
		}
		expect(harness.credentials.rowCount).toBe(0);
	});

	test("a foreign credential cannot be revoked", async () => {
		const harness = await createHarness();
		// A real ORG_B row in the same table: the caller's scope must hide it.
		const foreign = await harness.credentials.create({
			organizationId: ORG_B,
			deviceId: harness.deviceBId,
			connectorId: "pagerduty",
			displayName: "Team B PagerDuty",
			authKind: "api_key",
			credentialRef: "keychain:isolate/pagerduty/team-b",
			status: "active",
		});
		const result = await harness.service.revoke({
			credentialId: foreign.id,
		});
		await expectFailure(result, "NOT_FOUND", [foreign.id]);
		const stored = await harness.credentials.get(ORG_B, foreign.id);
		expect(stored?.status).toBe("active");
	});
});

describe("connector connect input boundary", () => {
	test("only the ten connectors are accepted", async () => {
		const harness = await createHarness();
		for (const connectorId of CONNECTOR_CONNECT_IDS) {
			const result = await harness.service.connect(
				payload(harness.deviceAId, {
					connectorId,
					displayName: `Team ${connectorId}`,
					credentialRef: `keychain:isolate/${connectorId}/team-a`,
				}),
			);
			expect(result.ok).toBe(true);
		}
		for (const connectorId of ["slack", "k8s", "Sentry", "unknown"]) {
			await expectFailure(
				await harness.service.connect(
					payload(harness.deviceAId, {
						connectorId,
						displayName: `Team ${connectorId}`,
						credentialRef: `keychain:isolate/${connectorId}/team-a`,
					}),
				),
				"INVALID_INPUT",
			);
		}
		expect(harness.credentials.rowCount).toBe(CONNECTOR_CONNECT_IDS.length);
	});

	for (const secret of SECRET_SHAPES) {
		test(`credentialRef rejects ${secret.slice(0, 18)}… without echo`, async () => {
			const harness = await createHarness();
			const result = await harness.service.connect(
				payload(harness.deviceAId, { credentialRef: secret }),
			);
			await expectFailure(result, "INVALID_INPUT", [secret]);
			expect(harness.credentials.rowCount).toBe(0);
		});
	}

	test("credentialRef must be a bounded opaque name", async () => {
		const harness = await createHarness();
		for (const credentialRef of [
			"",
			"   ",
			"bad ref",
			"bad/ref\u0000",
			"bad\nref",
			"r".repeat(201),
			"r".repeat(257),
		]) {
			await expectFailure(
				await harness.service.connect(
					payload(harness.deviceAId, { credentialRef }),
				),
				"INVALID_INPUT",
			);
		}
		const accepted = await harness.service.connect(
			payload(harness.deviceAId, {
				credentialRef: "iso.team_a-1~2:keychain/sentry",
			}),
		);
		expect(accepted.ok).toBe(true);
	});

	test("a secret pasted into any other field is refused", async () => {
		const harness = await createHarness();
		const secret = SECRET_SHAPES[0] as string;
		const attempts: Record<string, unknown>[] = [
			payload(harness.deviceAId, { displayName: `Team ${secret}` }),
			payload(harness.deviceAId, {
				scopes: [`issues:read`, `xoxb-1234567890-abcdef`],
			}),
			payload(harness.deviceAId, { metadata: { note: secret } }),
			payload(harness.deviceAId, { metadata: { secret: "anything" } }),
			payload(harness.deviceAId, {
				metadata: { a: { b: { c: { d: { e: { f: secret } } } } } },
			}),
			payload(harness.deviceAId, { apiKey: "must-not-be-accepted" }),
		];
		for (const attempt of attempts) {
			await expectFailure(
				await harness.service.connect(attempt),
				"INVALID_INPUT",
			);
		}
		expect(harness.credentials.rowCount).toBe(0);
	});

	test("secret detection covers every vendor shape and spares names", () => {
		for (const secret of SECRET_SHAPES) {
			expect(looksLikeCredentialSecret(secret)).toBe(true);
		}
		expect(looksLikeCredentialSecret("r".repeat(257))).toBe(true);
		for (const name of [
			"keychain:isolate/sentry/team-a",
			"iso.team_a-1~2:keychain/sentry",
			"Github App Token",
		]) {
			expect(looksLikeCredentialSecret(name)).toBe(false);
		}
	});
});

describe("connector connect metadata-only write", () => {
	test("a valid connect stores metadata and returns only the id", async () => {
		const harness = await createHarness();
		const result = await harness.service.connect(
			payload(harness.deviceAId, {
				scopes: ["issues:read", "issues:write"],
				freeTierProfile: {
					requestsPerMinute: 10,
					requestsPerDay: 100,
					eventsPerMonth: 5000,
					retentionDays: 30,
				},
				metadata: { enabledTools: ["sentry.list_issues"] },
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("connect failed");
		expect(Object.keys(result.value)).toEqual(["credentialId"]);
		expect(JSON.stringify(result.value)).not.toContain("secret");

		const stored = await harness.credentials.get(
			ORG_A,
			result.value.credentialId,
		);
		expect(stored).not.toBeNull();
		if (stored === null) return;
		expect(stored.organizationId).toBe(ORG_A);
		expect(stored.deviceId).toBe(harness.deviceAId);
		expect(stored.connectorId).toBe("sentry");
		expect(stored.displayName).toBe("Team Sentry");
		expect(stored.authKind).toBe("api_key");
		expect(stored.credentialRef).toBe("keychain:isolate/sentry/team-a");
		expect(stored.scopes).toEqual(["issues:read", "issues:write"]);
		expect(stored.status).toBe("pending_validation");
		expect(stored.freeTierProfile).toEqual({
			requestsPerMinute: 10,
			requestsPerDay: 100,
			eventsPerMonth: 5000,
			retentionDays: 30,
		});
		expect(stored.metadata).toEqual({
			enabledTools: ["sentry.list_issues"],
		});
		// There is no secret column and no secret-shaped string in the row.
		expect(Object.hasOwn(stored, "secret")).toBe(false);
		expect(Object.hasOwn(stored, "token")).toBe(false);
		expect(Object.hasOwn(stored, "ciphertext")).toBe(false);
		expect(JSON.stringify(stored)).not.toContain("secret");
		expect(JSON.stringify(stored)).not.toContain("token");
	});

	test("duplicate metadata rows are refused without leaking storage text", async () => {
		const harness = await createHarness();
		const first = await harness.service.connect(payload(harness.deviceAId));
		expect(first.ok).toBe(true);
		const second = await harness.service.connect(payload(harness.deviceAId));
		await expectFailure(second, "INVALID_INPUT", ["display name"]);
		expect(harness.credentials.rowCount).toBe(1);
	});
});

describe("connector list and revoke", () => {
	test("list is tenant-scoped, filterable and secret-free", async () => {
		const harness = await createHarness();
		const first = await harness.service.connect(
			payload(harness.deviceAId, {
				connectorId: "sentry",
				displayName: "Team A Sentry",
				credentialRef: "keychain:isolate/sentry/team-a",
			}),
		);
		const second = await harness.service.connect(
			payload(harness.deviceA2Id, {
				connectorId: "grafana",
				displayName: "Team A Grafana",
				credentialRef: "keychain:isolate/grafana/team-a",
			}),
		);
		if (!first.ok || !second.ok) throw new Error("fixture connect failed");

		// Another tenant's row is invisible even though the caller is the owner.
		await harness.credentials.create({
			organizationId: ORG_B,
			deviceId: harness.deviceBId,
			connectorId: "pagerduty",
			displayName: "Team B PagerDuty",
			authKind: "api_key",
			credentialRef: "keychain:isolate/pagerduty/team-b",
			status: "active",
		});

		const all = await harness.service.list({});
		expect(all.ok).toBe(true);
		if (!all.ok) return;
		expect(all.value).toHaveLength(2);
		expect(all.value.map((row) => row.id).sort()).toEqual(
			[first.value.credentialId, second.value.credentialId].sort(),
		);
		expect(all.value.every((row) => row.status === "pending_validation")).toBe(
			true,
		);

		const filtered = await harness.service.list({
			deviceId: harness.deviceAId,
		});
		expect(filtered.ok).toBe(true);
		if (filtered.ok) {
			expect(filtered.value).toHaveLength(1);
			expect(filtered.value[0]?.id).toBe(first.value.credentialId);
		}

		const foreignFilter = await harness.service.list({
			deviceId: harness.deviceBId,
		});
		expect(foreignFilter.ok).toBe(true);
		if (foreignFilter.ok) expect(foreignFilter.value).toEqual([]);

		const serialized = JSON.stringify(all.value);
		expect(serialized).not.toContain('"secret"');
		expect(serialized).not.toContain('"token"');
		expect(serialized).not.toContain('"ciphertext"');
		expect(serialized).toContain("keychain:isolate/sentry/team-a");

		const member = await createHarness({ role: "member" });
		const memberList = await member.service.list({});
		expect(memberList.ok).toBe(true);
	});

	test("revoke is tenant-scoped and idempotent", async () => {
		const harness = await createHarness();
		const created = await harness.service.connect(payload(harness.deviceAId));
		if (!created.ok) throw new Error("fixture connect failed");
		const credentialId = created.value.credentialId;

		// A different tenant (empty repositories) cannot flip the row.
		const foreign = await createHarness();
		await expectFailure(
			await foreign.service.revoke({ credentialId }),
			"NOT_FOUND",
		);
		expect((await harness.credentials.get(ORG_A, credentialId))?.status).toBe(
			"pending_validation",
		);

		const first = await harness.service.revoke({ credentialId });
		expect(first.ok).toBe(true);
		if (first.ok) {
			expect(first.value).toEqual({ credentialId, status: "revoked" });
		}
		const second = await harness.service.revoke({ credentialId });
		expect(second.ok).toBe(true);
		if (second.ok) {
			expect(second.value).toEqual({ credentialId, status: "revoked" });
		}
		expect((await harness.credentials.get(ORG_A, credentialId))?.status).toBe(
			"revoked",
		);

		// The metadata row is retained for provenance and still lists.
		const list = await harness.service.list({});
		expect(list.ok).toBe(true);
		if (list.ok) {
			expect(list.value).toHaveLength(1);
			expect(list.value[0]?.status).toBe("revoked");
		}
	});

	test("an unknown or malformed credential id is refused", async () => {
		const harness = await createHarness();
		await expectFailure(
			await harness.service.revoke({ credentialId: crypto.randomUUID() }),
			"NOT_FOUND",
		);
		await expectFailure(
			await harness.service.revoke({ credentialId: "not-a-uuid" }),
			"INVALID_INPUT",
		);
	});
});

describe("connector connect routes", () => {
	const ENABLED_ENV = {
		DEVICE_GATEWAY_ENABLED: "true",
		DATABASE_URL: "postgres://fixture-secret-value@localhost/isolate",
	};

	test("routes fail closed with a fixed 503 while the gateway is disabled", async () => {
		resetConnectorConnectForTests();
		const disabled = {
			...ENABLED_ENV,
			DEVICE_GATEWAY_ENABLED: "false",
		};
		const responses = [
			await handleConnectorConnectRoute(
				connectRequest(payload(crypto.randomUUID())),
				{ env: disabled },
			),
			await handleConnectorListRoute(listRequest(), { env: disabled }),
			await handleConnectorRevokeRoute(
				revokeRequest({ credentialId: crypto.randomUUID() }),
				{ env: disabled },
			),
		];
		for (const response of responses) {
			expect(response.status).toBe(503);
			const body = await readBody(response);
			expect(body).toEqual({
				error: CONNECTOR_CONNECT_FAILURE_MESSAGES.UNAVAILABLE,
			});
			expect(JSON.stringify(body)).not.toContain("fixture-secret-value");
		}

		for (const env of [
			{},
			{ DEVICE_GATEWAY_ENABLED: "true" },
			{ DEVICE_GATEWAY_ENABLED: "yes-secret-value", DATABASE_URL: "x" },
		]) {
			const response = await handleConnectorConnectRoute(
				connectRequest(payload(crypto.randomUUID())),
				{ env },
			);
			expect(response.status).toBe(503);
			const body = await readBody(response);
			expect(JSON.stringify(body)).not.toContain("yes-secret-value");
		}
	});

	test("connect route returns the credential id and never the request secret", async () => {
		const harness = await createHarness();
		const response = await handleConnectorConnectRoute(
			connectRequest(payload(harness.deviceAId)),
			{ service: harness.service },
		);
		expect(response.status).toBe(200);
		const body = await readBody(response);
		expect(Object.keys(body)).toEqual(["credentialId"]);
		expect(typeof body.credentialId).toBe("string");
		expect(JSON.stringify(body)).not.toContain("keychain:");
	});

	test("connect route maps failures to bounded statuses", async () => {
		const owner = await createHarness();
		const auth = await createHarness({ scopeError: "AUTH_REQUIRED" });
		const member = await createHarness({ role: "member" });
		const cases: Array<[ConnectorConnectService, number]> = [
			[auth.service, 401],
			[member.service, 403],
		];
		for (const [service, status] of cases) {
			const response = await handleConnectorConnectRoute(
				connectRequest(payload(owner.deviceAId)),
				{ service },
			);
			expect(response.status).toBe(status);
			await readBody(response);
		}

		const foreign = await handleConnectorConnectRoute(
			connectRequest(payload(owner.deviceBId)),
			{ service: owner.service },
		);
		expect(foreign.status).toBe(404);
		await readBody(foreign);

		const unknownConnector = await handleConnectorConnectRoute(
			connectRequest(payload(owner.deviceAId, { connectorId: "slack" })),
			{ service: owner.service },
		);
		expect(unknownConnector.status).toBe(400);
		await readBody(unknownConnector);

		const malformed = await handleConnectorConnectRoute(
			connectRequest("{not json"),
			{ service: owner.service },
		);
		expect(malformed.status).toBe(400);
		await readBody(malformed);

		const arrayBody = await handleConnectorConnectRoute(connectRequest("[]"), {
			service: owner.service,
		});
		expect(arrayBody.status).toBe(400);
		await readBody(arrayBody);

		const oversized = await handleConnectorConnectRoute(
			connectRequest(`{"deviceId":"${"x".repeat(20_000)}"}`),
			{ service: owner.service },
		);
		expect(oversized.status).toBe(413);
		await readBody(oversized);

		const secretRef = SECRET_SHAPES[0] as string;
		const refused = await handleConnectorConnectRoute(
			connectRequest(payload(owner.deviceAId, { credentialRef: secretRef })),
			{ service: owner.service },
		);
		expect(refused.status).toBe(400);
		const refusedBody = await readBody(refused);
		expect(JSON.stringify(refusedBody)).not.toContain(secretRef);
	});

	test("list route passes the device filter and revoke route flips status", async () => {
		const harness = await createHarness();
		const created = await harness.service.connect(payload(harness.deviceAId));
		if (!created.ok) throw new Error("fixture connect failed");
		const credentialId = created.value.credentialId;

		const list = await handleConnectorListRoute(
			listRequest(`?deviceId=${harness.deviceAId}`),
			{ service: harness.service },
		);
		expect(list.status).toBe(200);
		const listBody = await readBody(list);
		expect(listBody.credentials).toHaveLength(1);

		const badFilter = await handleConnectorListRoute(
			listRequest("?deviceId=not-a-uuid"),
			{ service: harness.service },
		);
		expect(badFilter.status).toBe(400);
		await readBody(badFilter);

		const revoke = await handleConnectorRevokeRoute(
			revokeRequest({ credentialId }),
			{ service: harness.service },
		);
		expect(revoke.status).toBe(200);
		const revokeBody = await readBody(revoke);
		expect(revokeBody).toEqual({ credentialId, status: "revoked" });

		const repeated = await handleConnectorRevokeRoute(
			revokeRequest({ credentialId }),
			{ service: harness.service },
		);
		expect(repeated.status).toBe(200);
		await readBody(repeated);
	});

	test("route handlers never fall open when the service throws", async () => {
		const throwing: ConnectorConnectService = {
			async connect() {
				throw new Error("private driver text");
			},
			async list() {
				throw new Error("private driver text");
			},
			async revoke() {
				throw new Error("private driver text");
			},
		};
		const responses = [
			await handleConnectorConnectRoute(
				connectRequest(payload(crypto.randomUUID())),
				{ service: throwing },
			),
			await handleConnectorListRoute(listRequest(), { service: throwing }),
			await handleConnectorRevokeRoute(
				revokeRequest({ credentialId: crypto.randomUUID() }),
				{ service: throwing },
			),
		];
		for (const response of responses) {
			expect(response.status).toBe(503);
			const body = await readBody(response);
			expect(JSON.stringify(body)).not.toContain("private driver text");
		}
	});
});
