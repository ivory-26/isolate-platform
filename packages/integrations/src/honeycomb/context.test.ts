import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	buildHoneycombQuery,
	fetchHoneycombIncidentContext,
	HONEYCOMB_CONTEXT_MAX_FETCH_CALLS,
	HONEYCOMB_CONTEXT_MAX_ITEMS,
	HONEYCOMB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES,
} from "./context";
import { redactHoneycombText } from "./redact";
import type { HoneycombContextDependencies, HoneycombFetchLike } from "./types";

const API_KEY = "hny-config-key-0123456789";
const WEBHOOK_TOKEN = "webhook-token-0123456789";
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";
const FINGERPRINT = "honeycomb:checkout:trg-1:triggered";

const SNAPSHOT = {
	id: "trg-1",
	name: "Checkout latency",
	state: "triggered" as const,
	threshold: { op: ">" as const, value: 500 },
	observed: 900,
	url: "https://ui.honeycomb.io/checkout/triggers/trg-1",
};

type Call = { url: string; init: RequestInit };

type RouterOptions = {
	queryCreateStatus?: number;
	queryRunStatus?: number;
	queryResultStatus?: number;
	sloStatus?: number;
	resultBody?: unknown;
	sloBody?: unknown;
	seriesCount?: number;
	route?: string;
	transportError?: boolean;
	oversizedResult?: boolean;
};

function json(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function series(count: number, route: string) {
	return Array.from({ length: count }, (_, index) => ({
		name: {
			"service.name": "checkout-api",
			"http.route": `${route}/${index}`,
			"host.name": "db.internal",
		},
		data: [{ time: "2026-10-31T00:00:00Z", P95: 120 + index, count: 7 }],
	}));
}

function router(options: RouterOptions = {}): {
	impl: HoneycombFetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl: HoneycombFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const call = { url, init: init ?? {} };
		calls.push(call);
		if (options.transportError === true) {
			throw new TypeError(`connection reset ${API_KEY}`);
		}
		const path = new URL(url).pathname;
		const method = init?.method ?? "GET";
		if (method === "POST" && path === "/1/queries/checkout") {
			const status = options.queryCreateStatus ?? 200;
			if (status !== 200) return json(status, { message: "provider text" });
			return json(200, { id: "query-1" });
		}
		if (method === "POST" && path === "/1/query_results/checkout") {
			const status = options.queryRunStatus ?? 200;
			if (status !== 200) return json(status, { message: "provider text" });
			return json(200, { id: "result-1", complete: true });
		}
		if (method === "GET" && path === "/1/query_results/checkout/result-1") {
			const status = options.queryResultStatus ?? 200;
			if (status !== 200) return json(status, { message: "provider text" });
			if (options.oversizedResult === true) {
				return json(
					200,
					{ id: "result-1", complete: true },
					{ "content-length": String(300 * 1024) },
				);
			}
			return json(
				200,
				options.resultBody ?? {
					id: "result-1",
					complete: true,
					data: {
						series: series(
							options.seriesCount ?? 3,
							options.route ?? "https://checkout.example.com/pay",
						),
					},
				},
			);
		}
		if (method === "GET" && path === "/1/slos/checkout") {
			const status = options.sloStatus ?? 200;
			if (status !== 200) return json(status, { message: "provider text" });
			return json(
				200,
				options.sloBody ?? [
					{
						id: "slo-1",
						name: "Checkout availability",
						target: 0.999,
						current: 0.9995,
						status: "ok",
						time_window_days: 30,
						description: "owned by ops@example.com",
						owner: "Platform Team",
					},
				],
			);
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
		webhookToken: WEBHOOK_TOKEN,
		fetchImpl: impl,
		now: () => Date.parse(RECEIVED_AT),
		trigger: SNAPSHOT,
		...overrides,
	};
}

const INPUT = {
	incidentFingerprint: FINGERPRINT,
	service: "checkout-api",
	kind: "latency" as const,
	windowMinutes: 60,
};

function totalBytes(bundle: { items: readonly { excerpt: string }[] }): number {
	return new TextEncoder().encode(
		bundle.items.map((item) => item.excerpt).join(""),
	).byteLength;
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
	if (call === undefined || typeof call.init.body !== "string") {
		throw new Error("expected a JSON request body");
	}
	const parsed: unknown = JSON.parse(call.init.body);
	if (parsed === null || typeof parsed !== "object") {
		throw new Error("expected a JSON object body");
	}
	return parsed as Record<string, unknown>;
}

function headersOf(call: Call | undefined): Record<string, string> {
	if (call === undefined) throw new Error("missing call");
	return call.init.headers as Record<string, string>;
}

function codeOf(error: unknown): string {
	return error instanceof PlatformError ? error.code : "not-a-platform-error";
}

describe("fetchHoneycombIncidentContext", () => {
	test("assembles a contract-valid bundle from a four-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchHoneycombIncidentContext(
			dependencies(impl),
			INPUT,
		);

		expect(bundle.incidentFingerprint).toBe(FINGERPRINT);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"trigger",
			"query_result",
			"slo",
		]);
		expect(bundle.items.length).toBeLessThanOrEqual(
			HONEYCOMB_CONTEXT_MAX_ITEMS,
		);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			HONEYCOMB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES,
		);
		for (const item of bundle.items) {
			expect(item.source).toBe("honeycomb");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe(RECEIVED_AT);
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.excerpt.length).toBeLessThanOrEqual(4000);
			expect(item.url?.startsWith("https://")).toBe(true);
		}
		const query = bundle.items.find((item) => item.kind === "query_result");
		expect(query?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(query?.excerpt).toContain("Rows: 3");
		expect(query?.excerpt).toContain("P95=120");
		expect(query?.excerpt).toContain("Window: 60m");
		expect(bundle.truncated).toBe(false);

		expect(calls.length).toBe(4);
		expect(calls.length).toBeLessThanOrEqual(HONEYCOMB_CONTEXT_MAX_FETCH_CALLS);
		expect(
			calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`),
		).toEqual([
			"POST /1/queries/checkout",
			"POST /1/query_results/checkout",
			"GET /1/query_results/checkout/result-1",
			"GET /1/slos/checkout",
		]);
		for (const call of calls) {
			expect(headersOf(call)["X-Honeycomb-Team"]).toBe(API_KEY);
			expect(call.url).not.toContain("/1/events");
			expect(call.url).not.toContain("/links");
		}

		const queryBody = bodyOf(calls[0]);
		expect(queryBody.time_range).toBe(3600);
		expect(queryBody.limit).toBe(20);
		expect(queryBody.calculations).toEqual([
			{ op: "P95", column: "duration_ms" },
		]);
		expect(queryBody.filters).toEqual([
			{ column: "service.name", op: "=", value: "checkout-api" },
		]);
		expect(bodyOf(calls[1])).toEqual({ query_id: "query-1" });

		expect(JSON.stringify(bundle)).not.toContain(API_KEY);
		expect(JSON.stringify(bundle)).not.toContain(WEBHOOK_TOKEN);
		expect(JSON.stringify(bundle)).not.toContain("ops@example.com");
		expect(JSON.stringify(bundle)).not.toContain("Platform Team");
	});

	test("uses fixed templates for each query kind", async () => {
		const latency = buildHoneycombQuery({
			kind: "latency",
			service: "checkout-api",
			windowMinutes: 9999,
		});
		expect(latency.time_range).toBe(3600);
		expect(latency.limit).toBe(20);
		expect(latency.breakdowns).toEqual(["http.route"]);

		const errors = buildHoneycombQuery({
			kind: "error_rate",
			service: "checkout-api",
		});
		expect(errors.calculations).toEqual([{ op: "COUNT" }]);
		expect(errors.filters).toContainEqual({
			column: "error",
			op: "=",
			value: true,
		});
		expect(errors.time_range).toBe(3600);

		const saturation = buildHoneycombQuery({
			kind: "saturation",
			service: "checkout-api",
		});
		expect(saturation.calculations).toEqual([
			{ op: "AVG", column: "system.cpu.utilization" },
		]);
		expect(saturation.breakdowns).toEqual(["service.name"]);
	});

	test("refuses an identifier outside the fixed query template", () => {
		let error: unknown;
		try {
			buildHoneycombQuery({
				kind: "latency",
				service: "checkout api; drop table",
			});
		} catch (thrown) {
			error = thrown;
		}
		expect(codeOf(error)).toBe("VALIDATION_FAILED");
	});

	test("redacts credentials, emails, IPs and hostname fields before truncation", async () => {
		const route = `pay?mail=ops@example.com&ip=10.1.2.3&key=${API_KEY}&token=${WEBHOOK_TOKEN}`;
		const { impl } = router({ route });
		const bundle = await fetchHoneycombIncidentContext(
			dependencies(impl),
			INPUT,
		);
		const query = bundle.items.find((item) => item.kind === "query_result");
		expect(query?.excerpt).toContain("[email-redacted]");
		expect(query?.excerpt).toContain("[ip-redacted]");
		expect(query?.excerpt).not.toContain("ops@example.com");
		expect(query?.excerpt).not.toContain("10.1.2.3");
		expect(query?.excerpt).not.toContain(API_KEY);
		expect(query?.excerpt).not.toContain(WEBHOOK_TOKEN);
		expect(query?.excerpt).not.toContain("host.name");
	});

	test("redacts hostname-valued fields in provider text", () => {
		const redacted = redactHoneycombText(
			"host=db.internal hostname=node-1 server.name=api.internal",
		);
		expect(redacted).not.toContain("db.internal");
		expect(redacted).not.toContain("node-1");
		expect(redacted).not.toContain("api.internal");
		expect(redacted).toContain("[host-redacted]");
	});

	test("keeps a partial bundle when the SLO list is denied or empty", async () => {
		for (const options of [
			{ sloStatus: 403 },
			{ sloStatus: 404 },
			{ sloBody: [] },
		] as const) {
			const { impl } = router(options);
			const bundle = await fetchHoneycombIncidentContext(
				dependencies(impl),
				INPUT,
			);
			expect(bundle.items.map((item) => item.kind)).not.toContain("slo");
			expect(bundle.items.map((item) => item.kind)).toContain("query_result");
			expect(bundle.truncated).toBe(true);
		}
	});

	test("keeps a partial bundle when query creation is denied", async () => {
		const { impl, calls } = router({ queryCreateStatus: 403 });
		const bundle = await fetchHoneycombIncidentContext(
			dependencies(impl),
			INPUT,
		);
		expect(bundle.items.map((item) => item.kind)).toEqual(["trigger", "slo"]);
		expect(bundle.truncated).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("maps 429 to RATE_LIMITED and 401 to INTEGRATION_UNAVAILABLE", async () => {
		for (const [status, code] of [
			[429, "RATE_LIMITED"],
			[401, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ queryCreateStatus: status });
			let error: unknown;
			try {
				await fetchHoneycombIncidentContext(dependencies(impl), INPUT);
			} catch (thrown) {
				error = thrown;
			}
			expect(codeOf(error)).toBe(code);
			expect(String((error as Error).message)).not.toContain(API_KEY);
		}
	});

	test("maps a transport failure without echoing provider text", async () => {
		const { impl } = router({ transportError: true });
		let error: unknown;
		try {
			await fetchHoneycombIncidentContext(dependencies(impl), INPUT);
		} catch (thrown) {
			error = thrown;
		}
		expect(codeOf(error)).toBe("INTEGRATION_UNAVAILABLE");
		expect(String((error as Error).message)).not.toContain(API_KEY);
	});

	test("drops an oversized query result and marks the bundle truncated", async () => {
		const { impl } = router({ oversizedResult: true });
		const bundle = await fetchHoneycombIncidentContext(
			dependencies(impl),
			INPUT,
		);
		expect(bundle.items.map((item) => item.kind)).not.toContain("query_result");
		expect(bundle.truncated).toBe(true);
	});

	test("enforces the row, item and excerpt caps", async () => {
		const { impl } = router({
			seriesCount: 50,
			route: `route-${"x".repeat(200)}`,
		});
		const bundle = await fetchHoneycombIncidentContext(
			dependencies(impl, { maxItems: 8 }),
			INPUT,
		);
		expect(bundle.items.length).toBeLessThanOrEqual(8);
		const query = bundle.items.find((item) => item.kind === "query_result");
		expect(query?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(query?.excerpt).toContain("capped");
		for (const item of bundle.items) {
			expect(item.excerpt.length).toBeLessThanOrEqual(4000);
		}
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			HONEYCOMB_CONTEXT_MAX_TOTAL_EXCERPT_BYTES,
		);
		expect(bundle.truncated).toBe(true);

		const capped = await fetchHoneycombIncidentContext(
			dependencies(impl, { maxItems: 1 }),
			INPUT,
		);
		expect(capped.items).toHaveLength(1);
		expect(capped.items[0]?.kind).toBe("trigger");
		expect(capped.truncated).toBe(true);
	});

	test("rejects invalid inputs before any provider call", async () => {
		const { impl, calls } = router();
		for (const [deps, input] of [
			[{ dataset: "BAD DATASET" }, INPUT],
			[{}, { ...INPUT, service: "not a service" }],
			[{}, { ...INPUT, incidentFingerprint: "" }],
		] as const) {
			let error: unknown;
			try {
				await fetchHoneycombIncidentContext(dependencies(impl, deps), input);
			} catch (thrown) {
				error = thrown;
			}
			expect(codeOf(error)).toBe("VALIDATION_FAILED");
		}
		expect(calls).toHaveLength(0);

		const missingKey = await fetchHoneycombIncidentContext(
			dependencies(impl, { apiKey: "" }),
			INPUT,
		).catch((thrown: unknown) => thrown);
		expect(codeOf(missingKey)).toBe("INTEGRATION_UNAVAILABLE");
		expect(calls).toHaveLength(0);
	});
});
