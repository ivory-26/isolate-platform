import { describe, expect, test } from "bun:test";
import type { DeviceCall, DispatchOutcome } from "./contracts";
import { createMemoryLogger } from "./logger";
import { computeBackoffDelay, runPollLoop } from "./poll";

const TOKEN = "B".repeat(43);

function deviceCall(overrides: Partial<DeviceCall> = {}): DeviceCall {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		connectorId: "sentry",
		credentialRef: "keychain:isolate/test",
		toolName: "sentry.list_issues",
		params: { orgSlug: "acme", query: "PARAM_SECRET_VALUE" },
		deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

const okDispatch = async (): Promise<DispatchOutcome> => ({
	ok: true,
	data: { items: [] },
});

function noopSleep(): Promise<void> {
	return Promise.resolve();
}

describe("backoff", () => {
	test("is exponential, jittered and hard-bounded", () => {
		const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
			computeBackoffDelay(attempt, 500, 8_000, () => 1),
		);
		expect(delays).toEqual([
			500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000,
		]);
		expect(computeBackoffDelay(10, 500, 8_000, () => 0.5)).toBeLessThanOrEqual(
			8_000,
		);
		expect(computeBackoffDelay(1, 500, 8_000, () => 0)).toBe(250);
	});
});

describe("poll loop", () => {
	test("stops immediately on 401 without retrying", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const fetchImpl = (async () => {
			calls += 1;
			return new Response("", { status: 401 });
		}) as unknown as typeof fetch;
		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			maxClaims: 5,
		});
		expect(result.reason).toBe("unauthorized");
		expect(calls).toBe(1);
		expect(sleeps).toEqual([]);
	});

	test("backs off with a ceiling on repeated 5xx", async () => {
		const sleeps: number[] = [];
		const fetchImpl = (async () =>
			new Response("", { status: 503 })) as unknown as typeof fetch;
		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 1,
			baseBackoffMs: 500,
			maxBackoffMs: 8_000,
			maxClaims: 9,
		});
		expect(result.reason).toBe("stopped");
		expect(sleeps).toEqual([
			500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000,
		]);
	});

	test("treats a malformed claim body as retryable", async () => {
		const sleeps: number[] = [];
		const fetchImpl = (async () =>
			new Response("not json", { status: 200 })) as unknown as typeof fetch;
		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 1,
			baseBackoffMs: 500,
			maxClaims: 1,
		});
		expect(result.reason).toBe("stopped");
		expect(sleeps).toEqual([500]);
	});

	test("stops on a non-retryable gateway status", async () => {
		const fetchImpl = (async () =>
			new Response("", { status: 400 })) as unknown as typeof fetch;
		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: noopSleep,
			maxClaims: 3,
		});
		expect(result.reason).toBe("fatal");
		expect(result.detail).toBe("claim status 400");
	});

	test("sleeps the poll interval when there is no call", async () => {
		const sleeps: number[] = [];
		const fetchImpl = (async () =>
			Response.json({ call: null })) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			pollIntervalMs: 1_234,
			maxClaims: 2,
		});
		expect(sleeps).toEqual([1_234, 1_234]);
	});

	test("claims, dispatches and posts a bounded result without leaking fields", async () => {
		const logger = createMemoryLogger();
		const headers: Array<string | null> = [];
		const posted: unknown[] = [];
		let claimCount = 0;
		const call = deviceCall();
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			const rawHeaders = init?.headers as Record<string, string> | undefined;
			headers.push(rawHeaders?.authorization ?? null);
			if (url.includes("/api/device/claim")) {
				claimCount += 1;
				return Response.json({ call: claimCount === 1 ? call : null });
			}
			posted.push(JSON.parse(String(init?.body)));
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;

		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com/",
			deviceToken: TOKEN,
			dispatch: async () => ({ ok: true, data: { items: [{ id: "1" }] } }),
			fetchImpl,
			sleep: noopSleep,
			logger,
			maxClaims: 2,
		});

		expect(result.reason).toBe("stopped");
		expect(posted).toEqual([{ ok: true, data: { items: [{ id: "1" }] } }]);
		expect(headers).toEqual([
			`Bearer ${TOKEN}`,
			`Bearer ${TOKEN}`,
			`Bearer ${TOKEN}`,
		]);
		expect(logger.lines).toHaveLength(1);
		const line = logger.lines[0] ?? "";
		expect(line).toContain("sentry.list_issues");
		expect(line).toContain("connector");
		expect(line).toContain('"outcome":"ok"');
		expect(line).toContain("durationMs");
		expect(line).not.toContain(TOKEN);
		expect(line).not.toContain("PARAM_SECRET_VALUE");
	});

	test("does not dispatch a call whose deadline has passed", async () => {
		let dispatched = 0;
		const posted: unknown[] = [];
		let claimCount = 0;
		const call = deviceCall({
			deadlineAt: new Date(Date.now() - 1_000).toISOString(),
		});
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			if (String(input).includes("/api/device/claim")) {
				claimCount += 1;
				return Response.json({ call: claimCount === 1 ? call : null });
			}
			posted.push(JSON.parse(String(init?.body)));
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: async () => {
				dispatched += 1;
				return { ok: true, data: {} };
			},
			fetchImpl,
			sleep: noopSleep,
			maxClaims: 2,
		});
		expect(dispatched).toBe(0);
		expect(posted).toEqual([
			{ ok: false, errorCode: "INTEGRATION_UNAVAILABLE" },
		]);
	});

	test("stops when the result endpoint rejects the token", async () => {
		let claimCount = 0;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("/api/device/claim")) {
				claimCount += 1;
				return Response.json({ call: claimCount === 1 ? deviceCall() : null });
			}
			return new Response("", { status: 401 });
		}) as unknown as typeof fetch;
		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: noopSleep,
			maxClaims: 3,
		});
		expect(result.reason).toBe("unauthorized");
		expect(claimCount).toBe(1);
	});

	test("retries a result post a bounded number of times", async () => {
		let claimCount = 0;
		let resultCalls = 0;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("/api/device/claim")) {
				claimCount += 1;
				return Response.json({ call: claimCount === 1 ? deviceCall() : null });
			}
			resultCalls += 1;
			return new Response("", { status: resultCalls === 1 ? 500 : 200 });
		}) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: noopSleep,
			maxClaims: 2,
			random: () => 1,
		});
		expect(resultCalls).toBe(2);
	});
});

describe("batch claims", () => {
	test("requests a batch, processes it sequentially and posts every result", async () => {
		const first = deviceCall();
		const second = deviceCall({
			id: "33333333-3333-4333-8333-333333333333",
			toolName: "sentry.issue_comments",
		});
		const claimUrls: string[] = [];
		const dispatched: string[] = [];
		const posted: Array<{ callId: string; body: unknown }> = [];
		let claimCount = 0;
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			if (url.includes("/api/device/claim")) {
				claimUrls.push(url);
				claimCount += 1;
				return claimCount === 1
					? Response.json({ calls: [first, second] })
					: Response.json({ call: null });
			}
			const match = /\/api\/device\/calls\/([^/]+)\/result$/.exec(url);
			posted.push({
				callId: decodeURIComponent(match?.[1] ?? ""),
				body: JSON.parse(String(init?.body)),
			});
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;

		const result = await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: async (call) => {
				dispatched.push(call.id);
				return { ok: true, data: { callId: call.id } };
			},
			fetchImpl,
			sleep: noopSleep,
			maxClaims: 2,
		});

		expect(result.reason).toBe("stopped");
		expect(claimUrls).toHaveLength(2);
		expect(claimUrls[0]).toContain("/api/device/claim?limit=4");
		// Strictly sequential and in the server's order.
		expect(dispatched).toEqual([first.id, second.id]);
		expect(posted.map((entry) => entry.callId)).toEqual([first.id, second.id]);
		expect(posted[0]?.body).toEqual({
			ok: true,
			data: { callId: first.id },
		});
	});

	test("an empty calls envelope is no work and sleeps the poll interval", async () => {
		const sleeps: number[] = [];
		const fetchImpl = (async () =>
			Response.json({ calls: [] })) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			pollIntervalMs: 900,
			maxClaims: 2,
		});
		expect(sleeps).toEqual([900, 900]);
	});

	test("a malformed batch envelope is retryable", async () => {
		const sleeps: number[] = [];
		const fetchImpl = (async () =>
			Response.json({
				calls: [{ id: "not-a-uuid" }],
			})) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 1,
			baseBackoffMs: 500,
			maxClaims: 1,
		});
		expect(sleeps).toEqual([500]);
	});

	test("the requested batch size is bounded to 1..10", async () => {
		const urls: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return Response.json({ call: null });
		}) as unknown as typeof fetch;
		await runPollLoop({
			serverUrl: "https://isolate.example.com",
			deviceToken: TOKEN,
			dispatch: okDispatch,
			fetchImpl,
			sleep: noopSleep,
			claimBatchSize: 99,
			maxClaims: 1,
		});
		expect(urls[0]).toContain("?limit=10");
	});
});
