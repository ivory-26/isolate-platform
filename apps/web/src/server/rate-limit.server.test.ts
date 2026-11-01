import { describe, expect, test } from "bun:test";
import { InMemoryRateLimitRepository } from "@isolate/db";
import {
	createUserRateLimitGate,
	DEVICE_CLAIM_RATE_LIMIT,
	DEVICE_HEARTBEAT_RATE_LIMIT,
	DEVICE_IP_RATE_LIMIT,
	DEVICE_RESULT_RATE_LIMIT,
	type DeviceRateLimitAction,
	deviceIpRateLimitKey,
	deviceRateLimitKey,
	enforceRateLimit,
	isTrustProxyHeadersEnabled,
	normalizeClientIp,
	RATE_LIMIT_WINDOW_SECONDS,
	RateLimitExceededError,
	rateLimitedResponse,
	readClientIp,
	UNTRUSTED_CLIENT_IP,
	USER_RATE_LIMITS,
	userRateLimitKey,
	WEBHOOK_MODE_RATE_LIMIT,
	webhookRateLimitKey,
} from "./rate-limit.server";

const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const MID_WINDOW = new Date("2026-11-01T00:00:10.000Z");

describe("rate limit policies", () => {
	test("documents the gateway, intake and user budgets", () => {
		expect(DEVICE_IP_RATE_LIMIT).toBe(600);
		expect(DEVICE_CLAIM_RATE_LIMIT).toBe(120);
		expect(DEVICE_RESULT_RATE_LIMIT).toBe(240);
		expect(DEVICE_HEARTBEAT_RATE_LIMIT).toBe(60);
		expect(WEBHOOK_MODE_RATE_LIMIT).toBe(600);
		expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
		expect(USER_RATE_LIMITS).toEqual({
			"device:register": 10,
			"device:list": 120,
			"device:revoke": 30,
			"device:rotate": 10,
			"connector:connect": 30,
			"connector:list": 120,
			"connector:revoke": 30,
		});
	});

	test("keys are opaque, action-scoped and never a request value", () => {
		expect(deviceIpRateLimitKey("203.0.113.7")).toBe("ip:203.0.113.7:device");
		const actions: DeviceRateLimitAction[] = ["claim", "result", "heartbeat"];
		expect(
			actions.map((action) => deviceRateLimitKey("device-1", action)),
		).toEqual([
			"device:device-1:claim",
			"device:device-1:result",
			"device:device-1:heartbeat",
		]);
		expect(userRateLimitKey("user-1", "device:register")).toBe(
			"user:user-1:device:register",
		);
		expect(webhookRateLimitKey("grafana")).toBe("webhook:grafana:global");
	});
});

describe("client address resolution", () => {
	test("trusts x-forwarded-for only with the explicit flag", () => {
		expect(isTrustProxyHeadersEnabled({})).toBe(false);
		expect(isTrustProxyHeadersEnabled({ TRUST_PROXY_HEADERS: "false" })).toBe(
			false,
		);
		expect(isTrustProxyHeadersEnabled({ TRUST_PROXY_HEADERS: "1" })).toBe(
			false,
		);
		expect(isTrustProxyHeadersEnabled({ TRUST_PROXY_HEADERS: " true " })).toBe(
			true,
		);

		const request = new Request("http://localhost/api/device/claim", {
			method: "POST",
			headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" },
		});
		expect(readClientIp(request, false)).toBe(UNTRUSTED_CLIENT_IP);
		expect(readClientIp(request, true)).toBe("198.51.100.9");
		expect(
			readClientIp(
				new Request("http://localhost/api/device/claim", { method: "POST" }),
				true,
			),
		).toBe(UNTRUSTED_CLIENT_IP);
	});

	test("a malformed or oversized address collapses to the shared bucket", () => {
		expect(normalizeClientIp(null)).toBe(UNTRUSTED_CLIENT_IP);
		expect(normalizeClientIp("")).toBe(UNTRUSTED_CLIENT_IP);
		expect(normalizeClientIp("not-an-ip")).toBe(UNTRUSTED_CLIENT_IP);
		expect(normalizeClientIp(`1.2.3.4; ${"a".repeat(64)}`)).toBe(
			UNTRUSTED_CLIENT_IP,
		);
		expect(normalizeClientIp("2001:DB8::1")).toBe("2001:db8::1");
	});
});

describe("enforceRateLimit", () => {
	test("allows exactly the limit and then returns the fixed 429", async () => {
		const limiter = new InMemoryRateLimitRepository();
		const input = {
			limiter,
			key: deviceIpRateLimitKey("203.0.113.7"),
			limit: 2,
			windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
			now: MID_WINDOW,
		};
		expect(await enforceRateLimit(input)).toBeNull();
		expect(await enforceRateLimit(input)).toBeNull();
		const denied = await enforceRateLimit(input);
		expect(denied).not.toBeNull();
		if (denied === null) throw new Error("expected a denial");
		expect(denied.status).toBe(429);
		expect(denied.headers.get("cache-control")).toBe("no-store");
		// 50 seconds of the window remain at 00:00:10.
		expect(denied.headers.get("retry-after")).toBe("50");
		expect(await denied.json()).toEqual({ error: "too many requests" });
	});

	test("a new window resets the bucket", async () => {
		const limiter = new InMemoryRateLimitRepository();
		const base = {
			limiter,
			key: deviceRateLimitKey("device-1", "claim"),
			limit: 1,
			windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
		};
		expect(await enforceRateLimit({ ...base, now: MID_WINDOW })).toBeNull();
		expect(await enforceRateLimit({ ...base, now: MID_WINDOW })).not.toBeNull();
		expect(
			await enforceRateLimit({
				...base,
				now: new Date(WINDOW_START.getTime() + 60_000),
			}),
		).toBeNull();
	});

	test("a limiter failure propagates instead of failing open", async () => {
		const limiter = {
			async consume(): Promise<never> {
				throw new Error("database is unavailable");
			},
		};
		await expect(
			enforceRateLimit({
				limiter,
				key: "user:user-1:device:list",
				limit: 1,
				windowSeconds: 60,
			}),
		).rejects.toThrow("database is unavailable");
	});
});

describe("rateLimitedResponse", () => {
	test("is one fixed shape with a positive integer Retry-After", () => {
		for (const [input, expected] of [
			[0, "1"],
			[0.2, "1"],
			[42, "42"],
			[Number.NaN, "1"],
		] as const) {
			const response = rateLimitedResponse(input);
			expect(response.status).toBe(429);
			expect(response.headers.get("retry-after")).toBe(expected);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("pragma")).toBeNull();
		}
	});
});

describe("per-user gate", () => {
	test("enforces the action budget and throws with the retry hint", async () => {
		const limiter = new InMemoryRateLimitRepository();
		const gate = createUserRateLimitGate(limiter);
		for (
			let index = 0;
			index < USER_RATE_LIMITS["device:register"];
			index += 1
		) {
			await expect(gate.enforce("user-1", "device:register")).resolves.toBe(
				undefined,
			);
		}
		try {
			await gate.enforce("user-1", "device:register");
			throw new Error("expected a RateLimitExceededError");
		} catch (error) {
			expect(error).toBeInstanceOf(RateLimitExceededError);
			expect(
				(error as RateLimitExceededError).retryAfterSeconds,
			).toBeGreaterThanOrEqual(1);
			// The fixed message never carries the key, user or counter.
			expect((error as RateLimitExceededError).message).toBe(
				"rate limit exceeded",
			);
		}
	});

	test("keeps one bucket per action and per user", async () => {
		const limiter = new InMemoryRateLimitRepository();
		const gate = createUserRateLimitGate(limiter);
		for (
			let index = 0;
			index < USER_RATE_LIMITS["connector:connect"];
			index += 1
		) {
			await gate.enforce("user-1", "connector:connect");
		}
		await expect(
			gate.enforce("user-1", "connector:connect"),
		).rejects.toBeInstanceOf(RateLimitExceededError);
		// A different action and a different user start from zero.
		await expect(
			gate.enforce("user-1", "connector:list"),
		).resolves.toBeUndefined();
		await expect(
			gate.enforce("user-2", "connector:connect"),
		).resolves.toBeUndefined();
	});
});
