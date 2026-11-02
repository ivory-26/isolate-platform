import type { ConnectorVerifyReasonCode } from "@isolate/shared";
import type { DeviceConfig, Env, SecretLookup } from "../config";
import type { DispatchOutcome, ToolHandler } from "../contracts";
import { resolveAxiomSettings } from "./axiom";
import { resolveDatadogSettings } from "./datadog";
import { resolveGrafanaSettings } from "./grafana";
import { resolveHoneycombSettings } from "./honeycomb";
import {
	type KubernetesClientFactory,
	resolveKubernetesSettings,
} from "./kubernetes";
import { resolveNewRelicSettings } from "./newrelic";
import { resolvePagerDutyReadSettings } from "./pagerduty";
import { resolveSentrySettings } from "./sentry";
import { resolveSignozSettings } from "./signoz";

/**
 * `connector.verify` — one cheap authenticated read per pairing/refresh.
 *
 * The server enqueues this internal call after pairing (the model cannot request
 * it). The relay resolves exactly the same effective settings and secret as the
 * vendor tools, performs **one** bounded provider request and reduces the
 * result to `{ verified, reasonCode }`. A provider rejection is a successful
 * device call with `verified: false`, so the server can mark the credential
 * `invalid` instead of treating every non-2xx as a transport failure.
 *
 * Hard rules:
 * - 5 s timeout, `redirect: "error"`, at most 64 KiB of body read and discarded;
 * - no URL, header, token, body or provider text ever appears in the result;
 * - missing secret or selector, or a malformed stored selector, is
 *   `CONFIG_REQUIRED` before any request.
 */

export const CONNECTOR_VERIFY_TIMEOUT_MS = 5_000;
export const CONNECTOR_VERIFY_MAX_BODY_BYTES = 64 * 1024;

const SENTRY_DEFAULT_ORIGIN = "https://sentry.io";
const PAGERDUTY_DEFAULT_ORIGIN = "https://api.pagerduty.com";
const NEWRELIC_DEFAULT_ENDPOINT = "https://api.newrelic.com/graphql";
const HONEYCOMB_DEFAULT_ORIGIN = "https://api.honeycomb.io";

type ProbeResult =
	| { readonly kind: "status"; readonly status: number }
	| { readonly kind: "network" };

type RequestOptions = {
	readonly method?: "GET" | "POST";
	readonly headers: Record<string, string>;
	readonly body?: string;
};

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Reads at most the body cap and throws the bytes away. The response is never
 * parsed, so provider text cannot reach a log or the result envelope.
 */
async function discardBoundedBody(response: Response): Promise<void> {
	if (response.body === null) {
		await response.arrayBuffer().catch(() => undefined);
		return;
	}
	const reader = response.body.getReader();
	let total = 0;
	let finished = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				finished = true;
				break;
			}
			total += next.value.byteLength;
			if (total >= CONNECTOR_VERIFY_MAX_BODY_BYTES) break;
		}
	} catch {
		// A body read failure after headers does not change the verdict.
	} finally {
		if (!finished) await reader.cancel().catch(() => undefined);
	}
}

async function requestStatus(
	url: string,
	options: RequestOptions,
	fetchImpl: typeof fetch,
): Promise<ProbeResult> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			...(options.body === undefined ? {} : { body: options.body }),
			redirect: "error",
			signal: AbortSignal.timeout(CONNECTOR_VERIFY_TIMEOUT_MS),
		});
	} catch {
		return { kind: "network" };
	}
	await discardBoundedBody(response);
	return { kind: "status", status: response.status };
}

function reasonFromStatus(status: number): ConnectorVerifyReasonCode {
	if (status >= 200 && status < 300) return "OK";
	if (status === 401 || status === 403) return "AUTH_FAILED";
	if (status === 404) return "CONFIG_REQUIRED";
	if (status === 429) return "RATE_LIMITED";
	// Other 4xx, redirects and 5xx are provider outcomes, not transport errors.
	return "PROVIDER_ERROR";
}

function verified(): DispatchOutcome {
	return { ok: true, data: { verified: true, reasonCode: "OK" } };
}

function unverified(reasonCode: ConnectorVerifyReasonCode): DispatchOutcome {
	return { ok: true, data: { verified: false, reasonCode } };
}

function configurationRequired(): DispatchOutcome {
	return unverified("CONFIG_REQUIRED");
}

function resultOutcome(result: ProbeResult): DispatchOutcome {
	if (result.kind === "network") return unverified("UNREACHABLE");
	const reasonCode = reasonFromStatus(result.status);
	return reasonCode === "OK" ? verified() : unverified(reasonCode);
}

export type ConnectorVerifyOptions = {
	readonly config: DeviceConfig;
	readonly env: Env;
	readonly fetchImpl: typeof fetch;
	readonly kubernetesClientFactory: KubernetesClientFactory;
	readonly secretStore?: SecretLookup;
};

/**
 * Builds the single `connector.verify` handler. The connector id comes from the
 * authenticated call, never from a tool parameter; an unknown id is
 * `CONFIG_REQUIRED` without a request.
 */
export function createConnectorVerifyHandler(
	options: ConnectorVerifyOptions,
): ToolHandler {
	const { config, env, fetchImpl, kubernetesClientFactory, secretStore } =
		options;

	return async (_params, context) => {
		const credentialRef = context.credentialRef;
		switch (context.connectorId) {
			case "sentry": {
				const settings = resolveSentrySettings(
					config.vendors.sentry,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				const baseUrl = settings.deps.baseUrl ?? SENTRY_DEFAULT_ORIGIN;
				return resultOutcome(
					await requestStatus(
						joinUrl(baseUrl, "/api/0/organizations/?limit=1"),
						{
							headers: {
								accept: "application/json",
								authorization: `Bearer ${settings.deps.token}`,
							},
						},
						fetchImpl,
					),
				);
			}
			case "grafana": {
				const settings = resolveGrafanaSettings(
					config.vendors.grafana,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				const headers: Record<string, string> = {
					accept: "application/json",
					authorization: `Bearer ${settings.deps.token}`,
				};
				const orgId = settings.deps.orgId;
				if (orgId !== undefined && orgId !== null && String(orgId).length > 0) {
					headers["x-grafana-org-id"] = String(orgId);
				}
				return resultOutcome(
					await requestStatus(
						joinUrl(settings.deps.baseUrl, "/api/datasources?limit=1"),
						{ headers },
						fetchImpl,
					),
				);
			}
			case "pagerduty": {
				const settings = resolvePagerDutyReadSettings(
					config.vendors.pagerduty,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				const baseUrl = settings.deps.baseUrl ?? PAGERDUTY_DEFAULT_ORIGIN;
				return resultOutcome(
					await requestStatus(
						joinUrl(baseUrl, "/users/me"),
						{
							headers: {
								accept: "application/vnd.pagerduty+json;version=2",
								authorization: `Token token=${settings.deps.token}`,
							},
						},
						fetchImpl,
					),
				);
			}
			case "kubernetes": {
				const settings = resolveKubernetesSettings(
					config.vendors.kubernetes,
					env,
					kubernetesClientFactory,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				try {
					const response = await settings.deps.client.get(
						`/api/v1/namespaces/${encodeURIComponent(settings.deps.namespace)}/events`,
						{ limit: "1" },
					);
					return resultOutcome({
						kind: "status",
						status: response.status,
					});
				} catch {
					return unverified("UNREACHABLE");
				}
			}
			case "datadog": {
				const settings = resolveDatadogSettings(
					config.vendors.datadog,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				return resultOutcome(
					await requestStatus(
						joinUrl(settings.deps.baseUrl, "/api/v1/validate"),
						{
							headers: {
								accept: "application/json",
								"DD-API-KEY": settings.deps.apiKey,
								"DD-APPLICATION-KEY": settings.deps.appKey,
							},
						},
						fetchImpl,
					),
				);
			}
			case "newrelic": {
				const settings = resolveNewRelicSettings(
					config.vendors.newrelic,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				return resultOutcome(
					await requestStatus(
						settings.deps.endpoint ?? NEWRELIC_DEFAULT_ENDPOINT,
						{
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/json",
								"API-Key": settings.deps.apiKey,
							},
							body: JSON.stringify({
								query: "{ actor { user { email } } }",
							}),
						},
						fetchImpl,
					),
				);
			}
			case "honeycomb": {
				const settings = resolveHoneycombSettings(
					config.vendors.honeycomb,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				const baseUrl = settings.deps.apiBaseUrl ?? HONEYCOMB_DEFAULT_ORIGIN;
				return resultOutcome(
					await requestStatus(
						joinUrl(baseUrl, "/1/auth"),
						{
							headers: {
								accept: "application/json",
								"X-Honeycomb-Team": settings.deps.apiKey,
							},
						},
						fetchImpl,
					),
				);
			}
			case "axiom": {
				const settings = resolveAxiomSettings(
					config.vendors.axiom,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				return resultOutcome(
					await requestStatus(
						joinUrl(settings.deps.baseUrl, "/api/v1/datasets"),
						{
							headers: {
								accept: "application/json",
								authorization: `Bearer ${settings.deps.token}`,
							},
						},
						fetchImpl,
					),
				);
			}
			case "signoz": {
				const settings = resolveSignozSettings(
					config.vendors.signoz,
					env,
					fetchImpl,
					credentialRef,
					secretStore,
				);
				if (!settings.ok) return configurationRequired();
				return resultOutcome(
					await requestStatus(
						joinUrl(settings.deps.baseUrl, "/api/v1/rules"),
						{
							headers: {
								accept: "application/json",
								"SIGNOZ-API-KEY": settings.deps.apiKey,
							},
						},
						fetchImpl,
					),
				);
			}
			default:
				return configurationRequired();
		}
	};
}
