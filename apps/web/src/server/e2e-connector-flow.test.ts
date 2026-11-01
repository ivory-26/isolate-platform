import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	type CreateConnectorDeviceInput,
	type GetTaskTraceInput,
	InMemoryConnectorCallRepository,
	InMemoryConnectorCredentialRepository,
	InMemoryConnectorDeviceRepository,
	InMemoryConnectorUsageLedger,
	InMemoryRateLimitRepository,
	type TaskTrace,
	type TaskTraceRepository,
	type UserRole,
} from "@isolate/db";
import {
	hashConnectorDeviceToken,
	isConnectorDeviceToken,
} from "@isolate/integrations";
import type { OrganizationId } from "@isolate/shared";
import {
	type ConnectorConnectService,
	createConnectorConnectService,
	handleConnectorConnectRoute,
	handleConnectorListRoute,
	handleConnectorRevokeRoute,
} from "./connector-connect.server";
import {
	createDeviceGateway,
	type DeviceGateway,
} from "./device-gateway.server";
import {
	createDeviceRegistrationRoutes,
	type DeviceRegistrationRoutes,
} from "./device-registration.server";
import {
	acceptIncident,
	createInMemoryIncidentDedupeStore,
	type IncidentIntakeDependencies,
	type IncidentRepositoryRoute,
	incidentFailureResponse,
} from "./incident-intake.server";
import { localDemo } from "./local-mode.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";
import { harness, otherScope } from "./test-fixtures";
import {
	createTraceReadRoutes,
	type TraceReadRoutes,
} from "./trace-read.server";
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
} from "./webhook-signature.server";

/**
 * Offline end-to-end route/service flow (W19).
 *
 * One ordered scenario drives every device, connector, trace and webhook
 * surface through its real route adapter or service over in-memory
 * repositories: register → list → connect → list/revoke → claim/result/
 * heartbeat → trace read → signed webhook intake → rotate → revoke. Focused
 * tests then pin the auth and request-guard negatives.
 *
 * No database, no network, no provider: nothing here can mint a provider key,
 * and every response body is scanned for token, hash and secret material.
 */

const ORG_A = localDemo.organizationId;
const USER_A = localDemo.userId;
const ORG_B = otherScope.organizationId;
const NONEXISTENT_DEVICE_ID = "77777777-7777-4777-8777-777777777777";
const FOREIGN_TOKEN = "Z".repeat(43);
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const TRACE_ID = "a".repeat(32);
const CALL_TASK_ID = "99999999-9999-4999-8999-999999999999";
const WEBHOOK_SECRET = "fabricated-webhook-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1000);
const PRIMARY_REF = "keychain:isolate/sentry/team-a";
const SECONDARY_REF = "keychain:isolate/grafana/team-a";
const PROVIDER_KEY_MARKERS = [
	"BASETEN_API_KEY",
	"MODAL_TOKEN_ID",
	"MODAL_TOKEN_SECRET",
] as const;
const TOKEN_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A distinct, canonical 43-char base64url token per call. */
function tokenSequence(): () => string {
	let index = 0;
	return () => {
		const suffix = TOKEN_ALPHABET[index % TOKEN_ALPHABET.length];
		index += 1;
		return `${"A".repeat(42)}${suffix}`;
	};
}

class RecordingDeviceRepository extends InMemoryConnectorDeviceRepository {
	readonly created: CreateConnectorDeviceInput[] = [];

	override async create(input: CreateConnectorDeviceInput) {
		this.created.push(input);
		return super.create(input);
	}
}

class SeededTraceRepository
	implements Pick<TaskTraceRepository, "getTaskTrace">
{
	readonly calls: GetTaskTraceInput[] = [];

	constructor(private readonly rows: ReadonlyMap<string, TaskTrace>) {}

	async getTaskTrace(input: GetTaskTraceInput): Promise<TaskTrace | null> {
		this.calls.push(input);
		return this.rows.get(`${input.organizationId}:${input.taskId}`) ?? null;
	}
}

function fixtureTrace(): TaskTrace {
	return {
		taskId: TASK_ID,
		traceId: TRACE_ID,
		events: [
			{
				type: "task.claimed",
				actor: "worker",
				data: { turn: 1 },
				createdAt: "2026-11-01T10:00:00.000Z",
			},
		],
		toolInvocations: [
			{
				toolName: "connector.sentry.issue_context",
				decision: "allowed",
				denialReason: null,
				argumentsHash: "b".repeat(64),
				durationMs: 4,
				createdAt: "2026-11-01T10:00:01.000Z",
			},
		],
		usage: [
			{
				provider: "baseten",
				modelId: "model-a",
				promptTokens: 3,
				completionTokens: 2,
				costUsd: "0.000100",
				createdAt: "2026-11-01T10:00:02.000Z",
			},
		],
		connectorCalls: [
			{
				toolName: "connector.sentry.issue_context",
				connectorId: "sentry",
				status: "completed",
				errorCode: null,
				attempts: 1,
				traceparent: `00-${"a".repeat(32)}-${"c".repeat(16)}-01`,
				createdAt: "2026-11-01T10:00:03.000Z",
				claimedAt: "2026-11-01T10:00:04.000Z",
				completedAt: "2026-11-01T10:00:05.000Z",
				expiresAt: "2026-11-01T10:01:00.000Z",
			},
		],
	};
}

type E2E = {
	devices: RecordingDeviceRepository;
	credentials: InMemoryConnectorCredentialRepository;
	calls: InMemoryConnectorCallRepository;
	usage: InMemoryConnectorUsageLedger;
	registration: DeviceRegistrationRoutes;
	connector: ConnectorConnectService;
	gateway: DeviceGateway;
	traces: SeededTraceRepository;
	traceRoutes: TraceReadRoutes;
};

/**
 * Builds the shared in-memory stack once. Device and connector services resolve
 * the caller from a fixed scope, exactly like the trusted session adapter; the
 * gateway resolves a token hash through the same device repository the
 * registration route writes to.
 */
function createE2E(role: UserRole = "owner"): E2E {
	const devices = new RecordingDeviceRepository();
	const credentials = new InMemoryConnectorCredentialRepository();
	const calls = new InMemoryConnectorCallRepository();
	const usage = new InMemoryConnectorUsageLedger(credentials);
	const tokenOwners = new Map<string, OrganizationId>();
	const nextToken = tokenSequence();
	const generateToken = () => {
		const token = nextToken();
		tokenOwners.set(hashConnectorDeviceToken(token), ORG_A);
		return token;
	};
	const scopeFor = (callerRole: UserRole): CallerScope => ({
		organizationId: ORG_A,
		userId: USER_A,
		role: callerRole,
	});
	const traces = new SeededTraceRepository(
		new Map([[`${ORG_A}:${TASK_ID}`, fixtureTrace()]]),
	);
	return {
		devices,
		credentials,
		calls,
		usage,
		registration: createDeviceRegistrationRoutes({
			resolveScope: async () => scopeFor(role),
			devices,
			generateToken,
		}),
		connector: createConnectorConnectService({
			devices,
			credentials,
			resolveScope: async () => scopeFor(role),
		}),
		gateway: createDeviceGateway({
			devices,
			credentials,
			calls,
			usage,
			freeDailyLimit: 1,
			lookupTokenHash: async (tokenHash) => {
				const organizationId = tokenOwners.get(tokenHash);
				return organizationId === undefined ? null : { organizationId };
			},
			rateLimits: new InMemoryRateLimitRepository(),
		}),
		traces,
		traceRoutes: createTraceReadRoutes({
			resolveScope: async () => scopeFor(role),
			traces,
		}),
	};
}

function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function get(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`http://localhost${path}`, { method: "GET", headers });
}

function claimRequest(token: string): Request {
	return new Request("http://localhost/api/device/claim", {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	});
}

function resultRequest(callId: string, body: unknown, token: string): Request {
	return new Request(`http://localhost/api/device/calls/${callId}/result`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function heartbeatRequest(token: string): Request {
	return new Request("http://localhost/api/device/heartbeat", {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	});
}

async function readJson(
	response: Response,
	sink?: string[],
): Promise<Record<string, unknown>> {
	expect(response.headers.get("cache-control")).toBe("no-store");
	const text = await response.text();
	if (sink !== undefined) sink.push(text);
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== "string") throw new Error(`expected ${key}`);
	return value;
}

function connectBody(
	deviceId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		deviceId,
		connectorId: "sentry",
		displayName: "Team Sentry",
		authKind: "api_key",
		credentialRef: PRIMARY_REF,
		...overrides,
	};
}

function incidentSignal(): Record<string, unknown> {
	return {
		source: "github",
		kind: "workflow_failed",
		severity: "high",
		service: "checkout-api",
		fingerprint: "repo:owner/checkout:run:42",
		title: "CI failed on main",
		summary: "The integration job failed after the deploy step.",
		links: [
			{
				label: "Failed run",
				url: "https://github.com/owner/checkout/actions/runs/42",
			},
		],
		receivedAt: "2026-10-30T12:00:00.000Z",
	};
}

function signedDelivery(
	payload: unknown,
	signatureOverride?: string,
): { rawBody: string; headers: Headers; now: number } {
	const rawBody = JSON.stringify(payload);
	const timestamp = String(NOW_SECONDS);
	const signature =
		signatureOverride ??
		`sha256=${createHmac("sha256", WEBHOOK_SECRET)
			.update(`${timestamp}.`)
			.update(rawBody)
			.digest("hex")}`;
	const headers = new Headers();
	headers.set(WEBHOOK_TIMESTAMP_HEADER, timestamp);
	headers.set(WEBHOOK_SIGNATURE_HEADER, signature);
	return { rawBody, headers, now: NOW };
}

const REPOSITORY_ROUTE: IncidentRepositoryRoute = {
	organizationId: ORG_A,
	repositoryId: localDemo.repositoryId,
	branch: "isolate/incident",
	workflowDefinitionId: localDemo.workflowDefinitionId,
	workflowVersion: localDemo.workflowVersion,
	fileOwnership: [],
};

function webhookDependencies(
	tasks: ReturnType<typeof harness>,
): IncidentIntakeDependencies {
	return {
		signingSecret: WEBHOOK_SECRET,
		binding: { organizationId: ORG_A, userId: USER_A, role: "member" },
		resolveRepository: async () => REPOSITORY_ROUTE,
		dedupe: createInMemoryIncidentDedupeStore(),
		submitTask: (input) => tasks.service.submit(input),
		now: () => new Date(NOW),
	};
}

describe("connector platform end-to-end flow", () => {
	test("device → connector → claim → trace → webhook → rotate → revoke", async () => {
		const spies = [
			spyOn(console, "log"),
			spyOn(console, "warn"),
			spyOn(console, "error"),
		];
		const publicBodies: string[] = [];
		try {
			const e2e = createE2E();
			const tasks = harness();

			// 1. Device registration: token returned once, only the hash stored.
			const register = await e2e.registration.register(
				post("/api/device/register", { displayName: "Laptop A" }),
			);
			expect(register.status).toBe(200);
			expect(register.headers.get("pragma")).toBe("no-cache");
			const registered = await readJson(register);
			expect(Object.keys(registered).sort()).toEqual([
				"deviceId",
				"expiresAt",
				"token",
			]);
			const deviceId = stringField(registered, "deviceId");
			const deviceToken = stringField(registered, "token");
			expect(isConnectorDeviceToken(deviceToken)).toBe(true);
			expect(Date.parse(stringField(registered, "expiresAt"))).toBeGreaterThan(
				Date.now(),
			);
			expect(e2e.devices.created).toHaveLength(1);
			const storedDevice = e2e.devices.created[0];
			if (storedDevice === undefined) throw new Error("no stored device");
			expect(storedDevice.tokenHash).toBe(
				hashConnectorDeviceToken(deviceToken),
			);
			expect(storedDevice.tokenHash).not.toBe(deviceToken);
			expect(JSON.stringify(storedDevice)).not.toContain(deviceToken);

			// 2. Device list: the device appears, with no hash or token.
			const listedDevices = await readJson(
				await e2e.registration.list(get("/api/device/list")),
				publicBodies,
			);
			const deviceRows = listedDevices.devices as Record<string, unknown>[];
			expect(deviceRows).toHaveLength(1);
			expect(deviceRows[0]?.id).toBe(deviceId);
			expect(Object.keys(deviceRows[0] ?? {}).sort()).toEqual([
				"displayName",
				"id",
				"lastSeenAt",
				"status",
			]);

			// 3. Connector connect: metadata only, secret-shaped refs refused,
			// foreign devices are indistinguishable from missing ones.
			const connected = await handleConnectorConnectRoute(
				post("/api/connectors/connect", connectBody(deviceId)),
				{ service: e2e.connector },
			);
			expect(connected.status).toBe(200);
			const primaryCredentialId = stringField(
				await readJson(connected, publicBodies),
				"credentialId",
			);

			const secretRef = `ghp_${"A".repeat(36)}`;
			const secretShaped = await handleConnectorConnectRoute(
				post(
					"/api/connectors/connect",
					connectBody(deviceId, {
						displayName: "Pasted secret",
						credentialRef: secretRef,
					}),
				),
				{ service: e2e.connector },
			);
			expect(secretShaped.status).toBe(400);
			await readJson(secretShaped, publicBodies);
			expect(e2e.credentials.rowCount).toBe(1);

			const foreignDevice = await e2e.devices.create({
				organizationId: ORG_B,
				displayName: "Foreign laptop",
				tokenHash: hashConnectorDeviceToken(FOREIGN_TOKEN),
				status: "active",
			});
			const foreignConnect = await handleConnectorConnectRoute(
				post(
					"/api/connectors/connect",
					connectBody(foreignDevice.id, { displayName: "Foreign sentry" }),
				),
				{ service: e2e.connector },
			);
			expect(foreignConnect.status).toBe(404);
			await readJson(foreignConnect, publicBodies);

			// 4. Connector list and idempotent revoke: metadata only.
			const secondary = await handleConnectorConnectRoute(
				post(
					"/api/connectors/connect",
					connectBody(deviceId, {
						connectorId: "grafana",
						displayName: "Team Grafana",
						credentialRef: SECONDARY_REF,
					}),
				),
				{ service: e2e.connector },
			);
			expect(secondary.status).toBe(200);
			const secondaryCredentialId = stringField(
				await readJson(secondary, publicBodies),
				"credentialId",
			);

			const connectorList = await readJson(
				await handleConnectorListRoute(get("/api/connectors/list"), {
					service: e2e.connector,
				}),
				publicBodies,
			);
			const connectorRows = connectorList.credentials as Record<
				string,
				unknown
			>[];
			expect(connectorRows).toHaveLength(2);
			for (const row of connectorRows) {
				expect(row).not.toHaveProperty("token");
				expect(row).not.toHaveProperty("secret");
				expect(row).not.toHaveProperty("apiKey");
			}
			const revokeFirst = await handleConnectorRevokeRoute(
				post("/api/connectors/revoke", {
					credentialId: secondaryCredentialId,
				}),
				{ service: e2e.connector },
			);
			const revokeReplay = await handleConnectorRevokeRoute(
				post("/api/connectors/revoke", {
					credentialId: secondaryCredentialId,
				}),
				{ service: e2e.connector },
			);
			expect(revokeFirst.status).toBe(200);
			expect(revokeReplay.status).toBe(200);
			expect(await readJson(revokeReplay, publicBodies)).toEqual({
				credentialId: secondaryCredentialId,
				status: "revoked",
			});

			// 5. Device claim: active credential, free-tier counter, result,
			// heartbeat. Activation is the device-side validation outcome.
			const activated = await e2e.credentials.setStatus(
				ORG_A,
				primaryCredentialId,
				"active",
			);
			expect(activated?.status).toBe("active");
			const call = await e2e.calls.enqueue({
				organizationId: ORG_A,
				deviceId,
				credentialId: primaryCredentialId,
				taskId: CALL_TASK_ID,
				connectorId: "sentry",
				toolName: "sentry.issue_context",
				params: { issueId: "SENTRY-1" },
				ttlMs: 60_000,
			});
			const claimed = await readJson(
				await e2e.gateway.handleClaim(claimRequest(deviceToken)),
				publicBodies,
			);
			const claimedCall = claimed.call as Record<string, unknown>;
			expect(claimedCall.id).toBe(call.id);
			expect(claimedCall.connectorId).toBe("sentry");
			expect(claimedCall.credentialRef).toBe(PRIMARY_REF);
			expect(claimedCall.toolName).toBe("sentry.issue_context");
			expect(claimedCall.params).toEqual({ issueId: "SENTRY-1" });
			expect(claimedCall).not.toHaveProperty("credentialId");
			expect(claimedCall).not.toHaveProperty("token");
			expect(claimedCall).not.toHaveProperty("secret");
			const period = new Date().toISOString().slice(0, 10);
			expect(
				(await e2e.usage.get(primaryCredentialId, period))?.requestCount,
			).toBe(1);

			const result = await e2e.gateway.handleResult(
				resultRequest(
					call.id,
					{ ok: true, data: { issue: "SENTRY-1" } },
					deviceToken,
				),
			);
			expect(result.status).toBe(200);
			expect(await readJson(result, publicBodies)).toEqual({ ok: true });
			expect(e2e.calls.peek(call.id)?.status).toBe("completed");

			const heartbeat = await e2e.gateway.handleHeartbeat(
				heartbeatRequest(deviceToken),
			);
			expect(heartbeat.status).toBe(200);
			expect(await readJson(heartbeat, publicBodies)).toEqual({ ok: true });

			// The platform budget is server-side: the second call is failed, not
			// handed to the device, and no usage unit is overspent.
			const overspend = await e2e.calls.enqueue({
				organizationId: ORG_A,
				deviceId,
				credentialId: primaryCredentialId,
				taskId: CALL_TASK_ID,
				connectorId: "sentry",
				toolName: "sentry.issue_context",
				params: { issueId: "SENTRY-2" },
				ttlMs: 60_000,
			});
			const exhausted = await readJson(
				await e2e.gateway.handleClaim(claimRequest(deviceToken)),
				publicBodies,
			);
			expect(exhausted.call).toBeNull();
			expect(e2e.calls.peek(overspend.id)?.status).toBe("failed");
			expect(e2e.calls.peek(overspend.id)?.errorCode).toBe("RATE_LIMITED");

			// 6. Trace read: seeded timeline, no-store, tenant and capability gates.
			const trace = await e2e.traceRoutes.get(get(`/api/traces/${TASK_ID}`));
			expect(trace.status).toBe(200);
			const traceBody = await readJson(trace, publicBodies);
			expect(traceBody.taskId).toBe(TASK_ID);
			expect(traceBody.traceId).toBe(TRACE_ID);
			expect((traceBody.events as unknown[]).length).toBe(1);
			expect(traceBody).not.toHaveProperty("params");
			expect(traceBody).not.toHaveProperty("result");

			const foreignTraceRoutes = createTraceReadRoutes({
				resolveScope: async () => otherScope,
				traces: e2e.traces,
			});
			const foreignTrace = await foreignTraceRoutes.get(
				get(`/api/traces/${TASK_ID}`),
			);
			expect(foreignTrace.status).toBe(404);
			await readJson(foreignTrace, publicBodies);

			const noCapabilityRoutes = createTraceReadRoutes({
				resolveScope: async () => ({
					organizationId: ORG_A,
					userId: USER_A,
					role: "intruder" as UserRole,
				}),
				traces: e2e.traces,
			});
			const deniedTrace = await noCapabilityRoutes.get(
				get(`/api/traces/${TASK_ID}`),
			);
			expect(deniedTrace.status).toBe(403);
			await readJson(deniedTrace, publicBodies);
			// Capability is checked before storage: the denied caller read no row.
			expect(e2e.traces.calls).toHaveLength(2);

			// 7. Signed webhook intake: one task and one job, replay deduped,
			// malformed signature rejected with no task.
			const intake = webhookDependencies(tasks);
			const accepted = await acceptIncident(
				intake,
				signedDelivery(incidentSignal()),
			);
			expect(accepted.ok).toBe(true);
			if (!accepted.ok || !("taskId" in accepted)) {
				throw new Error("expected a created task");
			}
			expect(accepted.deduped).toBe(false);
			expect(tasks.tasks.calls).toHaveLength(1);
			expect(tasks.queue.calls).toHaveLength(1);
			expect(tasks.tasks.calls[0]?.organizationId).toBe(ORG_A);
			expect(tasks.tasks.calls[0]?.incidentSource).toBeUndefined();
			const queued = tasks.queue.calls[0]?.payload as
				| { taskId?: string }
				| undefined;
			expect(queued?.taskId).toBe(accepted.taskId);

			const replay = await acceptIncident(
				intake,
				signedDelivery(incidentSignal()),
			);
			expect(replay).toEqual({
				ok: true,
				taskId: accepted.taskId,
				jobId: accepted.jobId,
				deduped: true,
			});
			expect(tasks.tasks.calls).toHaveLength(1);
			expect(tasks.queue.calls).toHaveLength(1);

			const malformed = await acceptIncident(
				intake,
				signedDelivery(incidentSignal(), `sha256=${"0".repeat(64)}`),
			);
			expect(malformed).toEqual({ ok: false, code: "UNAUTHORIZED" });
			const rejected = incidentFailureResponse(
				malformed.ok ? "UNAVAILABLE" : malformed.code,
			);
			expect(rejected.status).toBe(401);
			await readJson(rejected, publicBodies);
			expect(tasks.tasks.calls).toHaveLength(1);
			expect(tasks.queue.calls).toHaveLength(1);

			// 8. Rotation: a fresh token, the old one dead on the next claim.
			const rotated = await readJson(
				await e2e.registration.rotate(post("/api/device/rotate", { deviceId })),
			);
			expect(rotated.deviceId).toBe(deviceId);
			const rotatedToken = stringField(rotated, "token");
			expect(rotatedToken).not.toBe(deviceToken);
			expect(isConnectorDeviceToken(rotatedToken)).toBe(true);
			expect(
				(await e2e.gateway.handleClaim(claimRequest(deviceToken))).status,
			).toBe(401);
			const newClaim = await e2e.gateway.handleClaim(
				claimRequest(rotatedToken),
			);
			expect(newClaim.status).toBe(200);
			expect(await readJson(newClaim, publicBodies)).toEqual({ call: null });

			// 9. Device revoke: the new token dies, connector metadata survives and
			// remains tenant-scoped.
			const revoked = await readJson(
				await e2e.registration.revoke(post("/api/device/revoke", { deviceId })),
				publicBodies,
			);
			expect(revoked).toEqual({ deviceId, status: "revoked" });
			expect(
				(await e2e.gateway.handleClaim(claimRequest(rotatedToken))).status,
			).toBe(401);

			const ownConnectors = await readJson(
				await handleConnectorListRoute(get("/api/connectors/list"), {
					service: e2e.connector,
				}),
				publicBodies,
			);
			expect((ownConnectors.credentials as unknown[]).length).toBe(2);
			const foreignService = createConnectorConnectService({
				devices: e2e.devices,
				credentials: e2e.credentials,
				resolveScope: async () => otherScope,
			});
			const foreignConnectors = await readJson(
				await handleConnectorListRoute(get("/api/connectors/list"), {
					service: foreignService,
				}),
				publicBodies,
			);
			expect(foreignConnectors.credentials).toEqual([]);

			// Nothing sensitive reached a response body or a log line, and no
			// provider-key material exists anywhere in the flow.
			const sensitive = [
				deviceToken,
				rotatedToken,
				hashConnectorDeviceToken(deviceToken),
				hashConnectorDeviceToken(rotatedToken),
				FOREIGN_TOKEN,
				hashConnectorDeviceToken(FOREIGN_TOKEN),
				WEBHOOK_SECRET,
				secretRef,
			];
			for (const text of publicBodies) {
				for (const value of [...sensitive, ...PROVIDER_KEY_MARKERS]) {
					expect(text).not.toContain(value);
				}
			}
			for (const spy of spies) {
				for (const call of spy.mock.calls) {
					const serialized = JSON.stringify(call);
					for (const value of [...sensitive, ...PROVIDER_KEY_MARKERS]) {
						expect(serialized).not.toContain(value);
					}
				}
			}
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("route auth and request-guard negatives", () => {
	test("unauthenticated callers get 401 and viewers 403 on manage routes", async () => {
		const e2e = createE2E();
		const unauthenticated = {
			resolveScope: async (): Promise<CallerScope> => {
				throw new ControlPlaneError("AUTH_REQUIRED");
			},
		};
		const anonymousDeviceRoutes = createDeviceRegistrationRoutes({
			...unauthenticated,
			devices: e2e.devices,
			generateToken: () => "Q".repeat(43),
		});
		const register = await anonymousDeviceRoutes.register(
			post("/api/device/register", { displayName: "Laptop A" }),
		);
		expect(register.status).toBe(401);
		expect(await readJson(register)).toEqual({
			error: "authentication required",
		});

		const anonymousConnector = createConnectorConnectService({
			...unauthenticated,
			devices: e2e.devices,
			credentials: e2e.credentials,
		});
		const connect = await handleConnectorConnectRoute(
			post("/api/connectors/connect", connectBody(NONEXISTENT_DEVICE_ID)),
			{ service: anonymousConnector },
		);
		expect(connect.status).toBe(401);
		await readJson(connect);

		const anonymousTraces = createTraceReadRoutes({
			...unauthenticated,
			traces: e2e.traces,
		});
		const trace = await anonymousTraces.get(get(`/api/traces/${TASK_ID}`));
		expect(trace.status).toBe(401);
		await readJson(trace);

		const viewer = createE2E("viewer");
		const viewerConnect = await handleConnectorConnectRoute(
			post("/api/connectors/connect", connectBody(NONEXISTENT_DEVICE_ID)),
			{ service: viewer.connector },
		);
		expect(viewerConnect.status).toBe(403);
		await readJson(viewerConnect);
		const viewerRotate = await viewer.registration.rotate(
			post("/api/device/rotate", { deviceId: NONEXISTENT_DEVICE_ID }),
		);
		expect(viewerRotate.status).toBe(403);
		expect(await readJson(viewerRotate)).toEqual({ error: "forbidden" });
	});

	test("cross-origin requests are 403 and non-JSON bodies are 415", async () => {
		const e2e = createE2E();
		const crossOrigin = { origin: "https://evil.example" };
		const register = await e2e.registration.register(
			post("/api/device/register", { displayName: "Laptop A" }, crossOrigin),
		);
		expect(register.status).toBe(403);
		expect(await readJson(register)).toEqual({ error: "request rejected" });

		const connect = await handleConnectorConnectRoute(
			post(
				"/api/connectors/connect",
				connectBody(NONEXISTENT_DEVICE_ID),
				crossOrigin,
			),
			{ service: e2e.connector },
		);
		expect(connect.status).toBe(403);
		await readJson(connect);

		const trace = await e2e.traceRoutes.get(
			get(`/api/traces/${TASK_ID}`, crossOrigin),
		);
		expect(trace.status).toBe(403);
		await readJson(trace);

		const notJson = new Request("http://localhost/api/device/register", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ displayName: "Laptop A" }),
		});
		const registerNotJson = await e2e.registration.register(notJson);
		expect(registerNotJson.status).toBe(415);
		await readJson(registerNotJson);
		const connectNotJson = await handleConnectorConnectRoute(
			new Request("http://localhost/api/connectors/connect", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: JSON.stringify(connectBody(NONEXISTENT_DEVICE_ID)),
			}),
			{ service: e2e.connector },
		);
		expect(connectNotJson.status).toBe(415);
		await readJson(connectNotJson);
		expect(e2e.devices.rowCount).toBe(0);
	});

	test("wrong methods are a fixed 405 on routes that enforce the method", async () => {
		const e2e = createE2E();
		for (const path of [
			"/api/device/register",
			"/api/device/rotate",
			"/api/device/revoke",
		]) {
			const response =
				path === "/api/device/register"
					? await e2e.registration.register(get(path))
					: path === "/api/device/rotate"
						? await e2e.registration.rotate(get(path))
						: await e2e.registration.revoke(get(path));
			expect(response.status).toBe(405);
			expect(await readJson(response)).toEqual({ error: "method not allowed" });
		}
		const tracePost = await e2e.traceRoutes.get(
			new Request(`http://localhost/api/traces/${TASK_ID}`, {
				method: "POST",
			}),
		);
		expect(tracePost.status).toBe(405);
		expect(await readJson(tracePost)).toEqual({ error: "method not allowed" });
	});
});
