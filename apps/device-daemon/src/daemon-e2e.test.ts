import { afterAll, describe, expect, test } from "bun:test";
import { type DeviceConfig, deviceConfigSchema } from "./config";
import type { DeviceCall } from "./contracts";
import { createDispatcher } from "./dispatch";
import { createMemoryLogger } from "./logger";
import { runPollLoop } from "./poll";
import type { KubernetesClientFactory } from "./vendors/kubernetes";

/**
 * End-to-end daemon test against a real local HTTP server standing in for the
 * device gateway. Provider traffic is a fake `fetch` (and a fake Kubernetes
 * client); nothing touches a real vendor or platform.
 */

const TOKEN = "C".repeat(43);
const SECRETS = {
	SENTRY_API_KEY: "sentry-secret-key-value",
	GRAFANA_TOKEN: "grafana-secret-token-value",
	PAGERDUTY_API_KEY: "pagerduty-secret-key-value",
};

const CALLS: DeviceCall[] = [
	{
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		connectorId: "sentry",
		credentialRef: "keychain:redacted-sample",
		toolName: "sentry.list_issues",
		params: { orgSlug: "acme" },
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	},
	{
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		connectorId: "grafana",
		credentialRef: "keychain:redacted-sample/grafana",
		toolName: "grafana.query_metrics",
		params: { service: "api" },
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	},
	{
		id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		connectorId: "pagerduty",
		credentialRef: "keychain:redacted-sample/pagerduty",
		toolName: "pagerduty.list_incidents",
		params: {},
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	},
	{
		id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		connectorId: "k8s",
		credentialRef: "keychain:redacted-sample/kubernetes",
		toolName: "k8s.get_pod",
		params: { namespace: "default", name: "api-0" },
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	},
];

const queue = [...CALLS];
const claims: Array<string | null> = [];
const results: Array<{ callId: string; body: unknown }> = [];

const gateway = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const auth = request.headers.get("authorization");
		if (request.method === "POST" && url.pathname === "/api/device/claim") {
			claims.push(auth);
			return Response.json({ call: queue.shift() ?? null });
		}
		const match = /^\/api\/device\/calls\/([^/]+)\/result$/.exec(url.pathname);
		if (request.method === "POST" && match !== null) {
			const callId = decodeURIComponent(match[1] ?? "");
			results.push({ callId, body: await request.json() });
			return Response.json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	},
});

afterAll(() => {
	gateway.stop(true);
});

const providerFetch = (async (input: string | URL | Request) => {
	const url = String(input);
	if (url.startsWith("https://sentry.example.com/api/0/")) {
		return Response.json([
			{
				id: "42",
				shortId: "ACME-42",
				title: "boom",
				level: "error",
				status: "unresolved",
				count: 3,
				firstSeen: "2026-01-01T00:00:00Z",
				lastSeen: "2026-01-01T00:05:00Z",
			},
		]);
	}
	if (url.startsWith("https://grafana.example.com/api/ds/query")) {
		return Response.json({
			results: {
				metrics: {
					status: 200,
					frames: [
						{
							schema: {
								fields: [
									{ name: "time", type: "time" },
									{ name: "value", type: "number" },
								],
							},
							data: {
								values: [
									[1_000, 2_000],
									[3, 4],
								],
							},
						},
					],
				},
			},
		});
	}
	if (url.startsWith("https://pagerduty.example.com/incidents")) {
		return Response.json({
			incidents: [
				{
					id: "P1",
					status: "triggered",
					title: "Database is down",
					urgency: "high",
					service: { id: "S1", name: "api" },
				},
			],
		});
	}
	throw new Error("unexpected provider url");
}) as unknown as typeof fetch;

const kubernetesClientFactory: KubernetesClientFactory = () => ({
	async get() {
		return {
			status: 200,
			body: {
				metadata: {
					name: "api-0",
					namespace: "default",
					creationTimestamp: "2026-01-01T00:00:00Z",
				},
				status: { phase: "Running" },
			},
		};
	},
	async getText() {
		return { status: 200, text: "" };
	},
});

function config(): DeviceConfig {
	return deviceConfigSchema.parse({
		serverUrl: "https://isolate.example.com",
		deviceTokenEnv: "ISOLATE_DEVICE_TOKEN",
		vendors: {
			sentry: {
				secretEnv: { token: "SENTRY_API_KEY" },
				baseUrl: "https://sentry.example.com",
			},
			grafana: {
				secretEnv: { token: "GRAFANA_TOKEN" },
				baseUrl: "https://grafana.example.com",
				metricsDatasourceUid: "prometheus",
				logsDatasourceUid: "loki",
			},
			pagerduty: {
				secretEnv: { token: "PAGERDUTY_API_KEY" },
				fromEmail: "oncall@example.com",
				baseUrl: "https://pagerduty.example.com",
			},
			kubernetes: {
				secretEnv: {
					serviceAccountTokenFile: "KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE",
				},
				apiUrl: "https://127.0.0.1:6443",
				namespace: "default",
			},
		},
	});
}

describe("daemon end-to-end with a fake gateway", () => {
	test("claims, dispatches and posts results for sentry, grafana, pagerduty and kubernetes", async () => {
		const logger = createMemoryLogger();
		const dispatch = createDispatcher({
			config: config(),
			env: {
				...SECRETS,
				ISOLATE_DEVICE_TOKEN: TOKEN,
				KUBERNETES_SERVICE_ACCOUNT_TOKEN_FILE: "/tmp/k8s-token",
			},
			fetchImpl: providerFetch,
			kubernetesClientFactory,
		});
		const result = await runPollLoop({
			serverUrl: gateway.url.origin,
			deviceToken: TOKEN,
			dispatch,
			sleep: async () => undefined,
			logger,
			maxClaims: CALLS.length + 1,
		});

		expect(result.reason).toBe("stopped");
		expect(claims).toHaveLength(CALLS.length + 1);
		expect(claims.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
		expect(results).toHaveLength(CALLS.length);

		const byId = new Map(results.map((entry) => [entry.callId, entry.body]));
		const sentry = byId.get(CALLS[0]?.id ?? "") as {
			ok: boolean;
			data: { items: Array<{ id: string; title: string }> };
		};
		expect(sentry.ok).toBe(true);
		expect(sentry.data.items[0]?.id).toBe("42");
		expect(sentry.data.items[0]?.title).toBe("boom");

		const grafana = byId.get(CALLS[1]?.id ?? "") as {
			ok: boolean;
			data: { item: unknown; truncated: boolean };
		};
		expect(grafana.ok).toBe(true);
		expect(grafana.data.item).not.toBeNull();
		expect(grafana.data.truncated).toBe(false);

		const pagerduty = byId.get(CALLS[2]?.id ?? "") as {
			ok: boolean;
			data: { incidents: Array<{ id: string; service: { name?: string } }> };
		};
		expect(pagerduty.ok).toBe(true);
		expect(pagerduty.data.incidents[0]?.id).toBe("P1");
		expect(pagerduty.data.incidents[0]?.service.name).toBe("api");

		const kubernetes = byId.get(CALLS[3]?.id ?? "") as {
			ok: boolean;
			data: { items: unknown[]; truncated: boolean; trustLevel: string };
		};
		expect(kubernetes.ok).toBe(true);
		expect(kubernetes.data.items).toHaveLength(1);
		expect(kubernetes.data.trustLevel).toBe("untrusted");

		const serialized = JSON.stringify(results);
		for (const secret of Object.values(SECRETS)) {
			expect(serialized).not.toContain(secret);
		}
		const logs = logger.lines.join("\n");
		expect(logs).not.toContain(TOKEN);
		for (const secret of Object.values(SECRETS)) {
			expect(logs).not.toContain(secret);
		}
		expect(logs).toContain("sentry.list_issues");
		expect(logs).toContain("grafana.query_metrics");
		expect(logs).toContain("pagerduty.list_incidents");
		expect(logs).toContain("k8s.get_pod");
		expect(logs).not.toContain("orgSlug");
	});
});
