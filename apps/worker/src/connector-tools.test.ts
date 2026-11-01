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
	CONNECTOR_TOOL_ARGUMENT_SCHEMAS,
	parseConnectorToolArguments,
} from "./connector-schemas";
import {
	connectorIdForToolName,
	createConnectorToolImplementations,
	validateConnectorToolArguments,
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

/**
 * One adapter-valid argument object per tool. These double as the strictness
 * fixture: `{ ...VALID_ARGS[name], unexpected: true }` must be rejected by
 * every schema (all 31 are strict objects).
 */
const VALID_ARGS: Record<ConnectorToolName, Record<string, unknown>> = {
	"sentry.list_issues": { orgSlug: "acme", limit: 5 },
	"sentry.get_issue": { orgSlug: "acme", issueId: "42" },
	"sentry.latest_event": { orgSlug: "acme", issueId: "42" },
	"grafana.query_metrics": { service: "checkout", windowMinutes: 30 },
	"grafana.query_logs": { service: "checkout", maxLines: 100 },
	"grafana.get_alert_rule": { ruleUid: "rule-1" },
	"pagerduty.list_incidents": { limit: 5 },
	"pagerduty.get_incident": { incidentId: "P1" },
	"pagerduty.list_log_entries": { incidentId: "P1", limit: 5 },
	"pagerduty.acknowledge": { incidentId: "P1" },
	"pagerduty.resolve": { incidentId: "P1" },
	"k8s.list_events": { namespace: "default", name: "api" },
	"k8s.get_pod": { namespace: "default", name: "api" },
	"k8s.get_deployment": { namespace: "default", name: "api" },
	"k8s.logs_tail": { namespace: "default", podName: "api", tailLines: 100 },
	"datadog.query_metrics": { service: "checkout", windowMinutes: 30 },
	"datadog.search_logs": { service: "checkout", maxEntries: 10 },
	"datadog.get_incident": { incidentId: "inc-1" },
	"datadog.get_monitor": { monitorId: 12_345 },
	"axiom.query_apl": { apl: "['logs'] | limit 10", windowMinutes: 15 },
	"axiom.get_monitor": { monitorId: "mon-1" },
	"axiom.list_datasets": {},
	"signoz.query_range": {
		service: "checkout",
		query: "rate(http_requests_total[5m])",
	},
	"signoz.get_rule": { ruleId: "rule-1" },
	"signoz.list_rules": { limit: 5 },
	"newrelic.run_nrql": {
		query: "SELECT count(*) FROM Transaction",
		windowMinutes: 15,
	},
	"newrelic.get_entity": { guid: "MXxBUE18QVBQTElDQVRJT058MQ" },
	"newrelic.list_alert_policies": { limit: 5 },
	"honeycomb.run_query": { kind: "latency", service: "checkout" },
	"honeycomb.get_trigger": { triggerId: "trigger-1" },
	"honeycomb.list_slos": {},
};

/** One schema violation per tool: wrong type, range, pattern or missing key. */
const MALFORMED_ARGS: Record<ConnectorToolName, Record<string, unknown>> = {
	"sentry.list_issues": { orgSlug: "acme", limit: 0 },
	"sentry.get_issue": { orgSlug: "acme", issueId: "" },
	"sentry.latest_event": { orgSlug: "acme" },
	"grafana.query_metrics": { service: "checkout", windowMinutes: 5 },
	"grafana.query_logs": { service: "checkout", maxLines: 0 },
	"grafana.get_alert_rule": { ruleUid: "not a uid" },
	"pagerduty.list_incidents": { limit: 0 },
	"pagerduty.get_incident": { incidentId: "P1/../x" },
	"pagerduty.list_log_entries": { incidentId: "P1", limit: 0 },
	"pagerduty.acknowledge": { incidentId: "" },
	"pagerduty.resolve": {},
	"k8s.list_events": { namespace: "default", name: "api", limit: 51 },
	"k8s.get_pod": { namespace: "default" },
	"k8s.get_deployment": {},
	"k8s.logs_tail": { namespace: "default", podName: "api", tailLines: 0 },
	"datadog.query_metrics": { service: "checkout", windowMinutes: 61 },
	"datadog.search_logs": { service: "checkout", maxEntries: 0 },
	"datadog.get_incident": { incidentId: "inc/1" },
	"datadog.get_monitor": { monitorId: -1 },
	"axiom.query_apl": { apl: "" },
	"axiom.get_monitor": { monitorId: "bad id" },
	"axiom.list_datasets": { unexpected: true },
	"signoz.query_range": { service: "checkout", query: "rate(x[5m]);" },
	"signoz.get_rule": { ruleId: "rule/1" },
	"signoz.list_rules": { limit: 0 },
	"newrelic.run_nrql": { query: "" },
	"newrelic.get_entity": { guid: "bad guid" },
	"newrelic.list_alert_policies": { limit: 0 },
	"honeycomb.run_query": { kind: "apdex", service: "checkout" },
	"honeycomb.get_trigger": { triggerId: "TRIGGER-1" },
	"honeycomb.list_slos": { limit: 1 },
};

/** Tools whose adapter schema has no required field, so `{}` is valid. */
const OPTIONAL_ONLY: ReadonlySet<ConnectorToolName> = new Set([
	"pagerduty.list_incidents",
	"axiom.list_datasets",
	"signoz.list_rules",
	"newrelic.list_alert_policies",
	"honeycomb.list_slos",
]);

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
		traceparent: input.traceparent ?? null,
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
			const value = await implementation(VALID_ARGS[name], context);

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
				params: VALID_ARGS[name],
				ttlMs: 60_000,
			});
		}
	});

	test("every tool rejects an extra key with VALIDATION_FAILED and never enqueues", async () => {
		for (const name of CONNECTOR_TOOL_NAMES) {
			const { implementation, connectorIds, enqueued } = implementationFor(
				name,
				{ outcome: { ok: true, data: {} } },
			);
			await expectPlatformCode(
				implementation({ ...VALID_ARGS[name], unexpected: true }, context),
				"VALIDATION_FAILED",
			);
			// No credential resolved, no call enqueued: the refusal is local.
			expect({ name, connectorIds: connectorIds.length }).toEqual({
				name,
				connectorIds: 0,
			});
			expect(enqueued).toHaveLength(0);
		}
	});

	test("every tool rejects a malformed or incomplete argument object", async () => {
		for (const name of CONNECTOR_TOOL_NAMES) {
			const { implementation, connectorIds, enqueued } = implementationFor(
				name,
				{ outcome: { ok: true, data: {} } },
			);
			await expectPlatformCode(
				implementation(MALFORMED_ARGS[name], context),
				"VALIDATION_FAILED",
			);
			expect(connectorIds).toHaveLength(0);
			expect(enqueued).toHaveLength(0);
		}
	});

	test("only the five all-optional tools accept an empty object", async () => {
		for (const name of CONNECTOR_TOOL_NAMES) {
			const parsed = parseConnectorToolArguments(name, {});
			expect({ name, ok: parsed.ok }).toEqual({
				name,
				ok: OPTIONAL_ONLY.has(name),
			});
		}
	});

	test("the schema table covers exactly the 31 tool names", () => {
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(31);
		expect(Object.keys(CONNECTOR_TOOL_ARGUMENT_SCHEMAS).sort()).toEqual(
			[...CONNECTOR_TOOL_NAMES].sort(),
		);
	});

	test("an unknown tool name fails closed without echoing the name", () => {
		const result = parseConnectorToolArguments("sentry.not_a_tool", {
			orgSlug: "acme",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unknown tool was accepted");
		expect(result.error).toBeInstanceOf(PlatformError);
		expect(result.error.code).toBe("VALIDATION_FAILED");
		expect(result.error.message).not.toContain("not_a_tool");
	});

	test("schema failures never echo the offending value", () => {
		const marker = "SECRET-VALUE/../";
		const result = parseConnectorToolArguments("sentry.get_issue", {
			orgSlug: "acme",
			issueId: marker,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("malformed arguments were accepted");
		expect(result.error.message).not.toContain(marker);
		expect(result.error.message).toContain("issueId");
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
		const value = await implementation(
			{ orgSlug: "acme", issueId: "1" },
			context,
		);
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

	test("oversized arguments are bounded before the device is resolved", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"grafana.query_metrics",
			{ outcome: { ok: true, data: {} } },
		);
		const huge = "x".repeat(70_000);
		const error = await expectPlatformCode(
			implementation({ service: huge }, context),
			"VALIDATION_FAILED",
		);
		expect(error.message).not.toContain(huge);
		expect(connectorIds).toHaveLength(0);
		expect(enqueued).toHaveLength(0);

		// The 64 KiB cap is applied to the raw object before the schema walk.
		const boundError = (() => {
			try {
				validateConnectorToolArguments("sentry.list_issues", {
					orgSlug: "acme",
					query: "y".repeat(70_000),
				});
				throw new Error("oversized arguments were accepted");
			} catch (error) {
				return error as PlatformError;
			}
		})();
		expect(boundError.code).toBe("VALIDATION_FAILED");
		expect(boundError.message).toContain("65536");
	});

	test("credential-shaped keys are rejected without echo", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"sentry.list_issues",
			{ outcome: { ok: true, data: {} } },
		);
		const keyError = await expectPlatformCode(
			implementation(
				{ orgSlug: "acme", apiKey: "sk-live-SECRET-VALUE" },
				context,
			),
			"VALIDATION_FAILED",
		);
		expect(keyError.message).not.toContain("sk-live");
		expect(keyError.message).not.toContain("SECRET-VALUE");
		expect(connectorIds).toHaveLength(0);
		expect(enqueued).toHaveLength(0);

		// The queue repository refuses credential material inside values too,
		// before any device can see the call. `query` is a valid schema field, so
		// the recursive scan (not the schema) is what refuses this.
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
				{ orgSlug: "acme", query: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
				context,
			),
			"VALIDATION_FAILED",
		);
		expect(valueError.message).not.toContain("ghp_");
		expect(calls.rowCount).toBe(0);
	});

	test("credential-shaped values in accepted fields are rejected, metadata passes", async () => {
		const { implementation, connectorIds, enqueued } = implementationFor(
			"sentry.list_issues",
			{ outcome: { ok: true, data: {} } },
		);
		// Both values pass the adapter's query pattern, so only the recursive
		// credential scan can refuse them.
		const cases: Record<string, unknown>[] = [
			{ orgSlug: "acme", query: `Bearer ${"x".repeat(20)}` },
			{ orgSlug: "acme", query: `sk-proj-${"A".repeat(32)}` },
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

		// A credential-shaped *key* is refused by the strict schema instead;
		// ordinary metadata such as `limit` still passes and is enqueued.
		await expectPlatformCode(
			implementation({ orgSlug: "acme", nested: { apiKey: "value" } }, context),
			"VALIDATION_FAILED",
		);
		const allowed = await implementation(
			VALID_ARGS["sentry.list_issues"],
			context,
		);
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
			rateLimited.implementation({ service: "checkout" }, context),
			"RATE_LIMITED",
		);

		const unknown = implementationFor("datadog.search_logs", {
			outcome: { ok: false, errorCode: "SOMETHING_NEW" },
		});
		const error = await expectPlatformCode(
			unknown.implementation({ service: "checkout" }, context),
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
			implementation({ orgSlug: "acme", issueId: "1" }, context),
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
			implementation({ orgSlug: "acme" }, context),
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
