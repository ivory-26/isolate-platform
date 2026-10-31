import { describe, expect, test } from "bun:test";
import { asOrganizationId, PlatformError } from "@isolate/shared";
import {
	assertBoundedDeviceJson,
	createNullDeviceProxyFactory,
	DEVICE_PROXY_DEFAULT_TIMEOUT_MS,
	DEVICE_PROXY_MAX_TIMEOUT_MS,
	DEVICE_PROXY_MIN_TIMEOUT_MS,
	type DeviceProxyTarget,
	deviceProxyFailure,
	deviceProxySuccess,
	NullDeviceProxy,
	normalizeConnectorDeviceProxyRequest,
} from "./device-proxy";

const request = {
	connectorId: "sentry",
	credentialRef: "keychain:isolate/sentry/team",
	operation: "issues.list",
	params: { project: "backend", limit: 10, tags: ["prod"] },
	timeoutMs: 5_000,
};

function expectValidationError(run: () => unknown): PlatformError {
	try {
		run();
		throw new Error("expected a validation failure");
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformError);
		const platformError = error as PlatformError;
		expect(platformError.code).toBe("VALIDATION_FAILED");
		return platformError;
	}
}

describe("device proxy request boundary", () => {
	test("normalizes a bounded request and applies the default timeout", () => {
		expect(normalizeConnectorDeviceProxyRequest(request)).toEqual(request);
		const minimal = normalizeConnectorDeviceProxyRequest({
			connectorId: "pagerduty",
			credentialRef: "keychain:pagerduty",
			operation: "incidents.get",
		});
		expect(minimal.params).toEqual({});
		expect(minimal.timeoutMs).toBe(DEVICE_PROXY_DEFAULT_TIMEOUT_MS);
	});

	test("clamps the timeout inside fixed bounds", () => {
		expect(
			normalizeConnectorDeviceProxyRequest({ ...request, timeoutMs: 1 })
				.timeoutMs,
		).toBe(DEVICE_PROXY_MIN_TIMEOUT_MS);
		expect(
			normalizeConnectorDeviceProxyRequest({
				...request,
				timeoutMs: Number.MAX_SAFE_INTEGER,
			}).timeoutMs,
		).toBe(DEVICE_PROXY_MAX_TIMEOUT_MS);
	});

	test("rejects malformed fields without echoing their values", () => {
		const secretLike = "SECRET-VALUE-SHOULD-NOT-ECHO";
		for (const invalid of [
			{ ...request, connectorId: "Sentry" },
			{ ...request, credentialRef: "   " },
			{ ...request, operation: secretLike },
			{ ...request, operation: "" },
			{ ...request, timeoutMs: -1 },
			{ ...request, timeoutMs: 1.5 },
			{ ...request, connectorId: secretLike },
			{ ...request, extra: true },
		]) {
			const error = expectValidationError(() =>
				normalizeConnectorDeviceProxyRequest(invalid),
			);
			expect(error.message).not.toContain(secretLike);
		}
	});

	test("params must be bounded, plain JSON", () => {
		for (const params of [
			{ value: undefined },
			{ value: () => 1 },
			{ value: new Date("2026-10-31T00:00:00.000Z") },
			{ value: Number.POSITIVE_INFINITY },
			{ value: 10n },
			{ value: "x".repeat(16 * 1024 + 1) },
			{ items: Array.from({ length: 257 }, (_, index) => index) },
		]) {
			expectValidationError(() =>
				normalizeConnectorDeviceProxyRequest({ ...request, params }),
			);
		}
		// Zod rebuilds a record, so the top-level key is dropped before it is
		// seen; the raw walker still rejects it and nested ones reach it.
		expectValidationError(() =>
			assertBoundedDeviceJson(
				JSON.parse('{"__proto__":{"polluted":true}}'),
				"test",
				1024,
			),
		);
		expectValidationError(() =>
			normalizeConnectorDeviceProxyRequest({
				...request,
				params: { nested: JSON.parse('{"__proto__":{"polluted":true}}') },
			}),
		);
		let deep: unknown = "leaf";
		for (let level = 0; level < 8; level += 1) deep = { nested: deep };
		expectValidationError(() =>
			normalizeConnectorDeviceProxyRequest({
				...request,
				params: { deep },
			}),
		);
	});

	test("the bounded JSON helper accepts plain values and caps bytes", () => {
		expect(() =>
			assertBoundedDeviceJson(
				{ a: [1, "two", null, true], b: { c: 3 } },
				"test",
				1024,
			),
		).not.toThrow();
		expectValidationError(() =>
			assertBoundedDeviceJson({ value: "x".repeat(1024) }, "test", 64),
		);
	});
});

describe("device proxy transport seam", () => {
	test("NullDeviceProxy fails closed with a fixed unavailable result", async () => {
		const proxy = new NullDeviceProxy();
		const result = await proxy.execute(request);
		expect(result).toEqual({
			ok: false,
			error: {
				code: "INTEGRATION_UNAVAILABLE",
				message: "connector device is unavailable",
			},
		});
		expect(JSON.stringify(result)).not.toContain(
			"keychain:isolate/sentry/team",
		);
	});

	test("a null factory still yields a fail-closed proxy", async () => {
		const factory = createNullDeviceProxyFactory();
		const proxy = await factory({
			organizationId: asOrganizationId("11111111-1111-4111-8111-111111111111"),
			deviceId: "33333333-3333-4333-8333-333333333333",
			connectorId: "sentry",
			credentialRef: "keychain:isolate/sentry/team",
		});
		expect(proxy).toBeInstanceOf(NullDeviceProxy);
		const result = await proxy?.execute(request);
		expect(result?.ok).toBe(false);
	});

	test("success wraps bounded JSON and rejects unbounded device output", () => {
		expect(deviceProxySuccess({ items: [1, 2, 3] })).toEqual({
			ok: true,
			data: { items: [1, 2, 3] },
		});
		expect(deviceProxySuccess("plain")).toEqual({ ok: true, data: "plain" });
		expect(deviceProxySuccess(null)).toEqual({ ok: true, data: null });
		for (const unbounded of [
			{ value: "x".repeat(16 * 1024 + 1) },
			{ value: () => 1 },
			{ value: new Date() },
		]) {
			expect(deviceProxySuccess(unbounded)).toEqual({
				ok: false,
				error: {
					code: "VALIDATION_FAILED",
					message: "connector device response was invalid",
				},
			});
		}
	});

	test("failure codes map to fixed credential-free messages", () => {
		expect(deviceProxyFailure("RATE_LIMITED")).toEqual({
			ok: false,
			error: {
				code: "RATE_LIMITED",
				message: "connector device is rate limited",
			},
		});
		expect(deviceProxyFailure("POLICY_DENIED").error.message).toBe(
			"connector device call was denied",
		);
		const target: DeviceProxyTarget = {
			organizationId: asOrganizationId("11111111-1111-4111-8111-111111111111"),
			deviceId: null,
			connectorId: "sentry",
			credentialRef: "env:sentry",
		};
		expect(target.deviceId).toBeNull();
	});
});
