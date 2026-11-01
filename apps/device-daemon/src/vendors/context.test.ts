import { describe, expect, test } from "bun:test";
import { type DeviceConfig, deviceConfigSchema } from "../config";
import { DEVICE_MAX_RESULT_BYTES, type DeviceDispatcher } from "../contracts";
import { createDispatcher } from "../dispatch";
import type {
	KubernetesClientFactory,
	KubernetesClientOptions,
} from "./kubernetes";
import { boundedSuccess } from "./shared";

/**
 * Device context preloading. The server only sends a fingerprint; the daemon
 * parses it and hands the adapter a typed input. These tests use fakes only
 * (no network, no provider key beyond a dummy env value).
 */

const TOKEN = "A".repeat(43);

const allVendors = {
	sentry: { secretEnv: { token: "SENTRY_API_KEY" } },
	grafana: {
		secretEnv: { token: "GRAFANA_TOKEN" },
		baseUrl: "https://grafana.example.com",
		metricsDatasourceUid: "metrics-uid",
	},
	pagerduty: { secretEnv: { token: "PAGERDUTY_TOKEN" } },
	kubernetes: {
		secretEnv: { serviceAccountTokenFile: "K8S_TOKEN_FILE" },
		apiUrl: "https://k8s.example.com",
		namespace: "default",
	},
	datadog: {
		secretEnv: { apiKey: "DD_API_KEY", appKey: "DD_APP_KEY" },
		baseUrl: "https://api.datadoghq.com",
	},
	newrelic: {
		secretEnv: { apiKey: "NEWRELIC_API_KEY" },
		accountId: "12345",
	},
	honeycomb: {
		secretEnv: { apiKey: "HONEYCOMB_API_KEY" },
		dataset: "prod",
	},
	axiom: {
		secretEnv: { token: "AXIOM_TOKEN" },
		baseUrl: "https://api.axiom.co",
		dataset: "prod",
	},
	signoz: {
		secretEnv: { apiKey: "SIGNOZ_API_KEY" },
		baseUrl: "https://signoz.example.com",
	},
} as const;

const allEnv = {
	SENTRY_API_KEY: "dummy-sentry",
	GRAFANA_TOKEN: "dummy-grafana",
	PAGERDUTY_TOKEN: "dummy-pagerduty",
	K8S_TOKEN_FILE: "/tmp/unused-token",
	DD_API_KEY: "dummy-dd-api",
	DD_APP_KEY: "dummy-dd-app",
	NEWRELIC_API_KEY: "dummy-newrelic",
	HONEYCOMB_API_KEY: "dummy-honeycomb",
	AXIOM_TOKEN: "dummy-axiom",
	SIGNOZ_API_KEY: "dummy-signoz",
};

function baseConfig(overrides: Record<string, unknown> = {}): DeviceConfig {
	return deviceConfigSchema.parse({
		serverUrl: "https://isolate.example.com",
		deviceTokenEnv: "ISOLATE_DEVICE_TOKEN",
		vendors: allVendors,
		...overrides,
	});
}

function call(toolName: string, params: Record<string, unknown>) {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		connectorId: toolName.split(".")[0] ?? "sentry",
		credentialRef: "keychain:isolate/test",
		toolName,
		params,
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	};
}

type RecordedRequest = { url: string; body: string };

function recordingFetch() {
	const requests: RecordedRequest[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({
			url: String(input),
			body: typeof init?.body === "string" ? init.body : "",
		});
		return Response.json({});
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function recordingKubernetesClient() {
	const paths: string[] = [];
	const factory: KubernetesClientFactory = (
		_options: KubernetesClientOptions,
	) => ({
		async get(path) {
			paths.push(path);
			return { status: 404, body: {} };
		},
		async getText(path) {
			paths.push(path);
			return { status: 404, text: "" };
		},
	});
	return { factory, paths };
}

function dispatched(
	fetchImpl: typeof fetch,
	kubernetesClientFactory?: KubernetesClientFactory,
): DeviceDispatcher {
	return createDispatcher({
		config: baseConfig(),
		env: { ...allEnv, ISOLATE_DEVICE_TOKEN: TOKEN },
		fetchImpl,
		...(kubernetesClientFactory === undefined
			? {}
			: { kubernetesClientFactory }),
	});
}

type VendorCase = {
	readonly tool: string;
	readonly fingerprint: string;
	readonly service?: string;
	readonly kind?: string;
	readonly selector: string;
};

const VENDOR_CASES: readonly VendorCase[] = [
	{
		tool: "sentry.context.fetch",
		fingerprint: "sentry:acme:web:42",
		selector: "/issues/42/",
	},
	{
		tool: "grafana.context.fetch",
		fingerprint: "grafana:rule-1:abcdef0123456789",
		service: "checkout",
		selector: "alert-rules/rule-1",
	},
	{
		tool: "pagerduty.context.fetch",
		fingerprint: "pagerduty:PABC123:PINC456",
		selector: "/incidents/PINC456",
	},
	{
		tool: "k8s.context.fetch",
		fingerprint: "k8s:prod:default:pod/api-7c9f:OOMKilled",
		selector: "pods/api-7c9f",
	},
	{
		tool: "datadog.context.fetch",
		fingerprint: "datadog:12345:abcdef0123456789",
		service: "checkout",
		selector: "/api/v1/monitor/12345",
	},
	{
		tool: "newrelic.context.fetch",
		fingerprint: "newrelic:abcdef0123456789",
		service: "checkout",
		selector: "checkout",
	},
	{
		tool: "honeycomb.context.fetch",
		fingerprint: "honeycomb:prod:trigger-1:triggered",
		service: "checkout",
		selector: "/1/queries/prod",
	},
	{
		tool: "axiom.context.fetch",
		fingerprint: "axiom:mon-1:abcdef0123456789",
		service: "checkout",
		selector: "checkout",
	},
	{
		tool: "signoz.context.fetch",
		fingerprint: "signoz:rule-1:abcdef0123456789",
		service: "checkout",
		selector: "/api/v1/rules/rule-1",
	},
];

describe("context preloading mapping", () => {
	for (const vendorCase of VENDOR_CASES) {
		test(`${vendorCase.tool} maps its fingerprint onto the adapter input`, async () => {
			const fetch = recordingFetch();
			const kubernetes = recordingKubernetesClient();
			const dispatch = dispatched(fetch.fetchImpl, kubernetes.factory);
			const outcome = await dispatch(
				call(vendorCase.tool, {
					incidentFingerprint: vendorCase.fingerprint,
					...(vendorCase.service === undefined
						? {}
						: { service: vendorCase.service }),
					...(vendorCase.kind === undefined ? {} : { kind: vendorCase.kind }),
				}),
			);
			if (outcome.ok === false) {
				expect(outcome.errorCode).not.toBe("VALIDATION_FAILED");
			}
			const seen = [
				...fetch.requests.map((request) => `${request.url} ${request.body}`),
				...kubernetes.paths,
			];
			expect(seen.some((entry) => entry.includes(vendorCase.selector))).toBe(
				true,
			);
		});
	}

	test("k8s maps a Pod fingerprint to its pod name and log tail", async () => {
		const fetch = recordingFetch();
		const kubernetes = recordingKubernetesClient();
		const dispatch = dispatched(fetch.fetchImpl, kubernetes.factory);
		await dispatch(
			call("k8s.context.fetch", {
				incidentFingerprint: "k8s:prod:default:pod/api-7c9f:OOMKilled",
			}),
		);
		expect(kubernetes.paths[0]).toContain("/namespaces/default/events");
		expect(kubernetes.paths.some((path) => path.endsWith("/log"))).toBe(true);
	});

	test("honeycomb honours the requested query kind", async () => {
		const fetch = recordingFetch();
		const dispatch = dispatched(
			fetch.fetchImpl,
			recordingKubernetesClient().factory,
		);
		await dispatch(
			call("honeycomb.context.fetch", {
				incidentFingerprint: "honeycomb:prod:trigger-1:triggered",
				service: "checkout",
				kind: "error_rate",
			}),
		);
		expect(fetch.requests[0]?.body).toContain('"column":"error"');
	});
});

describe("context preloading validation", () => {
	for (const vendorCase of VENDOR_CASES) {
		test(`${vendorCase.tool} rejects a foreign fingerprint before any call`, async () => {
			const fetch = recordingFetch();
			const kubernetes = recordingKubernetesClient();
			const dispatch = dispatched(fetch.fetchImpl, kubernetes.factory);
			const outcome = await dispatch(
				call(vendorCase.tool, {
					incidentFingerprint: "github:acme/web#42",
					service: "checkout",
				}),
			);
			expect(outcome).toEqual({
				ok: false,
				errorCode: "VALIDATION_FAILED",
			});
			expect(fetch.requests).toHaveLength(0);
			expect(kubernetes.paths).toHaveLength(0);
		});
	}

	test("rejects a truncated or over-long fingerprint", async () => {
		const fetch = recordingFetch();
		const dispatch = dispatched(
			fetch.fetchImpl,
			recordingKubernetesClient().factory,
		);
		for (const fingerprint of ["sentry:acme", `${"s".repeat(200)}`]) {
			const outcome = await dispatch(
				call("sentry.context.fetch", { incidentFingerprint: fingerprint }),
			);
			expect(outcome).toEqual({
				ok: false,
				errorCode: "VALIDATION_FAILED",
			});
		}
		expect(fetch.requests).toHaveLength(0);
	});

	test("requires the service selector for sources that query by service", async () => {
		const fetch = recordingFetch();
		const dispatch = dispatched(
			fetch.fetchImpl,
			recordingKubernetesClient().factory,
		);
		for (const tool of [
			"grafana.context.fetch",
			"datadog.context.fetch",
			"newrelic.context.fetch",
			"honeycomb.context.fetch",
			"axiom.context.fetch",
			"signoz.context.fetch",
		]) {
			const fingerprint = VENDOR_CASES.find(
				(candidate) => candidate.tool === tool,
			)?.fingerprint;
			const outcome = await dispatch(
				call(tool, { incidentFingerprint: fingerprint }),
			);
			expect(outcome).toEqual({
				ok: false,
				errorCode: "VALIDATION_FAILED",
			});
		}
		expect(fetch.requests).toHaveLength(0);
	});

	test("rejects a k8s kind outside the adapter enum before any call", async () => {
		const fetch = recordingFetch();
		const kubernetes = recordingKubernetesClient();
		const dispatch = dispatched(fetch.fetchImpl, kubernetes.factory);
		const outcome = await dispatch(
			call("k8s.context.fetch", {
				incidentFingerprint: "k8s:prod:default:pod/api-7c9f:OOMKilled",
				kind: "CronJob",
			}),
		);
		expect(outcome).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
		expect(kubernetes.paths).toHaveLength(0);
	});

	test("rejects a k8s kind that contradicts the fingerprint", async () => {
		const fetch = recordingFetch();
		const kubernetes = recordingKubernetesClient();
		const dispatch = dispatched(fetch.fetchImpl, kubernetes.factory);
		const outcome = await dispatch(
			call("k8s.context.fetch", {
				incidentFingerprint: "k8s:prod:default:pod/api-7c9f:OOMKilled",
				kind: "Deployment",
			}),
		);
		expect(outcome).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
		expect(kubernetes.paths).toHaveLength(0);
	});

	test("rejects an unknown honeycomb alert state or query kind", async () => {
		const fetch = recordingFetch();
		const dispatch = dispatched(
			fetch.fetchImpl,
			recordingKubernetesClient().factory,
		);
		const badState = await dispatch(
			call("honeycomb.context.fetch", {
				incidentFingerprint: "honeycomb:prod:trigger-1:exploded",
				service: "checkout",
			}),
		);
		expect(badState).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
		const badKind = await dispatch(
			call("honeycomb.context.fetch", {
				incidentFingerprint: "honeycomb:prod:trigger-1:triggered",
				service: "checkout",
				kind: "throughput",
			}),
		);
		expect(badKind).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
		expect(fetch.requests).toHaveLength(0);
	});

	test("an unconfigured vendor is INTEGRATION_UNAVAILABLE without a call", async () => {
		const fetch = recordingFetch();
		const dispatch = createDispatcher({
			config: baseConfig({ vendors: {} }),
			env: allEnv,
			fetchImpl: fetch.fetchImpl,
		});
		const outcome = await dispatch(
			call("honeycomb.context.fetch", {
				incidentFingerprint: "honeycomb:prod:trigger-1:triggered",
				service: "checkout",
			}),
		);
		expect(outcome).toEqual({
			ok: false,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});
		expect(fetch.requests).toHaveLength(0);
	});
});

describe("context result cap", () => {
	test("allows 256 KiB bundles and rejects one byte over", () => {
		expect(DEVICE_MAX_RESULT_BYTES).toBe(262_144);
		const fits = boundedSuccess({ padded: "" });
		expect(fits.ok).toBe(true);
		const over = boundedSuccess({
			items: [{ excerpt: "x".repeat(DEVICE_MAX_RESULT_BYTES) }],
		});
		expect(over).toEqual({ ok: false, errorCode: "VALIDATION_FAILED" });
	});
});
