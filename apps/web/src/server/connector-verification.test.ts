import { describe, expect, test } from "bun:test";
import {
	type ConnectorCallOutcome,
	type ConnectorCallRepository,
	type ConnectorCallScope,
	type EnqueueConnectorCallInput,
	InMemoryConnectorCredentialRepository,
	type UserRole,
} from "@isolate/db";
import {
	asOrganizationId,
	asUserId,
	CONNECTOR_VERIFY_TOOL_NAME,
	type OrganizationId,
} from "@isolate/shared";
import {
	CONNECTOR_VERIFICATION_FAILURE_MESSAGES,
	CONNECTOR_VERIFY_AWAIT_POLL_MS,
	CONNECTOR_VERIFY_AWAIT_TIMEOUT_MS,
	CONNECTOR_VERIFY_CALL_TTL_MS,
	ConnectorVerificationNotConfiguredError,
	type ConnectorVerificationResult,
	type ConnectorVerificationService,
	type ConnectorVerificationView,
	createConnectorVerificationService,
	getConnectorVerificationService,
	isConnectorVerificationEnabled,
	resetConnectorVerificationForTests,
	verifyConnectorCredential,
} from "./connector-verification.server";
import {
	RateLimitExceededError,
	type UserRateLimitGate,
} from "./rate-limit.server";
import { type CallerScope, ControlPlaneError } from "./task-service.server";

const ORG_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORG_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const USER_ID = asUserId("33333333-3333-4333-8333-333333333333");
const NOW = new Date("2026-11-02T12:00:00.000Z");
const UNKNOWN_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777";

type EnqueuedCall = EnqueueConnectorCallInput & { id: string };

/**
 * Narrow call repository: the service only enqueues and awaits, so the fake
 * records exactly those two calls and returns a fixed device outcome. No live
 * queue, database or clock wait is involved.
 */
class FakeCallRepository
	implements Pick<ConnectorCallRepository, "enqueue" | "awaitResult">
{
	readonly enqueued: EnqueuedCall[] = [];
	readonly awaits: Array<{
		callId: string;
		timeoutMs: number;
		pollMs: number;
		scope?: ConnectorCallScope;
	}> = [];
	outcome: ConnectorCallOutcome | null = null;
	enqueueError: Error | null = null;
	/** Test seam: run between the awaited answer and the caller's write. */
	beforeOutcome: (() => Promise<void>) | undefined;

	async enqueue(input: EnqueueConnectorCallInput) {
		if (this.enqueueError !== null) throw this.enqueueError;
		const id = crypto.randomUUID();
		this.enqueued.push({ ...input, id });
		return {
			id,
			organizationId: input.organizationId,
			deviceId: input.deviceId,
			credentialId: input.credentialId,
			taskId: input.taskId ?? null,
			connectorId: input.connectorId,
			toolName: input.toolName,
			params: input.params,
			traceparent: input.traceparent ?? null,
			status: "queued" as const,
			result: null,
			errorCode: null,
			attempts: 0,
			claimedAt: null,
			completedAt: null,
			expiresAt: new Date(
				NOW.getTime() + (input.ttlMs ?? CONNECTOR_VERIFY_CALL_TTL_MS),
			),
			createdAt: NOW,
		};
	}

	async awaitResult(
		callId: string,
		timeoutMs: number,
		pollMs: number,
		scope?: ConnectorCallScope,
	): Promise<ConnectorCallOutcome | null> {
		this.awaits.push({ callId, timeoutMs, pollMs, scope });
		if (this.beforeOutcome !== undefined) await this.beforeOutcome();
		return this.outcome;
	}
}

class FakeRateLimitGate implements UserRateLimitGate {
	readonly calls: Array<{ userId: string; action: string }> = [];
	constructor(private readonly denied = false) {}

	async enforce(userId: string, action: string): Promise<void> {
		this.calls.push({ userId, action });
		if (this.denied) throw new RateLimitExceededError(17);
	}
}

type HarnessOptions = {
	role?: UserRole;
	scopeError?: "AUTH_REQUIRED" | "FORBIDDEN";
	outcome?: ConnectorCallOutcome | null;
	rateLimiter?: UserRateLimitGate;
	awaitTimeoutMs?: number;
	pollMs?: number;
};

type Harness = {
	service: ConnectorVerificationService;
	credentials: InMemoryConnectorCredentialRepository;
	calls: FakeCallRepository;
	writes: { setStatus: number; touchValidated: number };
	deviceAId: string;
	deviceBId: string;
	pendingAId: string;
	activeAId: string;
	revokedAId: string;
	foreignBId: string;
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const credentials = new InMemoryConnectorCredentialRepository();
	const calls = new FakeCallRepository();
	calls.outcome = options.outcome ?? null;
	const writes = { setStatus: 0, touchValidated: 0 };

	const deviceAId = crypto.randomUUID();
	const deviceBId = crypto.randomUUID();
	const pendingA = await credentials.create({
		organizationId: ORG_A,
		deviceId: deviceAId,
		connectorId: "sentry",
		displayName: "Sentry production",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/prod",
		status: "pending_validation",
	});
	const activeA = await credentials.create({
		organizationId: ORG_A,
		deviceId: deviceAId,
		connectorId: "grafana",
		displayName: "Grafana production",
		authKind: "api_key",
		credentialRef: "keychain:isolate/grafana/prod",
		status: "active",
	});
	const revokedA = await credentials.create({
		organizationId: ORG_A,
		deviceId: deviceAId,
		connectorId: "datadog",
		displayName: "Datadog retired",
		authKind: "api_key",
		credentialRef: "keychain:isolate/datadog/retired",
		status: "revoked",
	});
	const foreignB = await credentials.create({
		organizationId: ORG_B,
		deviceId: deviceBId,
		connectorId: "sentry",
		displayName: "Sentry other tenant",
		authKind: "api_key",
		credentialRef: "keychain:isolate/sentry/other",
		status: "pending_validation",
	});

	const scope: CallerScope = {
		organizationId: ORG_A,
		userId: USER_ID,
		role: options.role ?? "owner",
	};
	const service = createConnectorVerificationService({
		credentials: {
			get: (organizationId: OrganizationId, credentialId: string) =>
				credentials.get(organizationId, credentialId),
			setStatus: async (
				organizationId: OrganizationId,
				credentialId: string,
				status,
			) => {
				writes.setStatus += 1;
				return credentials.setStatus(organizationId, credentialId, status);
			},
			touchValidated: async (
				organizationId: OrganizationId,
				credentialId: string,
				validatedAt?: Date,
			) => {
				writes.touchValidated += 1;
				return credentials.touchValidated(
					organizationId,
					credentialId,
					validatedAt,
				);
			},
		},
		calls,
		resolveScope: async () => {
			if (options.scopeError !== undefined) {
				throw new ControlPlaneError(options.scopeError);
			}
			return scope;
		},
		now: () => new Date(NOW.getTime()),
		awaitTimeoutMs: options.awaitTimeoutMs,
		pollMs: options.pollMs,
		...(options.rateLimiter === undefined
			? {}
			: { rateLimiter: options.rateLimiter }),
	});
	return {
		service,
		credentials,
		calls,
		writes,
		deviceAId,
		deviceBId,
		pendingAId: pendingA.id,
		activeAId: activeA.id,
		revokedAId: revokedA.id,
		foreignBId: foreignB.id,
	};
}

function successValue(
	result: ConnectorVerificationResult,
): ConnectorVerificationView {
	if (!result.ok) {
		throw new Error(`expected success, received ${result.error.code}`);
	}
	return result.value;
}

function failureError(result: ConnectorVerificationResult) {
	if (result.ok) throw new Error("expected a failure result");
	return result.error;
}

describe("connector credential verification", () => {
	test("a verified read promotes a pending credential and touches validation", async () => {
		const harness = await createHarness({
			outcome: { ok: true, data: { verified: true, reasonCode: "OK" } },
		});
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(result).toEqual({
			ok: true,
			value: {
				credentialId: harness.pendingAId,
				status: "active",
				reasonCode: "OK",
				verifiedAt: NOW.toISOString(),
			},
		});

		expect(harness.calls.enqueued).toHaveLength(1);
		const call = harness.calls.enqueued[0];
		expect(call).toMatchObject({
			organizationId: ORG_A,
			deviceId: harness.deviceAId,
			credentialId: harness.pendingAId,
			connectorId: "sentry",
			toolName: CONNECTOR_VERIFY_TOOL_NAME,
			params: {},
			ttlMs: CONNECTOR_VERIFY_CALL_TTL_MS,
		});
		expect(harness.calls.awaits).toEqual([
			{
				callId: call?.id,
				timeoutMs: CONNECTOR_VERIFY_AWAIT_TIMEOUT_MS,
				pollMs: CONNECTOR_VERIFY_AWAIT_POLL_MS,
				scope: { organizationId: ORG_A, deviceId: harness.deviceAId },
			},
		]);
		const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
		expect(stored?.status).toBe("active");
		expect(stored?.lastValidatedAt?.toISOString()).toBe(NOW.toISOString());
		expect(harness.writes).toEqual({ setStatus: 1, touchValidated: 1 });
	});

	test("a rejected read marks the credential invalid and never claims validation", async () => {
		const harness = await createHarness({
			outcome: {
				ok: true,
				data: { verified: false, reasonCode: "AUTH_FAILED" },
			},
		});
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(successValue(result)).toEqual({
			credentialId: harness.pendingAId,
			status: "invalid",
			reasonCode: "AUTH_FAILED",
			verifiedAt: null,
		});
		const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
		expect(stored?.status).toBe("invalid");
		expect(stored?.lastValidatedAt).toBeNull();
		expect(harness.writes).toEqual({ setStatus: 1, touchValidated: 0 });
	});

	test("a relay timeout leaves the status untouched and reports UNREACHABLE", async () => {
		const harness = await createHarness({ outcome: null });
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(successValue(result)).toEqual({
			credentialId: harness.pendingAId,
			status: "pending_validation",
			reasonCode: "UNREACHABLE",
			verifiedAt: null,
		});
		const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
		expect(stored?.status).toBe("pending_validation");
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
	});

	test("a timeout keeps an active credential and its last validation time", async () => {
		const harness = await createHarness({ outcome: null });
		const previous = new Date("2026-10-01T00:00:00.000Z");
		await harness.credentials.touchValidated(
			ORG_A,
			harness.activeAId,
			previous,
		);
		const result = await harness.service.verify({
			credentialId: harness.activeAId,
		});
		expect(successValue(result)).toEqual({
			credentialId: harness.activeAId,
			status: "active",
			reasonCode: "UNREACHABLE",
			verifiedAt: previous.toISOString(),
		});
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
	});

	test("a credential revoked while the relay answers is not resurrected", async () => {
		const harness = await createHarness({
			outcome: { ok: true, data: { verified: true, reasonCode: "OK" } },
		});
		harness.calls.beforeOutcome = async () => {
			await harness.credentials.revoke(ORG_A, harness.pendingAId);
		};
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(failureError(result).code).toBe("NOT_FOUND");
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
		const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
		expect(stored?.status).toBe("revoked");
		expect(stored?.lastValidatedAt).toBeNull();
	});

	test("a foreign tenant credential is NOT_FOUND and enqueues nothing", async () => {
		const harness = await createHarness();
		const result = await harness.service.verify({
			credentialId: harness.foreignBId,
		});
		expect(failureError(result)).toEqual({
			code: "NOT_FOUND",
			message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES.NOT_FOUND,
		});
		expect(harness.calls.enqueued).toHaveLength(0);
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
	});

	test("viewers and members cannot verify", async () => {
		for (const role of ["viewer", "member"] as const) {
			const harness = await createHarness({ role });
			const result = await harness.service.verify({
				credentialId: harness.pendingAId,
			});
			expect(failureError(result).code).toBe("FORBIDDEN");
			expect(harness.calls.enqueued).toHaveLength(0);
		}
	});

	test("a missing or foreign session fails closed", async () => {
		for (const scopeError of ["AUTH_REQUIRED", "FORBIDDEN"] as const) {
			const harness = await createHarness({ scopeError });
			const result = await harness.service.verify({
				credentialId: harness.pendingAId,
			});
			expect(failureError(result).code).toBe(scopeError);
			expect(harness.calls.enqueued).toHaveLength(0);
		}
	});

	test("a revoked credential is NOT_FOUND and never reaches a relay", async () => {
		const harness = await createHarness();
		const result = await harness.service.verify({
			credentialId: harness.revokedAId,
		});
		expect(failureError(result).code).toBe("NOT_FOUND");
		expect(harness.calls.enqueued).toHaveLength(0);
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
	});

	test("verification is disabled with a fixed UNAVAILABLE when config is missing", async () => {
		resetConnectorVerificationForTests();
		const previousGateway = process.env.DEVICE_GATEWAY_ENABLED;
		const previousUrl = process.env.DATABASE_URL;
		process.env.DEVICE_GATEWAY_ENABLED = "false";
		process.env.DATABASE_URL = "";
		try {
			expect(isConnectorVerificationEnabled()).toBe(false);
			expect(
				isConnectorVerificationEnabled({ DEVICE_GATEWAY_ENABLED: "  TRUE " }),
			).toBe(false);
			expect(() => getConnectorVerificationService()).toThrow(
				ConnectorVerificationNotConfiguredError,
			);
			const result = await verifyConnectorCredential({
				credentialId: UNKNOWN_CREDENTIAL_ID,
			});
			expect(result).toEqual({
				ok: false,
				error: {
					code: "UNAVAILABLE",
					message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES.UNAVAILABLE,
				},
			});
		} finally {
			resetConnectorVerificationForTests();
			if (previousGateway === undefined) {
				delete process.env.DEVICE_GATEWAY_ENABLED;
			} else {
				process.env.DEVICE_GATEWAY_ENABLED = previousGateway;
			}
			if (previousUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousUrl;
		}
	});

	test("a configured gateway without Neon Auth settings is still UNAVAILABLE", () => {
		resetConnectorVerificationForTests();
		expect(() =>
			getConnectorVerificationService({
				DEVICE_GATEWAY_ENABLED: "true",
				DATABASE_URL: "postgres://localhost/isolate",
			}),
		).toThrow(ConnectorVerificationNotConfiguredError);
		resetConnectorVerificationForTests();
	});

	test("a device RATE_LIMITED is a 429-style failure and changes nothing", async () => {
		const harness = await createHarness({
			outcome: { ok: false, errorCode: "RATE_LIMITED" },
		});
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(failureError(result)).toEqual({
			code: "RATE_LIMITED",
			message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES.RATE_LIMITED,
			retryAfterSeconds: 30,
		});
		const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
		expect(stored?.status).toBe("pending_validation");
		expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
	});

	test("maps every fixed device error envelope", async () => {
		const cases = [
			{
				errorCode: "NOT_FOUND",
				status: "invalid",
				reasonCode: "CONFIG_REQUIRED",
			},
			{
				errorCode: "INTEGRATION_UNAVAILABLE",
				status: "invalid",
				reasonCode: "CONFIG_REQUIRED",
			},
			{
				errorCode: "VALIDATION_FAILED",
				status: "invalid",
				reasonCode: "CONFIG_REQUIRED",
			},
			{
				errorCode: "INTERNAL",
				status: "pending_validation",
				reasonCode: "PROVIDER_ERROR",
			},
			{
				errorCode: "EXPIRED",
				status: "pending_validation",
				reasonCode: "UNREACHABLE",
			},
			{
				errorCode: "POLICY_DENIED",
				status: "pending_validation",
				reasonCode: "PROVIDER_ERROR",
			},
		] as const;
		for (const entry of cases) {
			const harness = await createHarness({
				outcome: { ok: false, errorCode: entry.errorCode },
			});
			const result = await harness.service.verify({
				credentialId: harness.pendingAId,
			});
			const value = successValue(result);
			expect(value.status).toBe(entry.status);
			expect(value.reasonCode).toBe(entry.reasonCode);
			const stored = await harness.credentials.get(ORG_A, harness.pendingAId);
			expect(stored?.status).toBe(entry.status);
		}
	});

	test("treats a malformed or contradictory device payload as a provider fault", async () => {
		const payloads: Array<Record<string, unknown>> = [
			{ verified: true },
			{ verified: true, reasonCode: "AUTH_FAILED" },
			{ verified: "yes", reasonCode: "OK" },
			{ verified: true, reasonCode: "OK", body: "provider response" },
		];
		for (const data of payloads) {
			const harness = await createHarness({ outcome: { ok: true, data } });
			const value = successValue(
				await harness.service.verify({ credentialId: harness.pendingAId }),
			);
			expect(value.status).toBe("pending_validation");
			expect(value.reasonCode).toBe("PROVIDER_ERROR");
			expect(harness.writes).toEqual({ setStatus: 0, touchValidated: 0 });
		}

		// `verified: false` is still a real rejection; the contradictory `OK` is
		// reported as a provider fault instead of a success reason.
		const harness = await createHarness({
			outcome: {
				ok: true,
				data: { verified: false, reasonCode: "OK" },
			},
		});
		const value = successValue(
			await harness.service.verify({ credentialId: harness.pendingAId }),
		);
		expect(value.status).toBe("invalid");
		expect(value.reasonCode).toBe("PROVIDER_ERROR");
	});

	test("an invalid credential id is rejected before any work", async () => {
		const harness = await createHarness();
		for (const input of [
			{},
			{ credentialId: "not-a-uuid" },
			{ credentialId: harness.pendingAId, extra: true },
			null,
		]) {
			const result = await harness.service.verify(input);
			expect(failureError(result).code).toBe("INVALID_INPUT");
		}
		expect(harness.calls.enqueued).toHaveLength(0);
	});

	test("the caller throttle runs before the enqueue", async () => {
		const gate = new FakeRateLimitGate();
		const harness = await createHarness({ rateLimiter: gate });
		await harness.service.verify({ credentialId: harness.pendingAId });
		expect(gate.calls).toEqual([
			{ userId: USER_ID, action: "connector:connect" },
		]);
		expect(harness.calls.enqueued).toHaveLength(1);
	});

	test("a denied caller throttle is RATE_LIMITED with a retry hint", async () => {
		const gate = new FakeRateLimitGate(true);
		const harness = await createHarness({ rateLimiter: gate });
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(failureError(result)).toEqual({
			code: "RATE_LIMITED",
			message: CONNECTOR_VERIFICATION_FAILURE_MESSAGES.RATE_LIMITED,
			retryAfterSeconds: 17,
		});
		expect(harness.calls.enqueued).toHaveLength(0);
	});

	test("the serialized result never carries a ref, URL or provider text", async () => {
		const harness = await createHarness({
			outcome: { ok: true, data: { verified: true, reasonCode: "OK" } },
		});
		const result = await harness.service.verify({
			credentialId: harness.pendingAId,
		});
		expect(Object.keys(successValue(result)).sort()).toEqual([
			"credentialId",
			"reasonCode",
			"status",
			"verifiedAt",
		]);
		const serialized = JSON.stringify(result);
		for (const forbidden of [
			"keychain",
			"credentialRef",
			"displayName",
			"https://",
			"connectorId",
			"Sentry production",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});
});
