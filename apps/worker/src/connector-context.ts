import {
	CONNECTOR_CALL_DEFAULT_AWAIT_TIMEOUT_MS,
	CONNECTOR_CALL_DEFAULT_TTL_MS,
	CONNECTOR_CALL_MAX_TTL_MS,
	CONNECTOR_CALL_MIN_TTL_MS,
	type ConnectorCallOutcome,
	type ConnectorCallRepository,
	clampConnectorCallAwaitOptions,
	type IncidentRepository,
} from "@isolate/db";
import {
	type ConnectorDeviceBroker,
	type ConnectorIncidentRef,
	parseConnectorIncidentFingerprint,
} from "@isolate/integrations";
import {
	type ContextBundle,
	contextBundleSchema,
	type OrganizationId,
	PlatformError,
	type TaskId,
} from "@isolate/shared";

/**
 * Bounded incident context for **non-GitHub** sources (wave 19).
 *
 * The worker never holds a provider key. For a task whose incident fingerprint
 * names a connector source (Sentry, Grafana, PagerDuty, Kubernetes, Datadog,
 * New Relic, Honeycomb, Axiom or SigNoz) it:
 * 1. parses the source-stable fingerprint (GitHub and unknown shapes yield
 *    `null`: GitHub keeps its server-side reader, everything else has no
 *    evidence path and must not be guessed),
 * 2. resolves the organization's active device + credential metadata through
 *    the `ConnectorDeviceBroker` (never a secret),
 * 3. reads the latest signal summary for `service`/`kind` (absent = no
 *    fabricated evidence),
 * 4. enqueues exactly one `<source>.context.fetch` call carrying only
 *    `{ incidentFingerprint, service, kind }`, a bounded TTL and the run's
 *    traceparent when one is available,
 * 5. awaits a tenant/device-scoped result shorter than the TTL and parses it
 *    with `contextBundleSchema`.
 *
 * Every failure (offline device, expired call, malformed or mismatched bundle,
 * broker/DB error) returns `null`: an incident task degrades to "no evidence"
 * and never fails because context could not be fetched.
 */

/** Device poll interval for `awaitResult` (the repository clamps 10–5000). */
const DEFAULT_POLL_MS = 250;

/** Fingerprints with this prefix belong to the existing GitHub reader. */
const GITHUB_FINGERPRINT_PREFIX = "github:";

type ConnectorContextSource = ConnectorIncidentRef["source"];

/**
 * Source → device tool. The queue tool name uses the adapter's short prefix
 * (`k8s` for Kubernetes); `connectorId` is the registered connector identity.
 */
export const CONNECTOR_CONTEXT_TOOLS: Readonly<
	Record<
		ConnectorContextSource,
		{ readonly connectorId: string; readonly toolName: string }
	>
> = {
	sentry: { connectorId: "sentry", toolName: "sentry.context.fetch" },
	grafana: { connectorId: "grafana", toolName: "grafana.context.fetch" },
	pagerduty: { connectorId: "pagerduty", toolName: "pagerduty.context.fetch" },
	kubernetes: { connectorId: "kubernetes", toolName: "k8s.context.fetch" },
	datadog: { connectorId: "datadog", toolName: "datadog.context.fetch" },
	newrelic: { connectorId: "newrelic", toolName: "newrelic.context.fetch" },
	honeycomb: { connectorId: "honeycomb", toolName: "honeycomb.context.fetch" },
	axiom: { connectorId: "axiom", toolName: "axiom.context.fetch" },
	signoz: { connectorId: "signoz", toolName: "signoz.context.fetch" },
};

export type ConnectorContextDependencies = {
	/** Resolves the active device and credential; never returns a secret. */
	broker: Pick<ConnectorDeviceBroker, "resolve">;
	/** Durable queue used by the worker (`connector_calls`). */
	calls: Pick<ConnectorCallRepository, "enqueue" | "awaitResult">;
	/** Latest normalized signal for `service`/`kind` (`incident_signals`). */
	signals: Pick<IncidentRepository, "getLatestSignal">;
	/** Clock seam for deterministic callers; the queue owns result timing. */
	now?: () => number;
	/** Server wait for a result; always shorter than `ttlMs`. */
	awaitTimeoutMs?: number;
	/** Call deadline on the device queue; defaults to 60 s. */
	ttlMs?: number;
	/** Poll interval passed to `awaitResult`. */
	pollMs?: number;
};

export type ConnectorContextInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	/** Source-stable fingerprint carried by the task row. */
	incidentFingerprint: string;
	/** W3C traceparent of the enqueuing run, when one exists. */
	traceparent?: string;
};

export type ConnectorContextLoader = (
	input: ConnectorContextInput,
) => Promise<ContextBundle | null>;

function resolveBoundedTimings(deps: ConnectorContextDependencies): {
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
			"connector context ttlMs is invalid",
		);
	}
	// The server must give up before the queue row expires, so a late device
	// result is never consumed after a retry window has closed.
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
 * Parses the device result with the shared bundle contract. A bundle for a
 * different fingerprint is rejected: evidence must be attributable to THIS
 * incident, never to a stale or shared call.
 */
function parseBundle(
	data: Record<string, unknown>,
	fingerprint: string,
): ContextBundle | null {
	const parsed = contextBundleSchema.safeParse(data);
	if (!parsed.success) return null;
	if (parsed.data.incidentFingerprint !== fingerprint) return null;
	return parsed.data;
}

export function createConnectorContextLoader(
	deps: ConnectorContextDependencies,
): ConnectorContextLoader {
	const timings = resolveBoundedTimings(deps);

	return async (input) => {
		try {
			const ref = parseConnectorIncidentFingerprint(input.incidentFingerprint);
			// GitHub is delegated to its server-side reader; an unknown or
			// malformed fingerprint has no evidence path here.
			if (ref === null) return null;
			const fingerprint = input.incidentFingerprint.trim();
			const organizationId = input.organizationId;
			const tool = CONNECTOR_CONTEXT_TOOLS[ref.source];

			const resolved = await deps.broker.resolve(
				organizationId,
				tool.connectorId,
			);
			// The env-fallback credential has no device row and therefore no poll
			// queue: a queue-backed context call must fail closed.
			if (resolved.deviceId === null || resolved.credentialId === null) {
				return null;
			}

			const signal = await deps.signals.getLatestSignal({
				organizationId,
				source: ref.source,
				fingerprint,
			});
			// No normalized signal means no trusted selectors; never fabricate
			// `service: "unknown"` evidence.
			if (signal === null) return null;

			const call = await deps.calls.enqueue({
				organizationId,
				deviceId: resolved.deviceId,
				credentialId: resolved.credentialId,
				taskId: input.taskId,
				connectorId: tool.connectorId,
				toolName: tool.toolName,
				// Typed selectors only; the device resolves credential/endpoint
				// locally. No secret, header or raw provider payload travels here.
				params: {
					incidentFingerprint: fingerprint,
					service: signal.service,
					kind: signal.kind,
				},
				ttlMs: timings.ttlMs,
				...(input.traceparent === undefined
					? {}
					: { traceparent: input.traceparent }),
			});

			let outcome: ConnectorCallOutcome | null;
			try {
				outcome = await deps.calls.awaitResult(
					call.id,
					timings.awaitTimeoutMs,
					timings.pollMs,
					// Tenant-scoped read: a leaked call id cannot return another
					// organization's or device's result.
					{ organizationId, deviceId: resolved.deviceId },
				);
			} catch {
				return null;
			}
			if (outcome === null || !outcome.ok) return null;
			return parseBundle(outcome.data, fingerprint);
		} catch {
			// Broker, signal store or queue failure: degrade to no context. The
			// handler logs a bounded code; nothing here can carry provider text.
			return null;
		}
	};
}

/** Fingerprint read used by the router; satisfied by `TaskRepository`. */
export interface TaskFingerprintReader {
	get(taskId: TaskId): Promise<{
		organization_id: OrganizationId;
		incident_fingerprint: string | null;
	} | null>;
}

/** The handler's context seam input (GitHub-shaped, shared by both readers). */
export type ContextBundleRequest = {
	organizationId: OrganizationId;
	taskId: TaskId;
	repositoryFullName: string;
	ref: string;
};

export type RoutedContextLoaderDependencies = {
	tasks: TaskFingerprintReader;
	/** Server-side GitHub reader; present only with a GitHub App broker. */
	github?: (input: ContextBundleRequest) => Promise<ContextBundle | null>;
	/** Device-executed connector reader; present only with the device gateway. */
	connector?: ConnectorContextLoader;
};

/**
 * Routes one incident task to exactly one context reader.
 *
 * The task row is the tenant gate and the only source of the fingerprint:
 * `github:` goes to the existing server-side reader; every other recognized
 * source goes to the device call. Without a device loader, a non-GitHub
 * fingerprint keeps the pre-wave-19 behaviour (the GitHub reader is attempted)
 * so enabling this wave never regresses an existing deployment.
 */
export function createRoutedContextLoader(
	deps: RoutedContextLoaderDependencies,
): (input: ContextBundleRequest) => Promise<ContextBundle | null> {
	return async (input) => {
		const task = await deps.tasks.get(input.taskId);
		if (task === null || task.organization_id !== input.organizationId) {
			return null;
		}
		const raw = task.incident_fingerprint;
		const fingerprint = typeof raw === "string" ? raw.trim() : "";
		if (fingerprint.length === 0) return null;
		if (fingerprint.startsWith(GITHUB_FINGERPRINT_PREFIX)) {
			return deps.github === undefined ? null : deps.github(input);
		}
		if (deps.connector !== undefined) {
			return deps.connector({
				organizationId: input.organizationId,
				taskId: input.taskId,
				incidentFingerprint: fingerprint,
			});
		}
		return deps.github === undefined ? null : deps.github(input);
	};
}
