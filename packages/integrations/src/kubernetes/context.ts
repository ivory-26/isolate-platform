import { createHash } from "node:crypto";
import {
	type ContextBundle,
	type ContextItem,
	contextBundleSchema,
	contextItemSchema,
	isBoundedHttpsUrl,
	MAX_CONTEXT_EXCERPT_CHARS,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	MAX_INCIDENT_FINGERPRINT_CHARS,
	PlatformError,
} from "@isolate/shared";
import { z } from "zod";
import { redactKubernetesLine, redactKubernetesText } from "./redact";
import {
	type KubernetesDeployment,
	type KubernetesEvent,
	kubernetesDeploymentSchema,
	kubernetesEventListSchema,
	kubernetesPodSchema,
	kubernetesReplicaSetListSchema,
} from "./schemas";
import {
	assertKubernetesApiPath,
	encodeKubernetesSegment,
	KUBERNETES_NAME_PATTERN,
	KUBERNETES_NAMESPACE_PATTERN,
	KUBERNETES_OBJECT_KINDS,
	type KubernetesHttpClient,
} from "./types";

/**
 * Fixed, bounded Kubernetes context plan (docs §5).
 *
 * For one incident the reader makes at most five namespaced calls, in order:
 * Warning events for the involved object → pod status → pod log tail →
 * Deployment status → ReplicaSets for that Deployment. Nothing else is
 * fetched: never Secrets or ConfigMaps, never `pods/exec`/`attach`, never all
 * pods in the namespace, never full logs, never another namespace.
 *
 * Every excerpt is composed from allowlisted fields, redacted **before**
 * truncation, capped at 4,000 chars (logs at 2,000) and hashed over exactly
 * what the model sees. `truncated` is set when a call, item, line or field was
 * dropped. A partial bundle is valid; `403`/`404` on an optional resource only
 * drops that resource, while `401`/`403` on the core events read fails closed.
 */

export const KUBERNETES_CONTEXT_MAX_CALLS = 5;
export const KUBERNETES_CONTEXT_MAX_EVENTS = 10;
export const KUBERNETES_CONTEXT_MAX_REPLICASETS = 5;
export const KUBERNETES_CONTEXT_LOG_TAIL_LINES = 200;
export const KUBERNETES_CONTEXT_LOG_TAIL_CHARS = 2000;
export const KUBERNETES_CONTEXT_MAX_RESPONSE_BYTES = 256 * 1024;
/** Log text is cut here before parsing so one response cannot exhaust memory. */
const MAX_LOG_RESPONSE_CHARS = 64 * 1024;

const KUBERNETES_CONTEXT_ITEM_URL_MAX_CHARS = 512;

export type KubernetesContextDependencies = {
	readonly client: KubernetesHttpClient;
	/** The one namespace this connector may read (config allowlist). */
	readonly namespace: string;
	readonly clusterId?: string;
	/** Optional display-only base URL; no cluster-internal URL is ever used. */
	readonly displayUrl?: string;
	readonly now?: () => number;
	/** Clamped to 1..5; the plan can never produce more than five items. */
	readonly maxItems?: number;
};

const resourceNameSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(KUBERNETES_NAME_PATTERN);
const namespaceSchema = z
	.string()
	.min(1)
	.max(63)
	.regex(KUBERNETES_NAMESPACE_PATTERN);

const kubernetesContextInputSchema = z.strictObject({
	incidentFingerprint: z
		.string()
		.trim()
		.min(1)
		.max(MAX_INCIDENT_FINGERPRINT_CHARS),
	namespace: namespaceSchema,
	kind: z.enum(KUBERNETES_OBJECT_KINDS),
	name: resourceNameSchema,
	podName: resourceNameSchema.optional(),
	deploymentName: resourceNameSchema.optional(),
	container: z
		.string()
		.min(1)
		.max(63)
		.regex(KUBERNETES_NAMESPACE_PATTERN)
		.optional(),
	includeLogs: z.boolean().optional(),
});

export type KubernetesContextInput = z.input<
	typeof kubernetesContextInputSchema
>;

type ValidatedContextInput = z.output<typeof kubernetesContextInputSchema>;

type JsonOutcome =
	| { readonly kind: "ok"; readonly body: unknown }
	| { readonly kind: "missing" }
	| { readonly kind: "denied" }
	| { readonly kind: "failed" };

type TextOutcome =
	| { readonly kind: "ok"; readonly text: string; readonly capped: boolean }
	| { readonly kind: "missing" }
	| { readonly kind: "denied" }
	| { readonly kind: "failed" };

type ContextBudget = {
	readonly items: ContextItem[];
	usedBytes: number;
	truncated: boolean;
	readonly maxItems: number;
};

export type KubernetesReadOptions = {
	/** Core reads fail closed on `403`; optional reads drop the resource. */
	readonly core?: boolean;
	/** Explicit tool reads surface `404` as `NOT_FOUND` instead of omitting. */
	readonly failOnMissing?: boolean;
};

export type KubernetesReadResult = {
	readonly items: ContextItem[];
	readonly truncated: boolean;
};

function assertNamespaceAllowed(
	dependencies: KubernetesContextDependencies,
	namespace: string,
): string {
	if (!KUBERNETES_NAMESPACE_PATTERN.test(dependencies.namespace)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes connector namespace is invalid",
		);
	}
	if (namespace !== dependencies.namespace) {
		// Foreign namespaces are reported as absent, never as forbidden.
		throw new PlatformError(
			"NOT_FOUND",
			"kubernetes namespace is outside the configured allowlist",
		);
	}
	return namespace;
}

function displayUrlFor(
	dependencies: KubernetesContextDependencies,
	kind: string,
	namespace: string,
	name: string,
): string {
	const base = dependencies.displayUrl?.trim();
	const suffix = `${encodeKubernetesSegment(namespace)}/${kind.toLowerCase()}/${encodeKubernetesSegment(name)}`;
	// `.invalid` is reserved (RFC 2606) and never resolves, so a synthetic
	// display URL cannot leak a cluster-internal endpoint or be fetched.
	const synthetic = `https://kubernetes.invalid/${encodeKubernetesSegment(
		dependencies.clusterId?.trim() || "cluster",
	)}/${suffix}`;
	if (base !== undefined && base.length > 0) {
		const withBase = `${base.replace(/\/+$/, "")}/${suffix}`;
		if (
			withBase.length <= KUBERNETES_CONTEXT_ITEM_URL_MAX_CHARS &&
			isBoundedHttpsUrl(withBase)
		) {
			return withBase;
		}
	}
	return synthetic;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function capText(
	text: string,
	maxChars: number,
	maxBytes: number,
): { text: string; truncated: boolean } {
	let out = text;
	let truncated = false;
	if (out.length > maxChars) {
		out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
		truncated = true;
	}
	const encoder = new TextEncoder();
	while (out.length > 1 && encoder.encode(out).byteLength > maxBytes) {
		out = out.slice(0, Math.max(1, Math.floor(out.length * 0.9)));
		truncated = true;
	}
	return { text: out, truncated };
}

function fetchedAtIso(dependencies: KubernetesContextDependencies): string {
	return new Date((dependencies.now ?? (() => Date.now()))()).toISOString();
}

function makeContextItem(input: {
	sourceKind: string;
	title: string;
	excerpt: string;
	url: string;
	fetchedAt: string;
	maxChars: number;
	maxBytes: number;
}): { item: ContextItem | null; truncated: boolean } {
	const redacted = redactKubernetesText(input.excerpt);
	const capped = capText(redacted, input.maxChars, input.maxBytes);
	if (capped.text.trim().length === 0) {
		return { item: null, truncated: capped.truncated };
	}
	const candidate = {
		source: "kubernetes",
		kind: input.sourceKind.slice(0, 64),
		title: redactKubernetesLine(input.title, 200),
		url: input.url,
		excerpt: capped.text,
		fetchedAt: input.fetchedAt,
		trustLevel: "untrusted",
		sha256: sha256Hex(capped.text),
	};
	const parsed = contextItemSchema.safeParse(candidate);
	return parsed.success
		? { item: parsed.data, truncated: capped.truncated }
		: { item: null, truncated: true };
}

function appendItem(budget: ContextBudget, item: ContextItem | null): void {
	if (item === null) {
		budget.truncated = true;
		return;
	}
	if (budget.items.length >= budget.maxItems) {
		budget.truncated = true;
		return;
	}
	const bytes = new TextEncoder().encode(item.excerpt).byteLength;
	if (budget.usedBytes + bytes > MAX_CONTEXT_TOTAL_EXCERPT_BYTES) {
		budget.truncated = true;
		return;
	}
	budget.items.push(item);
	budget.usedBytes += bytes;
}

function nonEmpty(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function statusOf(
	outcome: { readonly kind: "ok" | "missing" | "denied" | "failed" },
	options: KubernetesReadOptions,
): void {
	if (outcome.kind === "missing" && options.failOnMissing === true) {
		throw new PlatformError("NOT_FOUND", "kubernetes resource was not found");
	}
	if (outcome.kind === "denied" && options.core !== false) {
		throw new PlatformError(
			"POLICY_DENIED",
			"kubernetes api access was denied (status 403)",
		);
	}
}

async function readJson(
	dependencies: KubernetesContextDependencies,
	path: string,
	query: Readonly<Record<string, string>>,
	step: string,
	options: KubernetesReadOptions = {},
): Promise<JsonOutcome> {
	assertKubernetesApiPath(path);
	let result: { status: number; body: unknown };
	try {
		result = await dependencies.client.get(path, query);
	} catch {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`${step} failed to reach the kubernetes api`,
		);
	}
	if (result.status === 401) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`${step} was rejected by the kubernetes api (status 401)`,
		);
	}
	if (result.status === 429) {
		throw new PlatformError(
			"RATE_LIMITED",
			`${step} was rate limited by the kubernetes api`,
		);
	}
	if (result.status === 403) {
		const outcome: JsonOutcome = { kind: "denied" };
		statusOf(outcome, options);
		return outcome;
	}
	if (result.status === 404) {
		const outcome: JsonOutcome = { kind: "missing" };
		statusOf(outcome, options);
		return outcome;
	}
	if (result.status < 200 || result.status >= 300) {
		return { kind: "failed" };
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(result.body);
	} catch {
		return { kind: "failed" };
	}
	if (
		new TextEncoder().encode(serialized).byteLength >
		KUBERNETES_CONTEXT_MAX_RESPONSE_BYTES
	) {
		return { kind: "failed" };
	}
	return { kind: "ok", body: result.body };
}

async function readText(
	dependencies: KubernetesContextDependencies,
	path: string,
	query: Readonly<Record<string, string>>,
	step: string,
	options: KubernetesReadOptions = {},
): Promise<TextOutcome> {
	assertKubernetesApiPath(path);
	let result: { status: number; text: string };
	try {
		result = await dependencies.client.getText(path, query);
	} catch {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`${step} failed to reach the kubernetes api`,
		);
	}
	if (result.status === 401) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			`${step} was rejected by the kubernetes api (status 401)`,
		);
	}
	if (result.status === 429) {
		throw new PlatformError(
			"RATE_LIMITED",
			`${step} was rate limited by the kubernetes api`,
		);
	}
	if (result.status === 403) {
		const outcome: TextOutcome = { kind: "denied" };
		statusOf(outcome, options);
		return outcome;
	}
	if (result.status === 404) {
		const outcome: TextOutcome = { kind: "missing" };
		statusOf(outcome, options);
		return outcome;
	}
	if (result.status < 200 || result.status >= 300) {
		return { kind: "failed" };
	}
	const text = typeof result.text === "string" ? result.text : "";
	if (text.length > MAX_LOG_RESPONSE_CHARS) {
		return {
			kind: "ok",
			text: text.slice(0, MAX_LOG_RESPONSE_CHARS),
			capped: true,
		};
	}
	return { kind: "ok", text, capped: false };
}

function eventLine(event: KubernetesEvent): string {
	const reason = nonEmpty(event.reason) ?? "Unknown";
	const count = event.count ?? 1;
	const lastSeen =
		nonEmpty(event.lastTimestamp) ??
		nonEmpty(event.eventTime) ??
		nonEmpty(event.firstTimestamp) ??
		"unknown";
	const message = redactKubernetesLine(event.message ?? "", 400);
	return message.length === 0
		? `Warning ${reason} x${count} (${lastSeen})`
		: `Warning ${reason} x${count} (${lastSeen}): ${message}`;
}

function readOptionsForContext(): KubernetesReadOptions {
	return { core: false, failOnMissing: false };
}

/** Events for one involved object; core read for a context bundle. */
export async function readKubernetesWarningEvents(
	dependencies: KubernetesContextDependencies,
	input: { namespace: string; objectName: string; limit?: number },
	options: KubernetesReadOptions = { core: true, failOnMissing: false },
): Promise<KubernetesReadResult> {
	const namespace = assertNamespaceAllowed(dependencies, input.namespace);
	const limit = Math.max(
		1,
		Math.min(input.limit ?? KUBERNETES_CONTEXT_MAX_EVENTS, 50),
	);
	const path = `/api/v1/namespaces/${encodeKubernetesSegment(namespace)}/events`;
	const outcome = await readJson(
		dependencies,
		path,
		{
			fieldSelector: `involvedObject.name=${input.objectName},type=Warning`,
			limit: "50",
		},
		"kubernetes events",
		options,
	);
	if (outcome.kind !== "ok") {
		return { items: [], truncated: true };
	}
	const parsed = kubernetesEventListSchema.safeParse(outcome.body);
	if (!parsed.success) {
		return { items: [], truncated: true };
	}
	const events = parsed.data.items.slice(0, limit);
	if (events.length === 0) {
		return {
			items: [],
			truncated: parsed.data.items.length > limit,
		};
	}
	const excerpt = events.map(eventLine).join("\n");
	const built = makeContextItem({
		sourceKind: "kubernetes_events",
		title: `Warning events for ${input.objectName}`,
		excerpt,
		url: displayUrlFor(dependencies, "events", namespace, input.objectName),
		fetchedAt: fetchedAtIso(dependencies),
		maxChars: MAX_CONTEXT_EXCERPT_CHARS,
		maxBytes: MAX_CONTEXT_EXCERPT_CHARS * 4,
	});
	return {
		items: built.item === null ? [] : [built.item],
		truncated: built.truncated || parsed.data.items.length > limit,
	};
}

function describeContainerState(
	state:
		| {
				waiting?: { reason?: string; message?: string };
				running?: { startedAt?: string | null };
				terminated?: {
					reason?: string;
					message?: string;
					exitCode?: number;
				};
		  }
		| undefined,
): string {
	if (state === undefined) return "unknown";
	if (state.waiting !== undefined) {
		const reason = nonEmpty(state.waiting.reason) ?? "Waiting";
		return `waiting:${reason}`;
	}
	if (state.terminated !== undefined) {
		const reason = nonEmpty(state.terminated.reason) ?? "Terminated";
		return `terminated:${reason}${state.terminated.exitCode === undefined ? "" : `(exit ${state.terminated.exitCode})`}`;
	}
	if (state.running !== undefined) return "running";
	return "unknown";
}

/** Pod status and container states; no spec dump, no IPs or node names. */
export async function readKubernetesPod(
	dependencies: KubernetesContextDependencies,
	input: { namespace: string; name: string },
	options: KubernetesReadOptions = { core: false, failOnMissing: false },
): Promise<KubernetesReadResult> {
	const namespace = assertNamespaceAllowed(dependencies, input.namespace);
	const path = `/api/v1/namespaces/${encodeKubernetesSegment(
		namespace,
	)}/pods/${encodeKubernetesSegment(input.name)}`;
	const outcome = await readJson(
		dependencies,
		path,
		{},
		"kubernetes pod status",
		options,
	);
	if (outcome.kind !== "ok") {
		return { items: [], truncated: true };
	}
	const parsed = kubernetesPodSchema.safeParse(outcome.body);
	if (!parsed.success) {
		return { items: [], truncated: true };
	}
	const pod = parsed.data;
	const status = pod.status;
	const lines = [`Pod: ${namespace}/${pod.metadata.name}`];
	if (status?.phase !== undefined) lines.push(`Phase: ${status.phase}`);
	for (const condition of status?.conditions ?? []) {
		const reason = nonEmpty(condition.reason);
		const message = redactKubernetesLine(condition.message ?? "", 240);
		lines.push(
			`Condition ${condition.type}=${condition.status}${reason === null ? "" : ` (${reason})`}${message.length === 0 ? "" : `: ${message}`}`,
		);
	}
	const statuses = [
		...(status?.initContainerStatuses ?? []),
		...(status?.containerStatuses ?? []),
	];
	for (const container of statuses) {
		const last = container.lastState;
		const lastTermination =
			last?.terminated === undefined
				? ""
				: ` lastTerminated=${describeContainerState(last)}`;
		lines.push(
			`Container ${container.name}: ready=${container.ready === true ? "true" : "false"} restarts=${container.restartCount ?? 0} state=${describeContainerState(container.state)}${lastTermination}`,
		);
	}
	for (const container of pod.spec?.containers ?? []) {
		const limits = container.resources?.limits;
		if (limits === undefined) continue;
		const rendered = Object.entries(limits)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => `${key}=${value}`)
			.join(", ");
		if (rendered.length > 0) {
			lines.push(`Container ${container.name} limits: ${rendered}`);
		}
	}
	const built = makeContextItem({
		sourceKind: "kubernetes_pod",
		title: `Pod ${input.name} status`,
		excerpt: lines.join("\n"),
		url: displayUrlFor(dependencies, "pod", namespace, input.name),
		fetchedAt: fetchedAtIso(dependencies),
		maxChars: MAX_CONTEXT_EXCERPT_CHARS,
		maxBytes: MAX_CONTEXT_EXCERPT_CHARS * 4,
	});
	return {
		items: built.item === null ? [] : [built.item],
		truncated: built.truncated,
	};
}

/** Bounded log tail: last 200 lines / 2,000 chars, redacted, never `follow`. */
export async function readKubernetesLogTail(
	dependencies: KubernetesContextDependencies,
	input: {
		namespace: string;
		podName: string;
		container?: string;
		tailLines?: number;
		sinceSeconds?: number;
	},
	options: KubernetesReadOptions = { core: false, failOnMissing: false },
): Promise<KubernetesReadResult> {
	const namespace = assertNamespaceAllowed(dependencies, input.namespace);
	const tailLines = Math.max(
		1,
		Math.min(
			input.tailLines ?? KUBERNETES_CONTEXT_LOG_TAIL_LINES,
			KUBERNETES_CONTEXT_LOG_TAIL_LINES,
		),
	);
	const sinceSeconds = Math.max(60, Math.min(input.sinceSeconds ?? 3600, 3600));
	const path = `/api/v1/namespaces/${encodeKubernetesSegment(
		namespace,
	)}/pods/${encodeKubernetesSegment(input.podName)}/log`;
	const query: Record<string, string> = {
		tailLines: String(tailLines),
		timestamps: "true",
		sinceSeconds: String(sinceSeconds),
	};
	if (input.container !== undefined) query.container = input.container;
	const outcome = await readText(
		dependencies,
		path,
		query,
		"kubernetes pod logs",
		options,
	);
	if (outcome.kind !== "ok") {
		return { items: [], truncated: true };
	}
	const redacted = redactKubernetesText(outcome.text).replace(/\r?\n$/, "");
	const lines = redacted.split(/\r?\n/);
	const kept = lines.slice(-tailLines);
	const joined = kept.join("\n");
	const capped = capText(
		joined,
		KUBERNETES_CONTEXT_LOG_TAIL_CHARS,
		KUBERNETES_CONTEXT_LOG_TAIL_CHARS * 4,
	);
	const built = makeContextItem({
		sourceKind: "kubernetes_logs",
		title: `Pod ${input.podName} log tail`,
		excerpt: capped.text,
		url: displayUrlFor(dependencies, "pod", namespace, input.podName),
		fetchedAt: fetchedAtIso(dependencies),
		maxChars: KUBERNETES_CONTEXT_LOG_TAIL_CHARS,
		maxBytes: KUBERNETES_CONTEXT_LOG_TAIL_CHARS * 4,
	});
	return {
		items: built.item === null ? [] : [built.item],
		truncated:
			built.truncated ||
			outcome.capped ||
			lines.length > tailLines ||
			capped.truncated,
	};
}

async function readDeploymentForContext(
	dependencies: KubernetesContextDependencies,
	input: { namespace: string; name: string },
	options: KubernetesReadOptions,
): Promise<{
	items: ContextItem[];
	truncated: boolean;
	deployment: KubernetesDeployment | null;
}> {
	const namespace = assertNamespaceAllowed(dependencies, input.namespace);
	const path = `/apis/apps/v1/namespaces/${encodeKubernetesSegment(
		namespace,
	)}/deployments/${encodeKubernetesSegment(input.name)}`;
	const outcome = await readJson(
		dependencies,
		path,
		{},
		"kubernetes deployment status",
		options,
	);
	if (outcome.kind !== "ok") {
		return { items: [], truncated: true, deployment: null };
	}
	const parsed = kubernetesDeploymentSchema.safeParse(outcome.body);
	if (!parsed.success) {
		return { items: [], truncated: true, deployment: null };
	}
	const deployment = parsed.data;
	const status = deployment.status;
	const desired = deployment.spec?.replicas ?? status?.replicas ?? 0;
	const lines = [
		`Deployment: ${namespace}/${deployment.metadata.name}`,
		`Replicas: desired=${desired} ready=${status?.readyReplicas ?? 0} available=${status?.availableReplicas ?? 0} unavailable=${status?.unavailableReplicas ?? 0} updated=${status?.updatedReplicas ?? 0}`,
	];
	if (
		status?.observedGeneration !== undefined &&
		deployment.metadata.generation !== undefined &&
		status.observedGeneration !== deployment.metadata.generation
	) {
		lines.push(
			`Observed generation: ${status.observedGeneration} (generation ${deployment.metadata.generation})`,
		);
	}
	for (const condition of status?.conditions ?? []) {
		const reason = nonEmpty(condition.reason);
		const message = redactKubernetesLine(condition.message ?? "", 240);
		lines.push(
			`Condition ${condition.type}=${condition.status}${reason === null ? "" : ` (${reason})`}${message.length === 0 ? "" : `: ${message}`}`,
		);
	}
	const built = makeContextItem({
		sourceKind: "kubernetes_deployment",
		title: `Deployment ${input.name} status`,
		excerpt: lines.join("\n"),
		url: displayUrlFor(dependencies, "deployment", namespace, input.name),
		fetchedAt: fetchedAtIso(dependencies),
		maxChars: MAX_CONTEXT_EXCERPT_CHARS,
		maxBytes: MAX_CONTEXT_EXCERPT_CHARS * 4,
	});
	return {
		items: built.item === null ? [] : [built.item],
		truncated: built.truncated,
		deployment,
	};
}

/** Deployment status for the explicit tool surface. */
export async function readKubernetesDeployment(
	dependencies: KubernetesContextDependencies,
	input: { namespace: string; name: string },
	options: KubernetesReadOptions = { core: false, failOnMissing: true },
): Promise<KubernetesReadResult> {
	const result = await readDeploymentForContext(dependencies, input, options);
	return { items: result.items, truncated: result.truncated };
}

/**
 * ReplicaSets owned by one Deployment; selector labels only, image and
 * revision annotations only. At most five of the twenty requested.
 */
export async function readKubernetesReplicaSets(
	dependencies: KubernetesContextDependencies,
	input: {
		namespace: string;
		deploymentName: string;
		selectorLabels?: Readonly<Record<string, string>>;
	},
	options: KubernetesReadOptions = { core: false, failOnMissing: false },
): Promise<KubernetesReadResult> {
	const namespace = assertNamespaceAllowed(dependencies, input.namespace);
	const labels = Object.entries(input.selectorLabels ?? {})
		.sort(([left], [right]) => left.localeCompare(right))
		.slice(0, 8);
	if (labels.length === 0) {
		// Without the Deployment selector, listing ReplicaSets would widen the
		// read to the namespace; omit instead.
		return { items: [], truncated: false };
	}
	const path = `/apis/apps/v1/namespaces/${encodeKubernetesSegment(
		namespace,
	)}/replicasets`;
	const outcome = await readJson(
		dependencies,
		path,
		{
			labelSelector: labels.map(([key, value]) => `${key}=${value}`).join(","),
			limit: "20",
		},
		"kubernetes replicasets",
		options,
	);
	if (outcome.kind !== "ok") {
		return { items: [], truncated: true };
	}
	const parsed = kubernetesReplicaSetListSchema.safeParse(outcome.body);
	if (!parsed.success) {
		return { items: [], truncated: true };
	}
	const replicaSets = parsed.data.items
		.filter((replicaSet) => {
			const owners = replicaSet.metadata.ownerReferences;
			if (owners === undefined || owners.length === 0) return true;
			return owners.some(
				(owner) =>
					owner.kind === "Deployment" && owner.name === input.deploymentName,
			);
		})
		.slice(0, KUBERNETES_CONTEXT_MAX_REPLICASETS);
	if (replicaSets.length === 0) {
		return {
			items: [],
			truncated: parsed.data.items.length > KUBERNETES_CONTEXT_MAX_REPLICASETS,
		};
	}
	const lines = replicaSets.map((replicaSet) => {
		const revision =
			replicaSet.metadata.annotations?.["deployment.kubernetes.io/revision"];
		const images = (replicaSet.spec?.template?.spec?.containers ?? [])
			.map((container) => container.image ?? container.name)
			.slice(0, 4)
			.join(", ");
		return `ReplicaSet ${replicaSet.metadata.name}: revision=${revision ?? "unknown"} ready=${replicaSet.status?.readyReplicas ?? 0}/${replicaSet.spec?.replicas ?? 0} available=${replicaSet.status?.availableReplicas ?? 0}${images.length === 0 ? "" : ` images=${images}`}`;
	});
	const built = makeContextItem({
		sourceKind: "kubernetes_replicasets",
		title: `ReplicaSets for deployment/${input.deploymentName}`,
		excerpt: lines.join("\n"),
		url: displayUrlFor(
			dependencies,
			"deployment",
			namespace,
			input.deploymentName,
		),
		fetchedAt: fetchedAtIso(dependencies),
		maxChars: MAX_CONTEXT_EXCERPT_CHARS,
		maxBytes: MAX_CONTEXT_EXCERPT_CHARS * 4,
	});
	return {
		items: built.item === null ? [] : [built.item],
		truncated:
			built.truncated ||
			parsed.data.items.length > KUBERNETES_CONTEXT_MAX_REPLICASETS,
	};
}

/**
 * Fixed five-call plan over the injected read-only client. Throws only
 * `PlatformError` with a fixed message; no response body, token, header or
 * cluster-internal URL is ever part of an error.
 */
export async function fetchKubernetesContext(
	dependencies: KubernetesContextDependencies,
	input: KubernetesContextInput,
): Promise<ContextBundle> {
	const parsed = kubernetesContextInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes context input is invalid",
		);
	}
	const value: ValidatedContextInput = parsed.data;
	const namespace = assertNamespaceAllowed(dependencies, value.namespace);
	const contextOptions: KubernetesReadOptions = readOptionsForContext();
	const budget: ContextBudget = {
		items: [],
		usedBytes: 0,
		truncated: false,
		maxItems: Math.max(
			1,
			Math.min(
				dependencies.maxItems ?? KUBERNETES_CONTEXT_MAX_CALLS,
				KUBERNETES_CONTEXT_MAX_CALLS,
			),
		),
	};
	// The events read below is the first call of the five-call plan.
	let calls = 1;
	const takeCall = (): boolean => {
		if (calls >= KUBERNETES_CONTEXT_MAX_CALLS) {
			budget.truncated = true;
			return false;
		}
		calls += 1;
		return true;
	};

	// 1. Warning events for the involved object (core read).
	const events = await readKubernetesWarningEvents(
		dependencies,
		{ namespace, objectName: value.name },
		{ core: true, failOnMissing: false },
	);
	if (events.truncated) budget.truncated = true;
	for (const item of events.items) appendItem(budget, item);

	const podName =
		value.podName ?? (value.kind === "Pod" ? value.name : undefined);
	const deploymentName =
		value.deploymentName ??
		(value.kind === "Deployment" ? value.name : undefined);

	// 2. Pod status, if the concrete pod still exists.
	if (podName !== undefined && takeCall()) {
		const pod = await readKubernetesPod(
			dependencies,
			{ namespace, name: podName },
			contextOptions,
		);
		if (pod.truncated) budget.truncated = true;
		for (const item of pod.items) appendItem(budget, item);

		// 3. Bounded log tail for the same pod.
		if (value.includeLogs !== false && takeCall()) {
			const logs = await readKubernetesLogTail(
				dependencies,
				{
					namespace,
					podName,
					...(value.container === undefined
						? {}
						: { container: value.container }),
				},
				contextOptions,
			);
			if (logs.truncated) budget.truncated = true;
			for (const item of logs.items) appendItem(budget, item);
		}
	}

	// 4. Deployment status, then 5. its ReplicaSets.
	if (deploymentName !== undefined && takeCall()) {
		const deployment = await readDeploymentForContext(
			dependencies,
			{ namespace, name: deploymentName },
			contextOptions,
		);
		if (deployment.truncated) budget.truncated = true;
		for (const item of deployment.items) appendItem(budget, item);

		if (deployment.deployment !== null && takeCall()) {
			const replicaSets = await readKubernetesReplicaSets(
				dependencies,
				{
					namespace,
					deploymentName,
					selectorLabels: deployment.deployment.spec?.selector?.matchLabels,
				},
				contextOptions,
			);
			if (replicaSets.truncated) budget.truncated = true;
			for (const item of replicaSets.items) appendItem(budget, item);
		}
	}

	const bundle = {
		incidentFingerprint: value.incidentFingerprint,
		items: budget.items.slice(0, MAX_CONTEXT_ITEMS),
		truncated: budget.truncated,
	};
	const validated = contextBundleSchema.safeParse(bundle);
	if (!validated.success) {
		throw new PlatformError(
			"INTEGRATION_UNAVAILABLE",
			"kubernetes context bundle violated the shared contract",
		);
	}
	return validated.data;
}
