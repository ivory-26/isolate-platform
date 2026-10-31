import { describe, expect, test } from "bun:test";
import {
	createHoneycombReadTools,
	getHoneycombTrigger,
	listHoneycombSlos,
	runHoneycombQuery,
} from "./tools";
import type { HoneycombContextDependencies, HoneycombFetchLike } from "./types";

const API_KEY = "hny-config-key-0123456789";
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";

const SNAPSHOT = {
	id: "trg-1",
	name: "Checkout latency",
	state: "triggered" as const,
	threshold: { op: ">" as const, value: 500 },
	observed: 900,
	url: "https://ui.honeycomb.io/checkout/triggers/trg-1",
};

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type RouterOptions = {
	queryStatus?: number;
	sloStatus?: number;
	sloBody?: unknown;
};

function router(options: RouterOptions = {}): {
	impl: HoneycombFetchLike;
	calls: string[];
} {
	const calls: string[] = [];
	const impl: HoneycombFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const path = new URL(url).pathname;
		const method = init?.method ?? "GET";
		calls.push(`${method} ${path}`);
		if (method === "POST" && path === "/1/queries/checkout") {
			const status = options.queryStatus ?? 200;
			return status === 200
				? json(200, { id: "query-1" })
				: json(status, { message: "provider text" });
		}
		if (method === "POST" && path === "/1/query_results/checkout") {
			const status = options.queryStatus ?? 200;
			return status === 200
				? json(200, { id: "result-1", complete: true })
				: json(status, { message: "provider text" });
		}
		if (method === "GET" && path === "/1/query_results/checkout/result-1") {
			const status = options.queryStatus ?? 200;
			return status === 200
				? json(200, {
						id: "result-1",
						complete: true,
						data: {
							series: [
								{
									name: {
										"service.name": "checkout-api",
										"http.route": "/pay",
									},
									data: [{ time: RECEIVED_AT, P95: 1234 }],
								},
							],
						},
					})
				: json(status, { message: "provider text" });
		}
		if (method === "GET" && path === "/1/slos/checkout") {
			const status = options.sloStatus ?? 200;
			return status === 200
				? json(200, options.sloBody ?? [])
				: json(status, { message: "provider text" });
		}
		return json(404, { message: "not found" });
	};
	return { impl, calls };
}

function dependencies(
	impl: HoneycombFetchLike,
	overrides: Partial<HoneycombContextDependencies> = {},
): HoneycombContextDependencies {
	return {
		apiKey: API_KEY,
		dataset: "checkout",
		fetchImpl: impl,
		now: () => Date.parse(RECEIVED_AT),
		trigger: SNAPSHOT,
		...overrides,
	};
}

describe("Honeycomb read-only tools", () => {
	test("exports the three read-only descriptors", () => {
		const { impl } = router();
		const tools = createHoneycombReadTools(dependencies(impl));
		expect(tools.map((tool) => tool.name)).toEqual([
			"honeycomb.run_query",
			"honeycomb.get_trigger",
			"honeycomb.list_slos",
		]);
		for (const tool of tools) {
			expect(tool.risk).toBe("read_only");
			expect(tool.inputSchema).toBeDefined();
		}
	});

	test("run_query returns one bounded query item in three calls", async () => {
		const { impl, calls } = router();
		const result = await runHoneycombQuery(dependencies(impl), {
			kind: "latency",
			service: "checkout-api",
			windowMinutes: 60,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tool).toBe("honeycomb.run_query");
		expect(result.risk).toBe("read_only");
		expect(result.item?.kind).toBe("query_result");
		expect(result.item?.source).toBe("honeycomb");
		expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(result.item?.excerpt).toContain("P95=1234");
		expect(result.truncated).toBe(false);
		expect(calls).toEqual([
			"POST /1/queries/checkout",
			"POST /1/query_results/checkout",
			"GET /1/query_results/checkout/result-1",
		]);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	test("run_query rejects model-authored fields before any call", async () => {
		const { impl, calls } = router();
		for (const input of [
			{ kind: "latency", service: "checkout-api", query: "raw span text" },
			{ kind: "arbitrary", service: "checkout-api" },
			{ kind: "latency", service: "bad service" },
			{ kind: "latency", service: "checkout-api", windowMinutes: 9999 },
		]) {
			const result = await runHoneycombQuery(dependencies(impl), input);
			expect(result).toMatchObject({
				ok: false,
				code: "VALIDATION_FAILED",
			});
		}
		expect(calls).toHaveLength(0);
	});

	test("run_query maps provider failures to typed codes", async () => {
		for (const [status, code] of [
			[403, "POLICY_DENIED"],
			[404, "NOT_FOUND"],
			[500, "INTEGRATION_UNAVAILABLE"],
			[401, "INTEGRATION_UNAVAILABLE"],
			[429, "RATE_LIMITED"],
		] as const) {
			const { impl } = router({ queryStatus: status });
			const result = await runHoneycombQuery(dependencies(impl), {
				kind: "latency",
				service: "checkout-api",
			});
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.code).toBe(code);
			expect(result.message).not.toContain(API_KEY);
		}
	});

	test("get_trigger re-reads the intake snapshot without a provider call", async () => {
		const { impl, calls } = router();
		const result = await getHoneycombTrigger(dependencies(impl), {
			triggerId: "trg-1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.item?.kind).toBe("trigger");
		expect(result.item?.excerpt).toContain("Threshold: > 500");
		expect(result.item?.excerpt).toContain("Observed: 900");
		expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(calls).toHaveLength(0);
	});

	test("get_trigger returns NOT_FOUND for an unknown or absent snapshot", async () => {
		const { impl } = router();
		const mismatch = await getHoneycombTrigger(dependencies(impl), {
			triggerId: "trg-2",
		});
		expect(mismatch).toMatchObject({ ok: false, code: "NOT_FOUND" });

		const absent = await getHoneycombTrigger(
			dependencies(impl, { trigger: null }),
			{ triggerId: "trg-1" },
		);
		expect(absent).toMatchObject({ ok: false, code: "NOT_FOUND" });

		const invalid = await getHoneycombTrigger(dependencies(impl), {
			triggerId: "BAD ID",
		});
		expect(invalid).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
	});

	test("list_slos treats an empty Free-plan list as truncated success", async () => {
		const { impl, calls } = router({ sloBody: [] });
		const result = await listHoneycombSlos(dependencies(impl), {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.item).toBeNull();
		expect(result.truncated).toBe(true);
		expect(calls).toEqual(["GET /1/slos/checkout"]);
	});

	test("list_slos treats 403 and 404 as truncated success", async () => {
		for (const status of [403, 404] as const) {
			const { impl } = router({ sloStatus: status });
			const result = await listHoneycombSlos(dependencies(impl), {});
			expect(result.ok).toBe(true);
			if (!result.ok) continue;
			expect(result.item).toBeNull();
			expect(result.truncated).toBe(true);
		}
	});

	test("list_slos keeps 401, 429 and 5xx as failures", async () => {
		for (const [status, code] of [
			[401, "INTEGRATION_UNAVAILABLE"],
			[429, "RATE_LIMITED"],
			[500, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ sloStatus: status });
			const result = await listHoneycombSlos(dependencies(impl), {});
			expect(result).toMatchObject({ ok: false, code });
		}
	});

	test("list_slos rejects unknown arguments without a call", async () => {
		const { impl, calls } = router();
		const result = await listHoneycombSlos(dependencies(impl), {
			limit: 10,
		});
		expect(result).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});
});
