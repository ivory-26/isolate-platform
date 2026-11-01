import {
	CONNECTOR_CALL_DEFAULT_AWAIT_TIMEOUT_MS,
	CONNECTOR_CALL_DEFAULT_TTL_MS,
	CONNECTOR_CALL_MAX_PARAMS_BYTES,
	CONNECTOR_CALL_MAX_TTL_MS,
	CONNECTOR_CALL_MIN_TTL_MS,
	type ConnectorCallOutcome,
	type ConnectorCallRepository,
	clampConnectorCallAwaitOptions,
} from "@isolate/db";
import {
	assertBoundedDeviceJson,
	type ConnectorDeviceBroker,
} from "@isolate/integrations";
import {
	CONNECTOR_TOOL_NAMES,
	CONNECTOR_TOOL_RISKS,
	type ConnectorToolName,
	type ToolImplementation,
	type ToolName,
} from "@isolate/mastra";
import {
	asOrganizationId,
	assertNoCredentialMaterial,
	type ErrorCode,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import { parseConnectorToolArguments } from "./connector-schemas";

/**
 * Wave 17 connector tools over the device poll queue.
 *
 * The worker never holds a provider key. For one call it:
 * 1. bounds the raw arguments, parses them with the adapter's own strict
 *    input schema (unknown tool name and unknown keys fail here), then runs
 *    the recursive credential scan,
 * 2. resolves the organization's active device + credential through the
 *    `ConnectorDeviceBroker` (metadata only; no secret),
 * 3. refuses a `scoped_write` tool unless the credential carries a write scope,
 * 4. enqueues a typed call for that device (`connector_calls`),
 * 5. awaits a bounded result shorter than the call TTL, scoped to the same
 *    organization and device.
 *
 * The device daemon polls `/api/device/claim`, executes against the provider
 * with its own keychain item and posts a bounded `{ ok, data }`. Provider text,
 * arguments and tokens never enter an error or a log here: failures surface as
 * fixed `PlatformError` codes.
 */

/** Default device poll interval for `awaitResult` (repository clamps 10–5000). */
const DEFAULT_POLL_MS = 250;

/**
 * A `scoped_write` tool needs an explicit write capability on the resolved
 * credential. Reads stay available with a read-only token; a state-changing
 * acknowledge/resolve must never ride a read scope.
 */
const CONNECTOR_WRITE_SCOPE = "connector:write";

/** Fixed, credential-free mapping from a device-reported code to a platform code. */
const DEVICE_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
	INTEGRATION_UNAVAILABLE: "INTEGRATION_UNAVAILABLE",
	RATE_LIMITED: "RATE_LIMITED",
	POLICY_DENIED: "POLICY_DENIED",
	VALIDATION_FAILED: "VALIDATION_FAILED",
	NOT_FOUND: "NOT_FOUND",
	INTERNAL: "INTERNAL",
	// A call that expired on the queue is indistinguishable from an offline
	// device: no result was produced, so the tool degrades rather than retries.
	EXPIRED: "INTEGRATION_UNAVAILABLE",
};

const CONNECTOR_FOR_TOOL: Readonly<Record<ConnectorToolName, string>> = {
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

/** Stable connector id for one exposed tool name. */
export function connectorIdForToolName(name: ConnectorToolName): string {
	return CONNECTOR_FOR_TOOL[name];
}

export type ConnectorToolDependencies = {
	/** Resolves the active device and credential; never returns a secret. */
	broker: ConnectorDeviceBroker;
	/** Durable queue used by the worker (`connector_calls`). */
	calls: Pick<ConnectorCallRepository, "enqueue" | "awaitResult">;
	/** Clock seam for deterministic callers/tests. */
	now?: () => number;
	/** Call deadline on the device queue; defaults to 60 s. */
	ttlMs?: number;
	/** Server wait for a result; always shorter than `ttlMs`. */
	awaitTimeoutMs?: number;
	/** Poll interval passed to `awaitResult`. */
	pollMs?: number;
};

/**
 * Validates model arguments before any broker or queue work.
 *
 * Order is deliberate: a 64 KiB JSON bound (the same cap the queue enforces)
 * refuses an oversized tree before Zod walks it, the adapter's own strict
 * schema then rejects an unknown tool name, unknown/extra keys, malformed
 * values and out-of-range numbers, and finally the recursive credential scan
 * refuses a provider secret hidden in an accepted string value. Returns the
 * detached parsed object, so only schema-shaped data reaches the device queue.
 */
export function validateConnectorToolArguments(
	toolName: ConnectorToolName,
	args: Record<string, unknown>,
): Record<string, unknown> {
	assertBoundedDeviceJson(
		args,
		"connector tool arguments",
		CONNECTOR_CALL_MAX_PARAMS_BYTES,
	);
	const validated = parseConnectorToolArguments(toolName, args);
	if (!validated.ok) throw validated.error;
	// Fixed text, no value echo: the argument may itself be the attempted secret.
	assertNoCredentialMaterial(validated.data);
	return validated.data;
}

/**
 * Refuses a state-changing call when the resolved credential only carries
 * read scopes. Checked after resolution and before enqueue, so a denied write
 * never reaches the device queue.
 */
export function assertConnectorWriteScope(
	toolName: ConnectorToolName,
	connectorId: string,
	scopes: readonly string[],
): void {
	if (CONNECTOR_TOOL_RISKS[toolName] !== "scoped_write") return;
	const granted = scopes.some(
		(scope) =>
			scope === CONNECTOR_WRITE_SCOPE || scope === `${connectorId}:write`,
	);
	if (!granted) {
		throw new PlatformError(
			"POLICY_DENIED",
			`connector "${connectorId}" credential lacks a write scope`,
		);
	}
}

function deviceFailure(connectorId: string, errorCode: string): PlatformError {
	const code = DEVICE_ERROR_CODES[errorCode] ?? "INTERNAL";
	const reason =
		code === "INTEGRATION_UNAVAILABLE"
			? "has no result from an active device"
			: "device call failed";
	return new PlatformError(code, `connector "${connectorId}" ${reason}`);
}

function requireQueueTarget(
	connectorId: string,
	deviceId: string | null,
	credentialId: string | null,
): { deviceId: string; credentialId: string } {
	// The env fallback resolves a credential ref without a device row; there is
	// no poll queue for it, so a queue-backed tool must fail closed.
	if (deviceId === null || credentialId === null) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`connector "${connectorId}" has no device call queue`,
		);
	}
	return { deviceId, credentialId };
}

function resolveBoundedTimings(deps: ConnectorToolDependencies): {
	ttlMs: number;
	awaitTimeoutMs: number;
	pollMs: number;
} {
	const ttlMs = deps.ttlMs ?? CONNECTOR_CALL_DEFAULT_TTL_MS;
	if (
		!Number.isInteger(ttlMs) ||
		ttlMs < CONNECTOR_CALL_MIN_TTL_MS ||
		ttlMs > CONNECTOR_CALL_MAX_TTL_MS
	) {
		throw new PlatformError(
			"MISSING_CONFIG",
			"connector tool ttlMs is invalid",
		);
	}
	// The server must give up before the queue row expires, so a late device
	// result is never consumed twice or attributed to a retried call.
	const requestedAwait =
		deps.awaitTimeoutMs ?? CONNECTOR_CALL_DEFAULT_AWAIT_TIMEOUT_MS;
	const bounded = clampConnectorCallAwaitOptions(
		Math.max(1, Math.min(requestedAwait, ttlMs - 1)),
		deps.pollMs ?? DEFAULT_POLL_MS,
	);
	return {
		ttlMs,
		awaitTimeoutMs: bounded.timeoutMs,
		pollMs: bounded.pollMs,
	};
}

/**
 * Builds one implementation per connector tool name. A tool absent from this
 * map stays deny-by-default in the registry even when policy admits it.
 */
export function createConnectorToolImplementations(
	deps: ConnectorToolDependencies,
): Partial<Record<ToolName, ToolImplementation>> {
	const timings = resolveBoundedTimings(deps);
	const implementations: Partial<Record<ToolName, ToolImplementation>> = {};

	for (const toolName of CONNECTOR_TOOL_NAMES) {
		const connectorId = connectorIdForToolName(toolName);
		implementations[toolName] = async (args, context) => {
			const params = validateConnectorToolArguments(toolName, args);
			const organizationId: OrganizationId = asOrganizationId(
				context.organizationId,
			);
			const resolved = await deps.broker.resolve(organizationId, connectorId);
			const target = requireQueueTarget(
				connectorId,
				resolved.deviceId,
				resolved.credentialId,
			);
			assertConnectorWriteScope(toolName, connectorId, resolved.scopes);

			const call = await deps.calls.enqueue({
				organizationId,
				deviceId: target.deviceId,
				credentialId: target.credentialId,
				taskId: context.taskId,
				connectorId,
				toolName,
				params,
				ttlMs: timings.ttlMs,
				traceparent: context.traceparent ?? null,
			});

			const outcome: ConnectorCallOutcome | null = await deps.calls.awaitResult(
				call.id,
				timings.awaitTimeoutMs,
				timings.pollMs,
				// Tenant-scoped read: a leaked call id cannot return another
				// organization's or device's result.
				{ organizationId, deviceId: target.deviceId },
			);
			if (outcome === null) {
				throw new PlatformError(
					"INTEGRATION_UNAVAILABLE",
					`connector "${connectorId}" call timed out`,
				);
			}
			if (!outcome.ok) {
				throw deviceFailure(connectorId, outcome.errorCode);
			}
			return { ok: true, data: outcome.data };
		};
	}

	return implementations;
}
