import { describe, expect, test } from "bun:test";
import {
	type ConnectorCallOutcome,
	type ConnectorCallRecord,
	type ConnectorCallRepository,
	type ConnectorCallScope,
	InMemoryConnectorCallRepository,
} from "@isolate/db";
import type {
	ConnectorDeviceBroker,
	ResolvedConnectorDevice,
} from "@isolate/integrations";
import { NullDeviceProxy } from "@isolate/integrations";
import {
	CONNECTOR_TOOL_NAMES,
	CONNECTOR_TOOL_RISKS,
	type ConnectorToolName,
	createRiskTablePolicy,
	SANDBOX_TOOL_RISKS,
	type ToolCallContext,
	type WiredToolOutput,
	wirePlatformTools,
} from "@isolate/mastra";
import {
	asOrganizationId,
	type ErrorCode,
	PlatformError,
} from "@isolate/shared";
import {
	connectorIdForToolName,
	createConnectorToolImplementations,
} from "./connector-tools";

const ORG = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL_ID = "44444444-4444-4444-8444-444444444444";

const context: ToolCallContext = {
	organizationId: ORG,
	taskId: TASK,
	scopes: [],
};

type EnqueueInput = Parameters<ConnectorCallRepository["enqueue"]>[0];

function recordFor(input: EnqueueInput, index: number): ConnectorCallRecord {
	return {
		id: `call-${index}`,
		organizationId: input.organizationId,
		deviceId: input.deviceId,
		credentialId: input.credentialId,
		taskId: input.taskId ?? null,
		connectorId: input.connectorId,
		toolName: input.toolName,
		params: input.params,
		status: "queued",
		result: null,
		errorCode: null,
		attempts: 0,
		claimedAt: null,
		completedAt: null,
		expiresAt: new Date(Date.now() + (input.ttlMs ?? 60_000)),
		createdAt: new Date(),
	};
}

function makeBroker(resolved: Partial<ResolvedConnectorDevice> = {}): {
	broker: ConnectorDeviceBroker;
	connectorIds: string[];
} {
	const connectorIds: string[] = [];
	return {
		connectorIds,
		broker: {
			async resolve(_organizationId, connectorId) {
				connectorIds.push(connectorId);
				return {
					deviceId: DEVICE_ID,
					credentialId: CREDENTIAL_ID,
					credentialRef: "keychain:isolate/test",
					// Read and write tools share this fixture; deny tests override it.
					scopes: ["connector:write"],
					metadata: {},
					proxy: new NullDeviceProxy(),
					...resolved,
				};
			},
		},
	};
}

function makeCalls(outcome: ConnectorCallOutcome | null): {
	calls: Pick<ConnectorCallRepository, "enqueue" | "awaitResult">;
	enqueued: EnqueueInput[];
	awaited: Array<{
		callId: string;
		timeoutMs: number;
		pollMs: number;
		scope: ConnectorCallScope | undefined;
	}>;
} {
	const enqueued: EnqueueInput[] = [];
	const awaited: Array<{
		callId: string;
		timeoutMs: number;
		pollMs: number;
		scope: ConnectorCallScope | undefined;
	}> = [];
	return {
		enqueued,
		awaited,
		calls: {
			async enqueue(input) {
				enqueued.push(input);
				return recordFor(input, enqueued.length);
			},
			async awaitResult(callId, timeoutMs, pollMs, scope) {
				awaited.push({ callId, timeoutMs, pollMs, scope });
				return outcome;
			},
		},
	};
}

function implementationFor(
	name: ConnectorToolName,
	options: {
		outcome?: ConnectorCallOutcome | null;
		resolved?: Partial<ResolvedConnectorDevice>;
		ttlMs?: number;
		awaitTimeoutMs?: number;
	} = {},
) {
	const { broker, connectorIds } = makeBroker(options.resolved);
	const { calls, enqueued, awaited } = makeCalls(options.outcome ?? null);
	const implementations = createConnectorToolImplementations({
		broker,
		calls,
		...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
		...(options.awaitTimeoutMs === undefined
			? {}
			: { awaitTimeoutMs: options.awaitTimeoutMs }),
		pollMs: 20,
	});
	const implementation = implementations[name];
	if (implementation === undefined) throw new Error(`missing ${name}`);
	return { implementation, connectorIds, enqueued, awaited };
}

async function expectPlatformCode(
	value: unknown,
	code: ErrorCode,
): Promise<PlatformError> {
	try {
		await value;
		throw new Error("call unexpectedly succeeded");
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformError);
		const platformError = error as PlatformError;
		expect(platformError.code).toBe(code);
		return platformError;
	}
}

describe("connector tool surface", () => {
	test("every connector tool maps to its connector id and enqueues a bounded call", async () => {
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(31);
		const expected: Record<ConnectorToolName, string> = {
			"sentry.list_issues": "sentry",
			"sentry.get_issue": "sentry",
			"sentry.latest_event": "sentry",
			"grafana.query_metrics": "grafana",
			"grafana.query_logs": "grafana",
			"grafana.get_alert_rule": "grafana",
			"pagerduty.list_incidents": "pagerduty",
			"pagerduty.get_incident": "pagerduty",
			"pagerduty.list_log_entries": "pagerduty",
			"pagerduty.acknowledge": "pagerduty",
			"pagerduty.resolve": "pagerduty",
			"k8s.list_events": "kubernetes",
			"k8s.get_pod": "kubernetes",
			"k8s.get_deployment": "kubernetes",
			"k8s.logs_tail": "kubernetes",
			"datadog.query_metrics": "datadog",
			"datadog.search_logs": "datadog",
			"datadog.get_incident": "datadog",
			"datadog.get_monitor": "datadog",
			"axiom.query_apl": "axiom",
			"axiom.get_monitor": "axiom",
			"axiom.list_datasets": "axiom",
			"signoz.query_range": "signoz",
			"signoz.get_rule": "signoz",
			"signoz.list_rules": "signoz",
			"newrelic.run_nrql": "newrelic",
			"newrelic.get_entity": "newrelic",
			"newrelic.list_alert_policies": "newrelic",
			"honeycomb.run_query": "honeycomb",
			"honeycomb.get_trigger": "honeycomb",
			"honeycomb.list_slos": "honeycomb",
		};

		for (const name of CONNECTOR_TOOL_NAMES) {
			expect(connectorIdForToolName(name)).toBe(expected[name]);
			const { implementation, connectorIds, enqueued } = implementationFor(
				name,
				{ outcome: { ok: true, data: { items: [] } } },
			);
			const value = await implementation({ project: "web" }, context);

			expect(value).toEqual({ ok: true, data: { items: [] } });
			expect(connectorIds).toEqual([expected[name]]);
			expect(enqueued).toHaveLength(1);
			expect(enqueued[0]).toMatchObject({
				organizationId: ORG,
				deviceId: DEVICE_ID,
				credentialId: CREDENTIAL_ID,
				taskId: TASK,
				connectorId: expected[name],
				toolName: name,
				params: { project: "web" },
				ttlMs: 60_000,
			});
		}
	});

	test("waits less than the call TTL and returns the device data", async () => {
		const { implementation, awaited, enqueued } = implementationFor(
			"sentry.get_issue",
			{
				outcome: { ok: true, data: { id: "1", title: "boom" } },
				ttlMs: 5_000,
				awaitTimeoutMs: 4_000,
			},
		);
		const value = await implementation({ issueId: "1" }, context);
		expect(value).toEqual({ ok: true, data: { id: "1", title: "boom" } });
		expect(enqueued[0]?.ttlMs).toBe(5_000);
		expect(awaited[0]?.timeoutMs).toBe(4_000);
		expect(awaited[0]?.timeoutMs).toBeLessThan(5_000);
		// The result read is scoped to the resolved organization and device.
		expect(awaited[0]?.scope?.organizationId).toBe(asOrganizationId(ORG));
		expect(awaited[0]?.scope?.deviceId).toBe(DEVICE_ID);
	});

	test("an oversized server wait is clamped below the TTL", async () => {
		const { implementation, awaited } = implementationFor("pagerduty.resolve", {
			outcome: { ok: true, data: {} },
			ttlMs: 5_000,
			awaitTimeoutMs: 60_000,
		});
		await implementation({ incidentId: "P1" }, context);
		expect(awaited[0]?.timeoutMs).toBe(4_999);
	});

	test("arguments are bounded before the device is resolved", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"grafana.query_metrics",
			{ outcome: { ok: true, data: {} } },
		);
		const huge = "x".repeat(70_000);
		const error = await expectPlatformCode(
			implementation({ query: huge }, context),
			"VALIDATION_FAILED",
		);
		expect(error.message).not.toContain(huge);
		expect(connectorIds).toHaveLength(0);
		expect(enqueued).toHaveLength(0);
	});

	test("credential-shaped keys and values are rejected without echo", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"sentry.list_issues",
			{ outcome: { ok: true, data: {} } },
		);
		const keyError = await expectPlatformCode(
			implementation({ apiKey: "sk-live-SECRET-VALUE" }, context),
			"VALIDATION_FAILED",
		);
		expect(keyError.message).not.toContain("sk-live");
		expect(keyError.message).not.toContain("SECRET-VALUE");
		expect(connectorIds).toHaveLength(0);
		expect(enqueued).toHaveLength(0);

		// The queue repository refuses credential material inside values too,
		// before any device can see the call.
		const calls = new InMemoryConnectorCallRepository();
		const realQueueImplementation = createConnectorToolImplementations({
			broker: makeBroker().broker,
			calls,
			awaitTimeoutMs: 50,
			pollMs: 10,
		})["sentry.list_issues"];
		if (realQueueImplementation === undefined) throw new Error("missing tool");
		const valueError = await expectPlatformCode(
			realQueueImplementation(
				{ query: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
				context,
			),
			"VALIDATION_FAILED",
		);
		expect(valueError.message).not.toContain("ghp_");
		expect(calls.rowCount).toBe(0);
	});

	test("credential material nested in arguments is rejected, token metadata passes", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"sentry.list_issues",
			{ outcome: { ok: true, data: {} } },
		);
		const cases: Record<string, unknown>[] = [
			{ headers: { authorization: `Bearer ${"x".repeat(20)}` } },
			{ note: `sk-proj-${"A".repeat(32)}` },
			{ nested: { apiKey: "value" } },
		];
		for (const args of cases) {
			const error = await expectPlatformCode(
				implementation(args, context),
				"VALIDATION_FAILED",
			);
			expect(error.message).not.toContain("Bearer");
			expect(error.message).not.toContain("sk-proj");
		}
		expect(connectorIds).toHaveLength(0);
		expect(enqueued).toHaveLength(0);

		const allowed = await implementation({ tokenBudget: 1_000 }, context);
		expect(allowed).toEqual({ ok: true, data: {} });
		expect(enqueued).toHaveLength(1);
	});

	test("scoped writes require a write scope on the resolved credential", async () => {
		const denied = implementationFor("pagerduty.acknowledge", {
			resolved: { scopes: ["incidents:read"] },
			outcome: { ok: true, data: {} },
		});
		const error = await expectPlatformCode(
			denied.implementation({ incidentId: "P1" }, context),
			"POLICY_DENIED",
		);
		expect(error.message).not.toContain("incidents:read");
		expect(denied.enqueued).toHaveLength(0);

		for (const scope of ["connector:write", "pagerduty:write"]) {
			const allowed = implementationFor("pagerduty.resolve", {
				resolved: { scopes: [scope] },
				outcome: { ok: true, data: {} },
			});
			await allowed.implementation({ incidentId: "P1" }, context);
			expect(allowed.enqueued).toHaveLength(1);
		}
	});

	test("read tools stay callable with read-only scopes", async () => {
		const read = implementationFor("pagerduty.list_incidents", {
			resolved: { scopes: ["incidents:read"] },
			outcome: { ok: true, data: { incidents: [] } },
		});
		await read.implementation({}, context);
		expect(read.enqueued).toHaveLength(1);
	});

	test("a timeout or an expired row degrades to INTEGRATION_UNAVAILABLE", async () => {
		const timedOut = implementationFor("k8s.logs_tail", { outcome: null });
		const timeoutError = await expectPlatformCode(
			timedOut.implementation(
				{ namespace: "default", podName: "api" },
				context,
			),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(timeoutError.message).toContain('connector "kubernetes"');

		const expired = implementationFor("k8s.logs_tail", {
			outcome: { ok: false, errorCode: "EXPIRED" },
		});
		await expectPlatformCode(
			expired.implementation({ namespace: "default", podName: "api" }, context),
			"INTEGRATION_UNAVAILABLE",
		);
	});

	test("device failures map to bounded platform codes", async () => {
		const rateLimited = implementationFor("datadog.search_logs", {
			outcome: { ok: false, errorCode: "RATE_LIMITED" },
		});
		await expectPlatformCode(
			rateLimited.implementation({ query: "status:error" }, context),
			"RATE_LIMITED",
		);

		const unknown = implementationFor("datadog.search_logs", {
			outcome: { ok: false, errorCode: "SOMETHING_NEW" },
		});
		const error = await expectPlatformCode(
			unknown.implementation({ query: "status:error" }, context),
			"INTERNAL",
		);
		expect(error.message).not.toContain("SOMETHING_NEW");
	});

	test("missing or revoked credentials fail before enqueue", async () => {
		const broker: ConnectorDeviceBroker = {
			async resolve() {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					'connector "sentry" has no active device credential',
				);
			},
		};
		const { calls, enqueued } = makeCalls({ ok: true, data: {} });
		const implementation = createConnectorToolImplementations({
			broker,
			calls,
		})["sentry.latest_event"];
		if (implementation === undefined) throw new Error("missing tool");

		const error = await expectPlatformCode(
			implementation({ issueId: "1" }, context),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(error.message).toContain("no active device credential");
		expect(enqueued).toHaveLength(0);
	});

	test("the env fallback has no queue target and fails before enqueue", async () => {
		const { implementation, enqueued } = implementationFor(
			"sentry.list_issues",
			{
				outcome: { ok: true, data: {} },
				resolved: { deviceId: null, credentialId: null },
			},
		);
		const error = await expectPlatformCode(
			implementation({ project: "web" }, context),
			"INTEGRATION_UNAVAILABLE",
		);
		expect(error.message).toContain("has no device call queue");
		expect(enqueued).toHaveLength(0);
	});
});

describe("connector tool registry wiring", () => {
	test("the registry exposes all 31 connector names", () => {
		const registry = wirePlatformTools({
			policy: createRiskTablePolicy({
				...SANDBOX_TOOL_RISKS,
				...CONNECTOR_TOOL_RISKS,
			}),
			implementations: {},
		});
		const collection = registry.forTask(context);
		for (const name of CONNECTOR_TOOL_NAMES) {
			expect(collection[name]).toBeDefined();
		}
		// Existing sandbox names stay wired.
		expect(collection["repo.read_file"]).toBeDefined();
	});

	test("the merged risk map admits reads and scoped writes", async () => {
		const policy = createRiskTablePolicy({
			...SANDBOX_TOOL_RISKS,
			...CONNECTOR_TOOL_RISKS,
		});
		const read = await policy({
			tool: "sentry.list_issues",
			organizationId: ORG,
			taskId: TASK,
			arguments: {},
			scopes: [],
		});
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.value).toEqual({
				allowed: true,
				risk: "read_only",
				audited: true,
			});
		}

		const write = await policy({
			tool: "pagerduty.acknowledge",
			organizationId: ORG,
			taskId: TASK,
			arguments: {},
			scopes: [],
		});
		expect(write.ok).toBe(true);
		if (write.ok) {
			expect(write.value).toEqual({
				allowed: true,
				risk: "scoped_write",
				audited: true,
			});
		}
	});

	test("a connector name without an implementation is denied", async () => {
		const registry = wirePlatformTools({
			policy: createRiskTablePolicy({
				...SANDBOX_TOOL_RISKS,
				...CONNECTOR_TOOL_RISKS,
			}),
			implementations: {},
		});
		const execute = registry.forTask(context)["sentry.list_issues"].execute;
		if (execute === undefined) throw new Error("tool has no execute");
		const output = (await execute({}, {} as never)) as WiredToolOutput;
		expect(output).toEqual({ state: "denied", reason: "POLICY_DENIED" });
	});
});
