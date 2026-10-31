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
	type ConnectorToolName,
	type ToolImplementation,
	type ToolName,
} from "@isolate/mastra";
import {
	asOrganizationId,
	type ErrorCode,
	type OrganizationId,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";

/**
 * Wave 17 connector tools over the device poll queue.
 *
 * The worker never holds a provider key. For one call it:
 * 1. validates bounded, credential-free arguments,
 * 2. resolves the organization's active device + credential through the
 *    `ConnectorDeviceBroker` (metadata only; no secret),
 * 3. enqueues a typed call for that device (`connector_calls`),
 * 4. awaits a bounded result shorter than the call TTL.
 *
 * The device daemon polls `/api/device/claim`, executes against the provider
 * with its own keychain item and posts a bounded `{ ok, data }`. Provider text,
 * arguments and tokens never enter an error or a log here: failures surface as
 * fixed `PlatformError` codes.
 */

/** Default device poll interval for `awaitResult` (repository clamps 10–5000). */
const DEFAULT_POLL_MS = 250;

/**
 * Top-level keys that would carry a credential. Connector arguments are typed
 * provider query inputs; a model-supplied token/api-key/header is always a
 * boundary violation, so the call is rejected before anything is enqueued.
 */
const CREDENTIAL_KEY_PATTERN =
	/(token|secret|password|passwd|api[-_]?key|apikey|credential|authorization|bearer|cookie|private[-_]?key|access[-_]?key|client[-_]?secret|session[-_]?id)/i;

/** Strict JSON object at the boundary; unknown keys are forwarded as data. */
const connectorArgumentsSchema = z.record(
	z.string().min(1).max(64),
	z.unknown(),
);

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

function validationError(toolName: ConnectorToolName, reason: string) {
	return new PlatformError(
		"VALIDATION_FAILED",
		`connector tool ${toolName} ${reason}`,
	);
}

/**
 * Validates model arguments before any broker or queue work: a strict bounded
 * JSON object (64 KiB, depth/key/item caps) with no credential-shaped or
 * forbidden top-level key. Returns a detached clone.
 */
export function validateConnectorToolArguments(
	toolName: ConnectorToolName,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const parsed = connectorArgumentsSchema.safeParse(args);
	if (!parsed.success) {
		throw validationError(toolName, "arguments must be a JSON object");
	}
	for (const key of Object.keys(parsed.data)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) {
			// The key is not echoed: it may itself be the attempted secret.
			throw validationError(
				toolName,
				"arguments contain a credential-shaped key",
			);
		}
	}
	// Same JSON caps the queue enforces, applied before the device is woken.
	assertBoundedDeviceJson(
		parsed.data,
		"connector tool arguments",
		CONNECTOR_CALL_MAX_PARAMS_BYTES,
	);
	return JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>;
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

			const call = await deps.calls.enqueue({
				organizationId,
				deviceId: target.deviceId,
				credentialId: target.credentialId,
				taskId: context.taskId,
				connectorId,
				toolName,
				params,
				ttlMs: timings.ttlMs,
			});

			const outcome: ConnectorCallOutcome | null = await deps.calls.awaitResult(
				call.id,
				timings.awaitTimeoutMs,
				timings.pollMs,
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
