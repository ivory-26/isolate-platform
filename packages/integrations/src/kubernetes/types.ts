import { PlatformError } from "@isolate/shared";
import { z } from "zod";

/**
 * Kubernetes connector contracts (read-only context plane).
 *
 * Kubernetes has no native inbound webhook: the API server authenticates the
 * *client* and never signs events. Trigger signals therefore arrive through
 * Alertmanager/Prometheus rules or the signed generic webhook bridge; this
 * module only reads cluster state for an already-open incident.
 *
 * The API server is reached through an injected `KubernetesHttpClient` so tests
 * never touch the network. The client is constructed server-side from a
 * ServiceAccount token **file** and the cluster CA **file**; a kubeconfig is
 * deliberately unsupported and rejected here. The sandbox never receives the
 * token, a CA file, a kubeconfig or a proxy.
 */

/** Query parameters for one API read; values are encoded by the client. */
export type KubernetesQuery = Readonly<Record<string, string>>;

/** JSON read result. A non-2xx status is returned, never thrown. */
export type KubernetesJsonResult = {
	readonly status: number;
	readonly body: unknown;
};

/** Text read result (pod logs). A non-2xx status is returned, never thrown. */
export type KubernetesTextResult = {
	readonly status: number;
	readonly text: string;
};

/**
 * Injected transport. Implementations build the https URL from
 * `KubernetesConnectorConfig.apiUrl`, add the `Authorization` header from the
 * token file at call time, enforce a timeout, and never log the header.
 *
 * `path` is a relative API path (`/api/v1/...` or `/apis/apps/v1/...`) that the
 * adapter validates before calling; it is never a model-authored URL.
 */
export interface KubernetesHttpClient {
	get(path: string, query?: KubernetesQuery): Promise<KubernetesJsonResult>;
	getText(path: string, query?: KubernetesQuery): Promise<KubernetesTextResult>;
}

/** RFC 1123 DNS label: namespaces, container names. */
export const KUBERNETES_NAMESPACE_PATTERN =
	/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** RFC 1123 subdomain: most object names (pods, deployments, ...). */
export const KUBERNETES_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** Stable cluster label; no slashes or whitespace so it is key-safe. */
export const KUBERNETES_CLUSTER_ID_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The object kinds the read-only connector serves. Nodes are out of scope. */
export const KUBERNETES_OBJECT_KINDS = [
	"Pod",
	"Deployment",
	"ReplicaSet",
	"StatefulSet",
	"Job",
] as const;
export type KubernetesObjectKind = (typeof KUBERNETES_OBJECT_KINDS)[number];

/**
 * Server-side configuration. Paths are file paths, never values: the token is
 * file-based by design and no inline token or kubeconfig field exists.
 */
export const kubernetesConnectorConfigSchema = z
	.strictObject({
		apiUrl: z
			.string()
			.trim()
			.max(512)
			.refine(
				(value) => isBoundedKubernetesApiUrl(value),
				"https apiUrl without credentials required",
			),
		namespace: z.string().regex(KUBERNETES_NAMESPACE_PATTERN),
		clusterId: z
			.string()
			.regex(KUBERNETES_CLUSTER_ID_PATTERN)
			.optional()
			.default("cluster"),
		caFile: z
			.string()
			.trim()
			.min(1)
			.max(512)
			.refine((value) => !/[\r\n]/.test(value), "file path must be one line")
			.optional(),
		serviceAccountTokenFile: z
			.string()
			.trim()
			.min(1)
			.max(512)
			.refine((value) => !/[\r\n]/.test(value), "file path must be one line")
			.optional(),
	})
	.strict();

export type KubernetesConnectorConfig = z.output<
	typeof kubernetesConnectorConfigSchema
>;

/** Docs names, exported for operators; values are never read here. */
export const KUBERNETES_CONFIG_ENV_NAMES = [
	"KUBERNETES_API_URL",
	"KUBERNETES_NAMESPACE",
	"KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE",
	"KUBERNETES_CA_FILE",
	"KUBERNETES_CLUSTER_ID",
] as const;

/** Operator-only bridge secret name; the adapter never resolves a value. */
export const KUBERNETES_WEBHOOK_SECRET_ENV_NAME = "KUBERNETES_WEBHOOK_SECRET";

/** `https:` only, no embedded credentials, no query or fragment. */
export function isBoundedKubernetesApiUrl(value: string): boolean {
	if (value.length === 0 || value.length > 512) return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

/**
 * Parses server-side configuration. A kubeconfig, an inline token or any
 * unknown key is rejected (`VALIDATION_FAILED`) rather than ignored, so a
 * misconfiguration cannot silently fall back to broader credentials.
 */
export function parseKubernetesConnectorConfig(
	input: unknown,
): KubernetesConnectorConfig {
	const parsed = kubernetesConnectorConfigSchema.safeParse(input);
	if (!parsed.success) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes connector configuration is invalid",
		);
	}
	return parsed.data;
}

/**
 * The only API prefixes this connector may call. Secrets, ConfigMaps, exec,
 * attach, port-forward and token subresources are refused even though they
 * share the `/api/v1` prefix.
 */
const ALLOWED_API_PREFIXES = ["/api/v1/", "/apis/apps/v1/"] as const;
/** Subresources and resources the connector must never request. */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
	"secrets",
	"configmaps",
	"serviceaccounts",
	"exec",
	"attach",
	"portforward",
	"token",
	"nodes",
]);

/** True only for a relative, namespace-scoped, non-destructive API path. */
export function isKubernetesApiPath(path: string): boolean {
	if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
		return false;
	}
	if (
		path.startsWith("//") ||
		path.includes("://") ||
		path.includes("?") ||
		path.includes("#") ||
		path.includes("\\") ||
		path.includes("..")
	) {
		return false;
	}
	if (!ALLOWED_API_PREFIXES.some((prefix) => path.startsWith(prefix))) {
		return false;
	}
	const segments = path.split("/").filter((segment) => segment.length > 0);
	// Every read is namespaced: cluster-scoped nodes/events are out of scope.
	if (!path.includes("/namespaces/")) return false;
	if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
		return false;
	}
	// `/pods` (list every pod in the namespace) is never needed.
	if (segments[segments.length - 1] === "pods") return false;
	return true;
}

/** Throws `VALIDATION_FAILED` for anything that is not an allowlisted path. */
export function assertKubernetesApiPath(path: string): void {
	if (!isKubernetesApiPath(path)) {
		throw new PlatformError(
			"VALIDATION_FAILED",
			"kubernetes api path is not allowlisted",
		);
	}
}

/** Encodes one path segment; never accepts `/` inside an identifier. */
export function encodeKubernetesSegment(value: string): string {
	return encodeURIComponent(value);
}

/** True when `path` targets the pod-log subresource (read-only text). */
export function isKubernetesLogPath(path: string): boolean {
	return path.endsWith("/log");
}
