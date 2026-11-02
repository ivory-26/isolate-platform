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
	type SecretLookup,
} from "../config";
import type { ToolHandler } from "../contracts";
import {
	canonicalKubernetesKind,
	parseContextFingerprint,
	readContextParams,
} from "./context";
import { resolveOptionalSelector, resolveRequiredSelector } from "./selectors";
import {
	failure,
	runWithSettings,
	type SettingsResult,
	settingsFailure,
	settingsOk,
} from "./shared";

export type KubernetesClientOptions = {
	apiUrl: string;
	serviceAccountTokenFile: string;
	caFile?: string;
	timeoutMs?: number;
};

export type KubernetesClientFactory = (
	options: KubernetesClientOptions,
) => KubernetesHttpClient;

function storedPath(
	secretStore: SecretLookup | undefined,
	credentialRef: string,
	field: string,
): string | null {
	// Paths, not key material: exact field names only, never the single-value
	// fallback (which would let a token path masquerade as the CA path).
	const fields = secretStore?.getFields(credentialRef) ?? null;
	const value = fields?.[field];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/**
 * Kubernetes settings. A paired credential carries the token-file path (and an
 * optional CA path) plus the API URL and namespace selectors, so no
 * `vendors.kubernetes` entry is needed. The legacy
 * `KUBERNETES_API_URL`/`KUBERNETES_NAMESPACE` env vars remain a fallback.
 */
export function resolveKubernetesSettings(
	config: KubernetesVendorConfig | undefined,
	env: Env,
	clientFactory: KubernetesClientFactory,
	credentialRef: string,
	secretStore?: SecretLookup,
): SettingsResult<KubernetesContextDependencies> {
	const tokenFile =
		storedPath(secretStore, credentialRef, "serviceAccountTokenFile") ??
		resolveSecret(config?.secretEnv, "serviceAccountTokenFile", env);
	if (tokenFile === null) return settingsFailure("CONFIG_REQUIRED");
	const caFile =
		storedPath(secretStore, credentialRef, "caFile") ??
		resolveSecret(config?.secretEnv, "caFile", env);
	const apiUrl = resolveRequiredSelector({
		connectorId: "kubernetes",
		key: "apiUrl",
		credentialRef,
		store: secretStore,
		configValue: config?.apiUrl,
		envValue: env.KUBERNETES_API_URL,
	});
	if (!apiUrl.ok) return settingsFailure(apiUrl.reason);
	const namespace = resolveRequiredSelector({
		connectorId: "kubernetes",
		key: "namespace",
		credentialRef,
		store: secretStore,
		configValue: config?.namespace,
		envValue: env.KUBERNETES_NAMESPACE,
	});
	if (!namespace.ok) return settingsFailure(namespace.reason);
	const clusterId = resolveOptionalSelector({
		connectorId: "kubernetes",
		key: "clusterId",
		credentialRef,
		store: secretStore,
		configValue: config?.clusterId,
	});
	if (!clusterId.ok) return settingsFailure(clusterId.reason);

	let client: KubernetesHttpClient;
	try {
		client = clientFactory({
			apiUrl: apiUrl.value,
			serviceAccountTokenFile: tokenFile,
			...(caFile === null ? {} : { caFile }),
			...(config?.timeoutMs === undefined
				? {}
				: { timeoutMs: config.timeoutMs }),
		});
	} catch {
		return settingsFailure("CONFIG_REQUIRED");
	}
	return settingsOk({
		client,
		namespace: namespace.value,
		displayUrl: apiUrl.value,
		...(clusterId.value === undefined ? {} : { clusterId: clusterId.value }),
	});
}

/**
 * Kubernetes handlers. The API URL and namespace are configuration, not tool
 * input: the adapter rejects a call for any other namespace as NOT_FOUND before
 * an API request.
 */
export function createKubernetesHandlers(
	config: KubernetesVendorConfig | undefined,
	env: Env,
	clientFactory: KubernetesClientFactory,
	secretStore?: SecretLookup,
): Record<string, ToolHandler> {
	const settings = (credentialRef: string) =>
		resolveKubernetesSettings(
			config,
			env,
			clientFactory,
			credentialRef,
			secretStore,
		);

	const handlerFor =
		(toolName: KubernetesToolName): ToolHandler =>
		async (params, context) => {
			const resolved = await runWithSettings(
				settings(context.credentialRef),
				(deps) => {
					const tool = createKubernetesReadTools(deps).find(
						(candidate) => candidate.name === toolName,
					);
					if (tool === undefined) {
						return Promise.resolve({ ok: false, code: "VALIDATION_FAILED" });
					}
					return tool.execute(params);
				},
			);
			return resolved;
		};

	return {
		"k8s.list_events": handlerFor("k8s.list_events"),
		"k8s.get_pod": handlerFor("k8s.get_pod"),
		"k8s.get_deployment": handlerFor("k8s.get_deployment"),
		"k8s.logs_tail": handlerFor("k8s.logs_tail"),
		"k8s.context.fetch": async (params, context) => {
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
			return runWithSettings(settings(context.credentialRef), (deps) =>
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
