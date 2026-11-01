import {
	createKubernetesReadTools,
	fetchKubernetesContext,
	type KubernetesContextDependencies,
	type KubernetesHttpClient,
	type KubernetesToolName,
} from "@isolate/integrations";
import {
	type Env,
	type KubernetesVendorConfig,
	resolveSecret,
} from "../config";
import type { ToolHandler } from "../contracts";
import {
	canonicalKubernetesKind,
	parseContextFingerprint,
	readContextParams,
} from "./context";
import { failure, runAdapter } from "./shared";

export type KubernetesClientOptions = {
	apiUrl: string;
	serviceAccountTokenFile: string;
	caFile?: string;
	timeoutMs?: number;
};

export type KubernetesClientFactory = (
	options: KubernetesClientOptions,
) => KubernetesHttpClient;

/**
 * Kubernetes handlers. The API URL and namespace are configuration, not tool
 * input: the adapter rejects a call for any other namespace as NOT_FOUND before
 * an API request. The token and CA are read from files named by the daemon's
 * own environment at call time.
 */
export function createKubernetesHandlers(
	config: KubernetesVendorConfig,
	env: Env,
	clientFactory: KubernetesClientFactory,
): Record<string, ToolHandler> {
	const dependencies = (): KubernetesContextDependencies | null => {
		const tokenFile = resolveSecret(
			config.secretEnv,
			"serviceAccountTokenFile",
			env,
		);
		if (tokenFile === null) return null;
		const caFile = resolveSecret(config.secretEnv, "caFile", env);
		const apiUrl = config.apiUrl ?? env.KUBERNETES_API_URL?.trim();
		const namespace = config.namespace ?? env.KUBERNETES_NAMESPACE?.trim();
		if (
			apiUrl === undefined ||
			apiUrl.length === 0 ||
			namespace === undefined ||
			namespace.length === 0
		) {
			return null;
		}
		let client: KubernetesHttpClient;
		try {
			client = clientFactory({
				apiUrl,
				serviceAccountTokenFile: tokenFile,
				...(caFile === null ? {} : { caFile }),
				...(config.timeoutMs === undefined
					? {}
					: { timeoutMs: config.timeoutMs }),
			});
		} catch {
			return null;
		}
		return {
			client,
			namespace,
			displayUrl: apiUrl,
			...(config.clusterId === undefined
				? {}
				: { clusterId: config.clusterId }),
		};
	};

	const handlerFor =
		(toolName: KubernetesToolName): ToolHandler =>
		async (params) => {
			const deps = dependencies();
			if (deps === null) return failure("INTEGRATION_UNAVAILABLE");
			const tool = createKubernetesReadTools(deps).find(
				(candidate) => candidate.name === toolName,
			);
			if (tool === undefined) return failure("VALIDATION_FAILED");
			return runAdapter(() => tool.execute(params));
		};

	return {
		"k8s.list_events": handlerFor("k8s.list_events"),
		"k8s.get_pod": handlerFor("k8s.get_pod"),
		"k8s.get_deployment": handlerFor("k8s.get_deployment"),
		"k8s.logs_tail": handlerFor("k8s.logs_tail"),
		"k8s.context.fetch": async (params) => {
			const parsed = readContextParams(params);
			if (parsed === null) return failure("VALIDATION_FAILED");
			const ref = parseContextFingerprint(
				parsed.incidentFingerprint,
				"kubernetes",
			);
			if (ref === null) return failure("VALIDATION_FAILED");
			const fingerprintKind = canonicalKubernetesKind(ref.kind);
			const requestedKind =
				parsed.kind === undefined ? null : canonicalKubernetesKind(parsed.kind);
			if (parsed.kind !== undefined && requestedKind === null) {
				return failure("VALIDATION_FAILED");
			}
			if (
				requestedKind !== null &&
				fingerprintKind !== null &&
				requestedKind !== fingerprintKind
			) {
				return failure("VALIDATION_FAILED");
			}
			const kind = requestedKind ?? fingerprintKind;
			if (kind === null) return failure("VALIDATION_FAILED");
			const deps = dependencies();
			if (deps === null) return failure("INTEGRATION_UNAVAILABLE");
			return runAdapter(() =>
				fetchKubernetesContext(deps, {
					incidentFingerprint: parsed.incidentFingerprint,
					namespace: ref.namespace,
					kind,
					name: ref.name,
					...(kind === "Pod" ? { podName: ref.name } : {}),
					includeLogs: true,
				}),
			);
		},
	};
}
