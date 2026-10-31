import { describe, expect, test } from "bun:test";
import { CONNECTOR_TOOL_NAMES } from "../../../packages/mastra/src/tools/connector-tools";
import { type DeviceConfig, deviceConfigSchema } from "./config";
import type { DeviceCall } from "./contracts";
import {
	createDispatcher,
	createHandlerTable,
	DEVICE_TOOL_NAMES_BY_VENDOR,
} from "./dispatch";

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
	test("has exactly the 31 connector tool names, even with no vendor configured", () => {
		expect(CONNECTOR_TOOL_NAMES).toHaveLength(31);
		const handlers = createHandlerTable({ config: baseConfig(), env: {} });
		expect(Object.keys(handlers).sort()).toEqual(
			[...CONNECTOR_TOOL_NAMES].sort(),
		);
	});

	test("the static vendor map covers the same 31 names", () => {
		const flat = Object.values(DEVICE_TOOL_NAMES_BY_VENDOR).flat();
		expect(flat.sort()).toEqual([...CONNECTOR_TOOL_NAMES].sort());
		expect(new Set(flat).size).toBe(31);
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
