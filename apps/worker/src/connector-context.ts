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
 * and never fails because context could not be fetched. When an optional
 * observer is bound, the same failure also reports one bounded reason so the
 * run timeline can explain the empty evidence instead of staying silent.
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
	/**
	 * Optional bounded skip observer. Absent means skips stay silent, exactly
	 * as before this wave; a failure here never reaches the task.
	 */
	onSkip?: ConnectorContextSkipObserver;
};

export type ConnectorContextInput = {
	organizationId: OrganizationId;
	taskId: TaskId;
	/** Source-stable fingerprint carried by the task row. */
	incidentFingerprint: string;
	/** W3C traceparent of the enqueuing run, when one exists. */
	traceparent?: string;
};

/**
 * Why a connector read produced no evidence. Closed and bounded: these tokens
 * are the only thing recorded on the run timeline, so no provider text, URL,
 * header or secret can ever travel through the skip path.
 */
export type ConnectorContextSkipReason =
	| "unrecognized_fingerprint"
	| "no_device_gateway"
	| "no_device_credential"
	| "no_signal"
	| "broker_failed"
	| "call_timeout"
	| "call_failed"
	| "contract_rejected";

/**
 * Source token for a skip. A recognized fingerprint yields its adapter source;
 * anything unrecognized is `unknown`. Never a provider name, host or id.
 */
export type ConnectorContextSkipSource =
	| ConnectorIncidentRef["source"]
	| "unknown";

/** One bounded, tenant-attributed evidence-skip observation. */
export type ConnectorContextSkip = {
	readonly organizationId: OrganizationId;
	readonly taskId: TaskId;
	readonly source: ConnectorContextSkipSource;
	readonly reason: ConnectorContextSkipReason;
};

/**
 * Observes a skipped evidence read. Optional: the loader keeps its original
 * `ContextBundle | null` seam, so an unwired deployment behaves exactly as
 * before. A throw or rejection here is swallowed — the timeline is
 * observability, never a task-correctness input.
 */
export type ConnectorContextSkipObserver = (
	input: ConnectorContextSkip,
) => Promise<void> | void;

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
		/**
		 * Records why this read produced no evidence, then degrades. The
		 * observer is observability only: a throw or rejection is swallowed so
		 * a broken timeline can never turn evidence loss into a failed task.
		 */
		const reportSkip = async (reason: ConnectorContextSkipReason) => {
			if (deps.onSkip === undefined) return;
			try {
				await deps.onSkip({
					organizationId: input.organizationId,
					taskId: input.taskId,
					source:
						parseConnectorIncidentFingerprint(input.incidentFingerprint)
							?.source ?? "unknown",
					reason,
				});
			} catch {
				// Nothing here may fail the task.
			}
		};

		try {
			const ref = parseConnectorIncidentFingerprint(input.incidentFingerprint);
			// GitHub is delegated to its server-side reader; an unknown or
			// malformed fingerprint has no evidence path here.
			if (ref === null) {
				await reportSkip("unrecognized_fingerprint");
				return null;
			}
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
				await reportSkip("no_device_credential");
				return null;
			}

			const signal = await deps.signals.getLatestSignal({
				organizationId,
				source: ref.source,
				fingerprint,
			});
			// No normalized signal means no trusted selectors; never fabricate
			// `service: "unknown"` evidence.
			if (signal === null) {
				await reportSkip("no_signal");
				return null;
			}

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

			// Tenant-scoped read: a leaked call id cannot return another
			// organization's or device's result. A read failure is a queue
			// failure and falls through to the outer `broker_failed` report.
			const outcome: ConnectorCallOutcome | null = await deps.calls.awaitResult(
				call.id,
				timings.awaitTimeoutMs,
				timings.pollMs,
				{ organizationId, deviceId: resolved.deviceId },
			);
			// No result inside the bounded wait: the device never answered.
			if (outcome === null) {
				await reportSkip("call_timeout");
				return null;
			}
			// The device answered with a provider/transport failure.
			if (!outcome.ok) {
				await reportSkip("call_failed");
				return null;
			}
			const bundle = parseBundle(outcome.data, fingerprint);
			// Malformed contract data and a mismatched fingerprint are both a
			// refusal to trust evidence that is not attributable to this incident.
			if (bundle === null) {
				await reportSkip("contract_rejected");
				return null;
			}
			return bundle;
		} catch {
			// Broker, signal store or queue failure: degrade to no context. The
			// handler logs a bounded code; nothing here can carry provider text.
			await reportSkip("broker_failed");
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
	/**
	 * Optional timeline sink for a routing-level skip. A connector read reports
	 * its own reason through the loader's observer; this one covers the case
	 * where no device gateway is bound at all. A throw never affects the task.
	 */
	onSkip?: ConnectorContextSkipObserver;
};

/**
 * Records a skipped connector read on the run timeline. Evidence loss is never
 * silent; a sink failure must not break the task, so it is swallowed here.
 */
async function reportSkipped(
	deps: RoutedContextLoaderDependencies,
	input: ContextBundleRequest,
	source: ConnectorContextSkipSource,
	reason: ConnectorContextSkipReason,
): Promise<void> {
	if (deps.onSkip === undefined) return;
	try {
		await deps.onSkip({
			organizationId: input.organizationId,
			taskId: input.taskId,
			source,
			reason,
		});
	} catch {
		// Timeline is observability, not the task's correctness.
	}
}

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
			// The device loader owns its own skip reason and reports it through
			// its observer; repeating it here would double-record the event.
			return deps.connector({
				organizationId: input.organizationId,
				taskId: input.taskId,
				incidentFingerprint: fingerprint,
			});
		}
		// No device gateway bound: a recognized connector incident has no
		// evidence path at all. Record that, then keep the pre-wave-19 GitHub
		// fallback. An unrecognized shape is not a connector skip.
		const connectorFingerprint = parseConnectorIncidentFingerprint(fingerprint);
		if (connectorFingerprint !== null) {
			await reportSkipped(
				deps,
				input,
				connectorFingerprint.source,
				"no_device_gateway",
			);
		}
		return deps.github === undefined ? null : deps.github(input);
	};
}
