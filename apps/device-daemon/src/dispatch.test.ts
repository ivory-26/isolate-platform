import { describe, expect, test } from "bun:test";
import { CONNECTOR_VERIFY_TOOL_NAME } from "@isolate/shared";
import { CONNECTOR_TOOL_NAMES } from "../../../packages/mastra/src/tools/connector-tools";
import { type DeviceConfig, deviceConfigSchema } from "./config";
import type { DeviceCall } from "./contracts";
import {
	createDispatcher,
	createHandlerTable,
	DEVICE_HANDLER_COUNT,
	DEVICE_TOOL_NAMES_BY_VENDOR,
} from "./dispatch";
import { resolveDatadogSettings } from "./vendors/datadog";
import { resolveGrafanaSettings } from "./vendors/grafana";

const TOKEN = "A".repeat(43);

function baseConfig(overrides: Record<string, unknown> = {}): DeviceConfig {
	return deviceConfigSchema.parse({
		serverUrl: "https://isolate.example.com",
		deviceTokenEnv: "ISOLATE_DEVICE_TOKEN",
		...overrides,
	});
}

function call(
	toolName: string,
	params: Record<string, unknown> = {},
): DeviceCall {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		connectorId: toolName.split(".")[0] ?? "sentry",
		credentialRef: "keychain:isolate/test",
		toolName,
		params,
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
	};
}

const countingFetch = () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return Response.json({});
	}) as unknown as typeof fetch;
	return { fetchImpl, count: () => calls };
};

describe("handler table completeness", () => {
	test("has the 31 connector names, 9 context tools and connector.verify", () => {
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(31);
		const handlers = createHandlerTable({ config: baseConfig(), env: {} });
		const names = Object.keys(handlers);
		expect(names).toHaveLength(DEVICE_HANDLER_COUNT);
		expect(DEVICE_HANDLER_COUNT).toBe(41);
		for (const name of CONNECTOR_TOOL_NAMES) {
			expect(names).toContain(name);
		}
		expect(names).toContain(CONNECTOR_VERIFY_TOOL_NAME);
		expect(names.sort()).toEqual(
			[
				...Object.values(DEVICE_TOOL_NAMES_BY_VENDOR).flat(),
				CONNECTOR_VERIFY_TOOL_NAME,
			].sort(),
		);
	});

	test("the static vendor map covers the 40 vendor names", () => {
		const flat = Object.values(DEVICE_TOOL_NAMES_BY_VENDOR).flat();
		expect(flat).toHaveLength(40);
		expect(new Set(flat).size).toBe(40);
		for (const name of CONNECTOR_TOOL_NAMES) {
			expect(flat).toContain(name);
		}
		expect(flat.filter((name) => name.endsWith(".context.fetch"))).toHaveLength(
			9,
		);
	});
});

describe("dispatch", () => {
	test("rejects an unknown tool without executing anything", async () => {
		const fetchImpl = countingFetch();
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: { ISOLATE_DEVICE_TOKEN: TOKEN },
			fetchImpl: fetchImpl.fetchImpl,
		});
		const outcome = await dispatch(call("sentry.delete_everything"));
		expect(outcome).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
		expect(fetchImpl.count()).toBe(0);
	});

	test("fails an unconfigured vendor as INTEGRATION_UNAVAILABLE", async () => {
		const fetchImpl = countingFetch();
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: fetchImpl.fetchImpl,
		});
		expect(await dispatch(call("k8s.get_pod"))).toEqual({
			ok: false,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});
		expect(fetchImpl.count()).toBe(0);
	});

	test("a configured vendor with a missing secret makes no call", async () => {
		const fetchImpl = countingFetch();
		const config = baseConfig({
			vendors: { sentry: { secretEnv: { token: "SENTRY_API_KEY" } } },
		});
		const dispatch = createDispatcher({
			config,
			env: {},
			fetchImpl: fetchImpl.fetchImpl,
		});
		expect(
			await dispatch(call("sentry.list_issues", { orgSlug: "acme" })),
		).toEqual({
			ok: false,
			errorCode: "INTEGRATION_UNAVAILABLE",
		});
		expect(fetchImpl.count()).toBe(0);
	});

	test("caps oversized params before dispatch", async () => {
		const dispatch = createDispatcher({ config: baseConfig(), env: {} });
		const outcome = await dispatch(
			call("sentry.list_issues", { query: "x".repeat(17 * 1024) }),
		);
		expect(outcome).toEqual({
			ok: false,
			errorCode: "VALIDATION_FAILED",
		});
	});

	test("never returns the provider secret in an error envelope", async () => {
		const secret = "sekret-sentry-token-value";
		const fetchImpl = (async () => {
			throw new Error(`boom ${secret}`);
		}) as unknown as typeof fetch;
		const config = baseConfig({
			vendors: { sentry: { secretEnv: { token: "SENTRY_API_KEY" } } },
		});
		const dispatch = createDispatcher({
			config,
			env: { SENTRY_API_KEY: secret },
			fetchImpl,
		});
		const outcome = await dispatch(
			call("sentry.list_issues", { orgSlug: "a" }),
		);
		expect(outcome.ok).toBe(false);
		expect(JSON.stringify(outcome)).not.toContain(secret);
	});
});

describe("paired secret store resolution", () => {
	const storeSecret = `store-${crypto.randomUUID()}`;
	const envSecret = `env-${crypto.randomUUID()}`;

	function captureFetch(): {
		fetchImpl: typeof fetch;
		authHeaders: (string | null)[];
	} {
		const authHeaders: (string | null)[] = [];
		const fetchImpl = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			const headers = new Headers(init?.headers);
			authHeaders.push(headers.get("authorization"));
			return Response.json([]);
		}) as unknown as typeof fetch;
		return { fetchImpl, authHeaders };
	}

	function sentryConfig(env: Record<string, string | undefined>) {
		return {
			config: baseConfig({
				vendors: { sentry: { secretEnv: { token: "SENTRY_API_KEY" } } },
			}),
			env,
		};
	}

	test("uses the paired entry before the environment", async () => {
		const capture = captureFetch();
		const { config, env } = sentryConfig({
			SENTRY_API_KEY: envSecret,
		});
		const dispatch = createDispatcher({
			config,
			env,
			fetchImpl: capture.fetchImpl,
			secretStore: {
				getFields: (ref) =>
					ref === "keychain:isolate/test" ? { token: storeSecret } : null,
			},
		});
		const outcome = await dispatch(
			call("sentry.list_issues", { orgSlug: "acme" }),
		);
		expect(outcome.ok).toBe(true);
		expect(capture.authHeaders[0]).toBe(`Bearer ${storeSecret}`);
		expect(capture.authHeaders[0]).not.toContain(envSecret);
	});

	test("falls back to the environment when no entry exists", async () => {
		const capture = captureFetch();
		const { config, env } = sentryConfig({
			SENTRY_API_KEY: envSecret,
		});
		const dispatch = createDispatcher({
			config,
			env,
			fetchImpl: capture.fetchImpl,
			secretStore: { getFields: () => null },
		});
		const outcome = await dispatch(
			call("sentry.list_issues", { orgSlug: "acme" }),
		);
		expect(outcome.ok).toBe(true);
		expect(capture.authHeaders[0]).toBe(`Bearer ${envSecret}`);
	});

	test("a store entry for another credentialRef never authorizes a call", async () => {
		const capture = captureFetch();
		const { config, env } = sentryConfig({});
		const dispatch = createDispatcher({
			config,
			env,
			fetchImpl: capture.fetchImpl,
			secretStore: {
				getFields: (ref) =>
					ref === "keychain:isolate/other" ? { token: storeSecret } : null,
			},
		});
		expect(
			await dispatch(call("sentry.list_issues", { orgSlug: "acme" })),
		).toEqual({ ok: false, errorCode: "INTEGRATION_UNAVAILABLE" });
		expect(capture.authHeaders).toHaveLength(0);
	});

	test("a paired Grafana credential works with no vendor config entry", () => {
		const settings = resolveGrafanaSettings(
			undefined,
			{},
			(async () => Response.json([])) as unknown as typeof fetch,
			"keychain:isolate/test",
			{
				getFields: () => ({ token: storeSecret }),
				getSelectors: () => ({
					baseUrl: "https://grafana.example.com",
					orgId: "7",
					metricsDatasourceUid: "metrics-1",
					logsDatasourceUid: "logs-1",
				}),
			},
		);
		expect(settings.ok).toBe(true);
		if (!settings.ok) return;
		expect(settings.deps).toMatchObject({
			baseUrl: "https://grafana.example.com",
			token: storeSecret,
			orgId: "7",
			metricsDatasourceUid: "metrics-1",
			logsDatasourceUid: "logs-1",
		});
	});

	test("Datadog resolves both paired keys and the required site origin", () => {
		const apiKey = `api-${crypto.randomUUID()}`;
		const appKey = `app-${crypto.randomUUID()}`;
		const settings = resolveDatadogSettings(
			undefined,
			{},
			(async () => Response.json({})) as unknown as typeof fetch,
			"keychain:isolate/test",
			{
				getFields: () => ({ apiKey, appKey }),
				getSelectors: () => ({ baseUrl: "https://api.datadoghq.eu" }),
			},
		);
		expect(settings.ok).toBe(true);
		if (!settings.ok) return;
		expect(settings.deps.apiKey).toBe(apiKey);
		expect(settings.deps.appKey).toBe(appKey);
		expect(settings.deps.baseUrl).toBe("https://api.datadoghq.eu");
	});

	test("an unconfigured vendor still fails closed without a paired entry", () => {
		const settings = resolveDatadogSettings(undefined, {}, fetch, "missing", {
			getFields: () => null,
			getSelectors: () => null,
		});
		expect(settings).toEqual({ ok: false, reason: "CONFIG_REQUIRED" });
	});

	test("a malformed paired selector fails closed before any fetch", async () => {
		const capture = captureFetch();
		const dispatch = createDispatcher({
			config: baseConfig(),
			env: {},
			fetchImpl: capture.fetchImpl,
			secretStore: {
				getFields: () => ({ token: storeSecret }),
				getSelectors: () => ({ baseUrl: "http://plain.example.com" }),
			},
		});
		expect(
			await dispatch(call("grafana.query_metrics", { service: "checkout" })),
		).toEqual({ ok: false, errorCode: "VALIDATION_FAILED" });
		expect(capture.authHeaders).toHaveLength(0);
	});
});
