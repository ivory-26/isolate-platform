import { describe, expect, test } from "bun:test";
import type { KubernetesHttpClient } from "@isolate/integrations";
import {
	type DeviceConfig,
	deviceConfigSchema,
	type SecretLookup,
} from "../config";
import type { DeviceCall } from "../contracts";
import { createDispatcher } from "../dispatch";

const REF = "keychain:isolate/w24";

function baseConfig(): DeviceConfig {
	return deviceConfigSchema.parse({
		serverUrl: "https://isolate.example.com",
		deviceTokenEnv: "ISOLATE_DEVICE_TOKEN",
	});
}

function callFor(connectorId: string, credentialRef = REF): DeviceCall {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		connectorId,
		credentialRef,
		toolName: "connector.verify",
		params: {},
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	};
}

type CapturedRequest = {
	url: string;
	method: string | undefined;
	headers: Headers;
	redirect: RequestInit["redirect"] | undefined;
	hasSignal: boolean;
	body: string | undefined;
};

function captureFetch(
	respond: (request: CapturedRequest) => Response | Promise<Response>,
): {
	fetchImpl: typeof fetch;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const captured: CapturedRequest = {
			url: String(input),
			method: init?.method,
			headers: new Headers(init?.headers),
			redirect: init?.redirect,
			hasSignal: init?.signal !== undefined && init.signal !== null,
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		requests.push(captured);
		return await respond(captured);
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function storeWith(
	fields: Record<string, string>,
	selectors: Record<string, string> = {},
): SecretLookup {
	return {
		getFields: () => fields,
		getSelectors: () => selectors,
	};
}

function outcomeOf(
	result: Awaited<ReturnType<ReturnType<typeof createDispatcher>>>,
): { verified: boolean; reasonCode: string } {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("expected a success envelope");
	return result.data as { verified: boolean; reasonCode: string };
}

const PAIRED: Record<
	string,
	{ fields: Record<string, string>; selectors: Record<string, string> }
> = {
	sentry: { fields: { token: "sentry-token" }, selectors: {} },
	grafana: {
		fields: { token: "grafana-token" },
		selectors: { baseUrl: "https://grafana.example.com", orgId: "7" },
	},
	pagerduty: {
		fields: { token: "pagerduty-token" },
		selectors: { fromEmail: "oncall@example.com" },
	},
	datadog: {
		fields: { apiKey: "datadog-api", appKey: "datadog-app" },
		selectors: { baseUrl: "https://api.datadoghq.com" },
	},
	newrelic: {
		fields: { apiKey: "newrelic-key" },
		selectors: { accountId: "1234567" },
	},
	honeycomb: {
		fields: { apiKey: "honeycomb-key" },
		selectors: { dataset: "production" },
	},
	axiom: {
		fields: { token: "axiom-token" },
		selectors: { baseUrl: "https://api.axiom.co", dataset: "production" },
	},
	signoz: {
		fields: { apiKey: "signoz-key" },
		selectors: { baseUrl: "https://signoz.example.com" },
	},
};

describe("connector.verify provider probes", () => {
	test("each SaaS connector makes exactly one bounded authenticated read", async () => {
		for (const [connectorId, paired] of Object.entries(PAIRED)) {
			const capture = captureFetch(() => Response.json({ ok: true }));
			const dispatch = createDispatcher({
				config: baseConfig(),
				env: {},
				fetchImpl: capture.fetchImpl,
				secretStore: storeWith(paired.fields, paired.selectors),
			});
			const outcome = outcomeOf(await dispatch(callFor(connectorId)));
			expect(outcome).toEqual({ verified: true, reasonCode: "OK" });
			expect(capture.requests).toHaveLength(1);
			const request = capture.requests[0];
			if (request === undefined) throw new Error("missing request");
			expect(request.method).toBe(connectorId === "newrelic" ? "POST" : "GET");
			expect(request.redirect).toBe("error");
			expect(request.hasSignal).toBe(true);
		}
	});

	test("Sentry uses the organization list with a Bearer token", async () => {
		const capture = captureFetch(() => Response.json([]));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(PAIRED.sentry?.fields ?? {}),
		});
		outcomeOf(await dispatch(callFor("sentry")));
		const request = capture.requests[0];
		expect(request?.url).toBe("https://sentry.io/api/0/organizations/?limit=1");
		expect(request?.headers.get("authorization")).toBe("Bearer sentry-token");
	});

	test("Grafana sends the optional org header and datasource probe", async () => {
		const capture = captureFetch(() => Response.json({ data: [] }));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(
				PAIRED.grafana?.fields ?? {},
				PAIRED.grafana?.selectors ?? {},
			),
		});
		outcomeOf(await dispatch(callFor("grafana")));
		const request = capture.requests[0];
		expect(request?.url).toBe(
			"https://grafana.example.com/api/datasources?limit=1",
		);
		expect(request?.headers.get("authorization")).toBe("Bearer grafana-token");
		expect(request?.headers.get("x-grafana-org-id")).toBe("7");
	});

	test("PagerDuty uses the Token scheme and v2 Accept header", async () => {
		const capture = captureFetch(() => Response.json({ user: {} }));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(
				PAIRED.pagerduty?.fields ?? {},
				PAIRED.pagerduty?.selectors ?? {},
			),
		});
		outcomeOf(await dispatch(callFor("pagerduty")));
		const request = capture.requests[0];
		expect(request?.url).toBe("https://api.pagerduty.com/users/me");
		expect(request?.headers.get("authorization")).toBe(
			"Token token=pagerduty-token",
		);
		expect(request?.headers.get("accept")).toBe(
			"application/vnd.pagerduty+json;version=2",
		);
	});

	test("Datadog sends both keys to the validate endpoint", async () => {
		const capture = captureFetch(() => Response.json({ valid: true }));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(
				PAIRED.datadog?.fields ?? {},
				PAIRED.datadog?.selectors ?? {},
			),
		});
		outcomeOf(await dispatch(callFor("datadog")));
		const request = capture.requests[0];
		expect(request?.url).toBe("https://api.datadoghq.com/api/v1/validate");
		expect(request?.headers.get("dd-api-key")).toBe("datadog-api");
		expect(request?.headers.get("dd-application-key")).toBe("datadog-app");
	});

	test("New Relic posts the bounded identity query to GraphQL", async () => {
		const capture = captureFetch(() => Response.json({ data: {} }));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(
				PAIRED.newrelic?.fields ?? {},
				PAIRED.newrelic?.selectors ?? {},
			),
		});
		outcomeOf(await dispatch(callFor("newrelic")));
		const request = capture.requests[0];
		expect(request?.url).toBe("https://api.newrelic.com/graphql");
		expect(request?.headers.get("api-key")).toBe("newrelic-key");
		expect(request?.body).toBe(
			JSON.stringify({ query: "{ actor { user { email } } }" }),
		);
	});

	test("Honeycomb, Axiom and SigNoz use their documented headers", async () => {
		const honeycomb = captureFetch(() => Response.json({}));
		await createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: honeycomb.fetchImpl,
			secretStore: storeWith(
				PAIRED.honeycomb?.fields ?? {},
				PAIRED.honeycomb?.selectors ?? {},
			),
		})(callFor("honeycomb"));
		expect(honeycomb.requests[0]?.url).toBe("https://api.honeycomb.io/1/auth");
		expect(honeycomb.requests[0]?.headers.get("x-honeycomb-team")).toBe(
			"honeycomb-key",
		);

		const axiom = captureFetch(() => Response.json([]));
		await createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: axiom.fetchImpl,
			secretStore: storeWith(
				PAIRED.axiom?.fields ?? {},
				PAIRED.axiom?.selectors ?? {},
			),
		})(callFor("axiom"));
		expect(axiom.requests[0]?.url).toBe("https://api.axiom.co/api/v1/datasets");
		expect(axiom.requests[0]?.headers.get("authorization")).toBe(
			"Bearer axiom-token",
		);

		const signoz = captureFetch(() => Response.json({ data: [] }));
		await createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: signoz.fetchImpl,
			secretStore: storeWith(
				PAIRED.signoz?.fields ?? {},
				PAIRED.signoz?.selectors ?? {},
			),
		})(callFor("signoz"));
		expect(signoz.requests[0]?.url).toBe(
			"https://signoz.example.com/api/v1/rules",
		);
		expect(signoz.requests[0]?.headers.get("signoz-api-key")).toBe(
			"signoz-key",
		);
	});

	test("Kubernetes uses the injected client for one limit=1 event read", async () => {
		const calls: Array<{ path: string; query: unknown }> = [];
		const client: KubernetesHttpClient = {
			async get(path, query) {
				calls.push({ path, query });
				return { status: 200, body: { items: [] } };
			},
			async getText() {
				return { status: 200, text: "" };
			},
		};
		const optionsSeen: Array<{ apiUrl: string; tokenFile: string }> = [];
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			kubernetesClientFactory: (options) => {
				optionsSeen.push({
					apiUrl: options.apiUrl,
					tokenFile: options.serviceAccountTokenFile,
				});
				return client;
			},
			secretStore: storeWith(
				{ serviceAccountTokenFile: "/var/run/secrets/token" },
				{
					apiUrl: "https://cluster.example.com:6443",
					namespace: "production",
				},
			),
		});
		const outcome = outcomeOf(await dispatch(callFor("kubernetes")));
		expect(outcome).toEqual({ verified: true, reasonCode: "OK" });
		expect(optionsSeen).toEqual([
			{
				apiUrl: "https://cluster.example.com:6443",
				tokenFile: "/var/run/secrets/token",
			},
		]);
		expect(calls).toEqual([
			{ path: "/api/v1/namespaces/production/events", query: { limit: "1" } },
		]);
	});
});

describe("connector.verify reason mapping", () => {
	async function verifyWithStatus(
		status: number,
		connectorId = "sentry",
	): Promise<{ verified: boolean; reasonCode: string }> {
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: captureFetch(() => new Response("provider body", { status }))
				.fetchImpl,
			secretStore: storeWith(PAIRED[connectorId]?.fields ?? {}, {
				...(PAIRED[connectorId]?.selectors ?? {}),
			}),
		});
		return outcomeOf(await dispatch(callFor(connectorId)));
	}

	test("401 and 403 are AUTH_FAILED", async () => {
		expect(await verifyWithStatus(401)).toEqual({
			verified: false,
			reasonCode: "AUTH_FAILED",
		});
		expect(await verifyWithStatus(403)).toEqual({
			verified: false,
			reasonCode: "AUTH_FAILED",
		});
	});

	test("404 is CONFIG_REQUIRED and 429 is RATE_LIMITED", async () => {
		expect(await verifyWithStatus(404)).toEqual({
			verified: false,
			reasonCode: "CONFIG_REQUIRED",
		});
		expect(await verifyWithStatus(429)).toEqual({
			verified: false,
			reasonCode: "RATE_LIMITED",
		});
	});

	test("other 4xx and any 5xx are PROVIDER_ERROR", async () => {
		expect(await verifyWithStatus(400)).toEqual({
			verified: false,
			reasonCode: "PROVIDER_ERROR",
		});
		expect(await verifyWithStatus(500)).toEqual({
			verified: false,
			reasonCode: "PROVIDER_ERROR",
		});
		expect(await verifyWithStatus(503)).toEqual({
			verified: false,
			reasonCode: "PROVIDER_ERROR",
		});
	});

	test("a thrown fetch is UNREACHABLE", async () => {
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: (async () => {
				throw new Error("connection refused");
			}) as unknown as typeof fetch,
			secretStore: storeWith(PAIRED.sentry?.fields ?? {}),
		});
		expect(outcomeOf(await dispatch(callFor("sentry")))).toEqual({
			verified: false,
			reasonCode: "UNREACHABLE",
		});
	});

	test("missing secret or selector is CONFIG_REQUIRED with zero fetch", async () => {
		const capture = captureFetch(() => Response.json({}));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: { getFields: () => null, getSelectors: () => null },
		});
		expect(outcomeOf(await dispatch(callFor("grafana")))).toEqual({
			verified: false,
			reasonCode: "CONFIG_REQUIRED",
		});
		expect(capture.requests).toHaveLength(0);
	});

	test("an unknown connector is CONFIG_REQUIRED with zero fetch", async () => {
		const capture = captureFetch(() => Response.json({}));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: { getFields: () => ({ token: "x" }) },
		});
		expect(outcomeOf(await dispatch(callFor("github")))).toEqual({
			verified: false,
			reasonCode: "CONFIG_REQUIRED",
		});
		expect(capture.requests).toHaveLength(0);
	});

	test("a malformed paired selector is CONFIG_REQUIRED with zero fetch", async () => {
		const capture = captureFetch(() => Response.json({}));
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: storeWith(
				{ token: "grafana-token" },
				{ baseUrl: "http://plain.example.com" },
			),
		});
		expect(outcomeOf(await dispatch(callFor("grafana")))).toEqual({
			verified: false,
			reasonCode: "CONFIG_REQUIRED",
		});
		expect(capture.requests).toHaveLength(0);
	});
});

describe("connector.verify confidentiality", () => {
	test("the provider body, URL, headers and secret never reach the result", async () => {
		const secret = `secret-${crypto.randomUUID()}`;
		const body = `leak ${secret} https://internal.example.com Authorization: Bearer ${secret}`;
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: captureFetch(() => new Response(body, { status: 500 }))
				.fetchImpl,
			secretStore: storeWith({ token: secret }),
		});
		const result = await dispatch(callFor("sentry"));
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("leak");
		expect(serialized).not.toContain("internal.example.com");
		expect(serialized).not.toContain("Bearer");
		expect(outcomeOf(result)).toEqual({
			verified: false,
			reasonCode: "PROVIDER_ERROR",
		});
	});

	test("a huge provider body is read only to the cap", async () => {
		let produced = 0;
		const chunks = Array.from({ length: 64 }, (_, index) =>
			new Uint8Array(16 * 1024).fill(65 + (index % 20)),
		);
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[produced];
				produced += 1;
				if (chunk === undefined) {
					controller.close();
					return;
				}
				controller.enqueue(chunk);
			},
		});
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: captureFetch(() => new Response(stream, { status: 200 }))
				.fetchImpl,
			secretStore: storeWith(PAIRED.sentry?.fields ?? {}),
		});
		expect(outcomeOf(await dispatch(callFor("sentry")))).toEqual({
			verified: true,
			reasonCode: "OK",
		});
		// 1 MiB is available, but the reader stops at the 64 KiB cap.
		expect(produced).toBeLessThan(chunks.length);
	});
});
