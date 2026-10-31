import { createHash } from "node:crypto";
import {
	type IncidentLink,
	type IncidentSeverity,
	type IncidentSignal,
	incidentSignalSchema,
	isBoundedHttpsUrl,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	MAX_INCIDENT_LINKS,
	MAX_INCIDENT_SERVICE_CHARS,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import { z } from "zod";
import { redactKubernetesLine } from "./redact";
import { type KubernetesEvent, kubernetesEventSchema } from "./schemas";

/**
 * Event/pod/deployment condition → one bounded `IncidentSignal`.
 *
 * Kubernetes events repeat and expire after about an hour, so the fingerprint
 * is source-stable and **owner-based**: `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`.
 * A rolling update replaces `api-7c9f…` with `api-8d2e…`, but the incident is
 * still the same Deployment, so a caller that knows the owner passes it in
 * `options.owner` and the concrete pod stays in the context, not the key.
 * The event's own `metadata.uid`/`resourceVersion` are never part of the key.
 *
 * Severity is derived from `type: Warning` plus the reason map below; a
 * `Normal` event is not an incident. Production raises the bands exactly as
 * `docs/connectors/kubernetes.md` §1 proposes.
 */

export const KUBERNETES_SOURCE = "kubernetes" as const;

export type KubernetesReasonRule = {
	readonly kind: string;
	readonly severity: IncidentSeverity;
	/** Raised severity when the workload is declared production. */
	readonly productionSeverity?: IncidentSeverity;
	/** Stable fingerprint component; `ImagePull` coalesces both pull reasons. */
	readonly fingerprintReason?: string;
};

const UNKNOWN_WARNING_RULE: KubernetesReasonRule = {
	kind: "kubernetes_warning",
	severity: "medium",
};

const REASON_RULES: Readonly<Record<string, KubernetesReasonRule>> = {
	oomkilled: {
		kind: "pod_oomkilled",
		severity: "high",
		productionSeverity: "critical",
	},
	crashloopbackoff: {
		kind: "pod_crashloop",
		severity: "medium",
		productionSeverity: "high",
	},
	errImagePull: {
		kind: "image_pull_failed",
		severity: "high",
		fingerprintReason: "ImagePull",
	},
	imagepullbackoff: {
		kind: "image_pull_failed",
		severity: "high",
		fingerprintReason: "ImagePull",
	},
	errImageNeverPull: {
		kind: "image_pull_failed",
		severity: "high",
		fingerprintReason: "ImagePull",
	},
	invalidimagename: {
		kind: "image_pull_failed",
		severity: "high",
		fingerprintReason: "ImagePull",
	},
	failedscheduling: { kind: "pod_scheduling_failed", severity: "medium" },
	failedmount: { kind: "pod_volume_failed", severity: "medium" },
	failedattachvolume: { kind: "pod_volume_failed", severity: "medium" },
	unhealthy: { kind: "pod_unhealthy", severity: "medium" },
	backoff: { kind: "pod_backoff", severity: "medium" },
	evicted: { kind: "pod_evicted", severity: "high" },
	failedcreate: { kind: "workload_create_failed", severity: "medium" },
	progressdeadlineexceeded: {
		kind: "deployment_unavailable",
		severity: "high",
		productionSeverity: "high",
		fingerprintReason: "Unavailable",
	},
	replicafailure: {
		kind: "deployment_unavailable",
		severity: "medium",
		productionSeverity: "high",
		fingerprintReason: "Unavailable",
	},
	minimumreplicasunavailable: {
		kind: "deployment_unavailable",
		severity: "medium",
		productionSeverity: "high",
		fingerprintReason: "Unavailable",
	},
	unavailable: {
		kind: "deployment_unavailable",
		severity: "medium",
		productionSeverity: "high",
	},
	nodenotready: {
		kind: "node_not_ready",
		severity: "critical",
		fingerprintReason: "NotReady",
	},
};

const RULES_BY_LOWERCASE_REASON: ReadonlyMap<string, KubernetesReasonRule> =
	new Map(
		Object.entries(REASON_RULES).map(([reason, rule]) => [
			reason.toLowerCase(),
			rule,
		]),
	);

/** The mapped rule for a reason, or the default unknown-Warning rule. */
export function kubernetesReasonRule(
	reason: string | null | undefined,
): KubernetesReasonRule {
	const key = (reason ?? "").trim().toLowerCase();
	return RULES_BY_LOWERCASE_REASON.get(key) ?? UNKNOWN_WARNING_RULE;
}

/** Severity for one reason; `production` raises the documented bands. */
export function kubernetesSeverityForReason(
	reason: string | null | undefined,
	options: { production?: boolean } = {},
): IncidentSeverity {
	const rule = kubernetesReasonRule(reason);
	return options.production === true
		? (rule.productionSeverity ?? rule.severity)
		: rule.severity;
}

export type KubernetesNormalizationOptions = {
	/** Stable cluster label; defaults to `cluster`. */
	readonly cluster?: string;
	/** Namespace fallback when the event's involvedObject omits it. */
	readonly namespace?: string;
	/** Production raises CrashLoop/OOM/deployment bands. */
	readonly production?: boolean;
	/** Labels of the involved object, when the caller has them. */
	readonly labels?: Readonly<Record<string, string>>;
	/**
	 * Stable owner (Deployment/StatefulSet) supplied by the event watcher. When
	 * present it replaces the concrete pod in the fingerprint.
	 */
	readonly owner?: { readonly kind: string; readonly name: string };
	/**
	 * Display-only base URL (for example a dashboard), https, no credentials.
	 * No cluster-internal API URL is ever composed into a link.
	 */
	readonly displayUrl?: string;
	readonly receivedAt?: string;
	readonly nowMs?: number;
};

const RECEIVED_AT_SCHEMA = z.iso.datetime({ offset: true });

function boundedComponent(value: string, maxChars: number): string {
	let sanitized = "";
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127 || character === ":") {
			sanitized += "_";
		} else {
			sanitized += character;
		}
	}
	sanitized = sanitized.trim();
	return sanitized.length <= maxChars
		? sanitized
		: sanitized.slice(0, maxChars);
}

/**
 * Source-stable dedupe key:
 * `k8s:<cluster>:<ns>:<kind>/<name>:<reason>`.
 *
 * Long components keep a digest suffix so two different objects with the same
 * truncated prefix cannot silently merge.
 */
export function kubernetesIncidentFingerprint(input: {
	cluster: string;
	namespace: string;
	kind: string;
	name: string;
	reason: string;
}): string {
	const cluster = boundedComponent(input.cluster, 63) || "cluster";
	const namespace = boundedComponent(input.namespace, 63) || "default";
	const kind = boundedComponent(input.kind.toLowerCase(), 32) || "object";
	const name = boundedComponent(input.name, 100) || "unknown";
	const reason = boundedComponent(input.reason, 64) || "Unknown";
	const full = `k8s:${cluster}:${namespace}:${kind}/${name}:${reason}`;
	if (full.length <= MAX_INCIDENT_FINGERPRINT_CHARS) return full;
	const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
	return `k8s:${cluster.slice(0, 20)}:${namespace.slice(0, 20)}:${kind.slice(
		0,
		12,
	)}/${name.slice(0, 32)}:${reason.slice(0, 16)}~${digest}`;
}

/** First configured app label; the service fallback is the namespace. */
export function kubernetesServiceName(input: {
	labels?: Readonly<Record<string, string>>;
	namespace: string;
}): string {
	const labels = input.labels;
	const candidate =
		labels?.["app.kubernetes.io/name"] ??
		labels?.["app.kubernetes.io/instance"] ??
		labels?.app ??
		labels?.["k8s-app"] ??
		labels?.appLabel;
	const trimmed = typeof candidate === "string" ? candidate.trim() : "";
	const service = trimmed.length > 0 ? trimmed : input.namespace;
	return service.slice(0, MAX_INCIDENT_SERVICE_CHARS);
}

function displayLinkFor(input: {
	displayUrl?: string;
	namespace: string;
	kind: string;
	name: string;
}): IncidentLink | null {
	const base = input.displayUrl?.trim();
	if (base === undefined || base.length === 0) return null;
	const url = `${base.replace(/\/+$/, "")}/${encodeURIComponent(
		input.namespace,
	)}/${input.kind.toLowerCase()}/${encodeURIComponent(input.name)}`;
	if (!isBoundedHttpsUrl(url)) return null;
	return {
		label: `${input.kind}/${input.name}`.slice(0, 120),
		url,
	};
}

function receivedAtOf(options: KubernetesNormalizationOptions): string {
	if (typeof options.receivedAt === "string") {
		const parsed = RECEIVED_AT_SCHEMA.safeParse(options.receivedAt);
		if (parsed.success) return parsed.data;
	}
	return new Date(options.nowMs ?? Date.now()).toISOString();
}

function eventTimestamp(event: KubernetesEvent): string | null {
	const candidates = [
		event.lastTimestamp,
		event.eventTime,
		event.firstTimestamp,
		event.metadata.creationTimestamp,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim().slice(0, 64);
		}
	}
	return null;
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/**
 * Normalizes one Kubernetes Event into a bounded `IncidentSignal`, or returns
 * `null` when the event is not a Warning-level incident.
 *
 * Pure: no clock (unless no `receivedAt`/`nowMs` is supplied), no network, no
 * credential. Provider text is redacted before it reaches the signal.
 */
export function normalizeKubernetesEvent(
	event: unknown,
	options: KubernetesNormalizationOptions = {},
): IncidentSignal | null {
	const parsed = kubernetesEventSchema.safeParse(event);
	if (!parsed.success) return null;
	const value = parsed.data;
	const type = nonEmpty(value.type)?.toLowerCase();
	if (type !== undefined && type !== null && type !== "warning") return null;

	const namespace =
		nonEmpty(value.involvedObject.namespace) ?? nonEmpty(options.namespace);
	if (namespace === null) return null;

	const cluster = nonEmpty(options.cluster) ?? "cluster";
	const reason = nonEmpty(value.reason) ?? "Unknown";
	const rule = kubernetesReasonRule(reason);
	const fingerprintReason = rule.fingerprintReason ?? reason;
	const ownerKind = nonEmpty(options.owner?.kind);
	const ownerName = nonEmpty(options.owner?.name);
	const objectKind = ownerKind ?? value.involvedObject.kind;
	const objectName = ownerName ?? value.involvedObject.name;
	const severity =
		options.production === true
			? (rule.productionSeverity ?? rule.severity)
			: rule.severity;
	const count = value.count ?? 1;
	const lastSeen = eventTimestamp(value);
	const message = redactKubernetesLine(value.message ?? "", 1000);
	const service = kubernetesServiceName({
		labels: options.labels,
		namespace,
	});

	const title = [
		`${objectKind}/${objectName}`,
		`${rule.kind.replace(/_/g, " ")}`,
		`in ${namespace}`,
	]
		.join(" ")
		.slice(0, MAX_INCIDENT_TITLE_CHARS);

	const summary = [
		`Kind: ${rule.kind}`,
		`Object: ${objectKind}/${objectName}`,
		`Namespace: ${namespace}`,
		`Cluster: ${cluster}`,
		`Reason: ${redactKubernetesLine(reason, 128)}`,
		`Type: ${value.type ?? "Warning"}`,
		`Count: ${count}`,
		...(lastSeen === null ? [] : [`Last seen: ${lastSeen}`]),
		...(ownerKind === null || ownerName === null
			? []
			: [`Owner: ${ownerKind}/${ownerName}`]),
		...(message.length === 0 ? [] : [`Message: ${message}`]),
	]
		.join("\n")
		.slice(0, MAX_INCIDENT_SUMMARY_CHARS);

	const link = displayLinkFor({
		displayUrl: options.displayUrl,
		namespace,
		kind: objectKind,
		name: objectName,
	});
	const links: IncidentLink[] =
		link === null ? [] : [link].slice(0, MAX_INCIDENT_LINKS);

	const signal = {
		source: KUBERNETES_SOURCE,
		kind: rule.kind,
		severity,
		service,
		fingerprint: kubernetesIncidentFingerprint({
			cluster,
			namespace,
			kind: objectKind,
			name: objectName,
			reason: fingerprintReason,
		}),
		title,
		summary,
		links,
		receivedAt: receivedAtOf(options),
	};
	const validated = incidentSignalSchema.safeParse(signal);
	return validated.success ? validated.data : null;
}
