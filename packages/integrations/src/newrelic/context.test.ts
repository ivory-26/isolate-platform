import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PlatformError } from "@isolate/shared";
import {
	fetchNewRelicContext,
	NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS,
	NEWRELIC_CONTEXT_MAX_SUMMARY_CHARS,
	NEWRELIC_CONTEXT_MAX_TOTAL_EXCERPT_BYTES,
	NEWRELIC_EU_ENDPOINT,
	NEWRELIC_US_ENDPOINT,
} from "./context";

const API_KEY = ["NRAK","test","key"].join("-");
const ACCOUNT = "1234567";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const STARTS_AT = "2026-10-30T23:45:00.000Z";
const GUID = "NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI";

type Captured = {
	url: string;
	query: string;
	variables: Record<string, unknown>;
	headers: Headers;
};

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function entity(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		guid: GUID,
		accountId: Number(ACCOUNT),
		name: "checkout-api",
		type: "APPLICATION",
		domain: "APM",
		alertSeverity: "CRITICAL",
		reporting: true,
		tags: [
			{ key: "service", values: ["checkout"] },
			{ key: "environment", values: ["production"] },
			{ key: "team", values: ["alice@example.com"] },
			{ key: "host", values: ["10.0.0.5"] },
		],
		...overrides,
	};
}

const ROWS = [
	{ count: 12, "error.class": "TimeoutError" },
	{ count: 3, "error.class": "alice@example.com from 10.0.0.5" },
	{ count: 1, accountId: "9999999" },
	{ count: 2, accountId: ACCOUNT },
];

type RouterOptions = {
	entityStatus?: number;
	entityBody?: unknown;
	searchStatus?: number;
	searchEntities?: unknown[];
	nrqlStatus?: number;
	rows?: unknown[];
	throwOn?: "entity" | "nrql";
};

function router(options: RouterOptions = {}): {
	impl: FetchLike;
	calls: Captured[];
} {
	const calls: Captured[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		const headers = new Headers(init?.headers);
		let body: { query?: unknown; variables?: unknown } = {};
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body) as typeof body;
			} catch {
				body = {};
			}
		}
		const query = typeof body.query === "string" ? body.query : "";
		const variables =
			body.variables !== null && typeof body.variables === "object"
				? (body.variables as Record<string, unknown>)
				: {};
		calls.push({ url, query, variables, headers });

		if (query.includes("entitySearch")) {
			const status = options.searchStatus ?? 200;
			if (status !== 200) return json(status, {});
			return json(200, {
				data: {
					actor: {
						entitySearch: {
							count: (options.searchEntities ?? [entity()]).length,
							results: { entities: options.searchEntities ?? [entity()] },
						},
					},
				},
			});
		}
		if (query.includes("entity(guid")) {
			if (options.throwOn === "entity") {
				throw new TypeError("fetch failed");
			}
			const status = options.entityStatus ?? 200;
			if (status !== 200) return json(status, {});
			const payload = options.entityBody ?? {
				data: { actor: { entity: entity() } },
			};
			return json(200, payload);
		}
		if (query.includes("nrql(query")) {
			if (options.throwOn === "nrql") {
				throw new TypeError("fetch failed");
			}
			const status = options.nrqlStatus ?? 200;
			if (status !== 200) return json(status, {});
			return json(200, {
				data: {
					actor: {
						account: {
							nrql: { results: options.rows ?? ROWS },
						},
					},
				},
			});
		}
		return json(400, {});
	};
	return { impl, calls };
}

function deps(
	impl: FetchLike,
	overrides: Partial<Parameters<typeof fetchNewRelicContext>[0]> = {},
): Parameters<typeof fetchNewRelicContext>[0] {
	return {
		apiKey: API_KEY,
		accountId: ACCOUNT,
		fetchImpl: impl,
		now: () => NOW_MS,
		...overrides,
	};
}

function contextInput(overrides: Record<string, unknown> = {}) {
	return {
		incidentFingerprint: "newrelic:abc123",
		service: "checkout",
		entityGuid: GUID,
		startsAt: STARTS_AT,
		windowMinutes: 30,
		...overrides,
	};
}

describe("fetchNewRelicContext", () => {
	test("builds a bounded, redacted, untrusted two-item bundle", async () => {
		const { impl, calls } = router();
		const bundle = await fetchNewRelicContext(deps(impl), contextInput());

		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe(NEWRELIC_US_ENDPOINT);
		expect(calls[0]?.headers.get("API-Key")).toBe(API_KEY);
		expect(calls[1]?.headers.get("API-Key")).toBe(API_KEY);
		const nrqlQuery = String(calls[1]?.variables.query);
		expect(calls[1]?.query).toContain("nrql(query");
		expect(nrqlQuery).toContain("FROM Transaction");
		expect(nrqlQuery).toContain("LIMIT 20");
		expect(nrqlQuery).toContain("SINCE");
		expect(nrqlQuery).toContain("UNTIL");
		expect(nrqlQuery).not.toContain("FROM Log");
		expect(nrqlQuery).not.toContain("SELECT *");

		expect(bundle.incidentFingerprint).toBe("newrelic:abc123");
		expect(bundle.items).toHaveLength(2);
		expect(bundle.truncated).toBe(false);

		for (const item of bundle.items) {
			expect(item.source).toBe("newrelic");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.excerpt.length).toBeLessThanOrEqual(
				NEWRELIC_CONTEXT_MAX_EXCERPT_CHARS,
			);
			expect(item.sha256).toBe(
				createHash("sha256").update(item.excerpt).digest("hex"),
			);
			expect(item.url?.startsWith("https://")).toBe(true);
		}

		const entityItem = bundle.items.find((item) => item.kind === "entity");
		expect(entityItem?.excerpt).toContain("Entity: checkout-api");
		expect(entityItem?.excerpt).toContain(`GUID: ${GUID}`);
		expect(entityItem?.excerpt).toContain("Account: 1234567");
		expect(entityItem?.excerpt).toContain("Tags: service=checkout");
		expect(entityItem?.excerpt).not.toContain("alice@example.com");
		expect(entityItem?.excerpt).not.toContain("10.0.0.5");

		const nrqlItem = bundle.items.find(
			(item) => item.kind === "nrql_aggregate",
		);
		expect(nrqlItem?.excerpt).toContain("Rows: 4");
		expect(nrqlItem?.excerpt).toContain("TimeoutError");
		expect(nrqlItem?.excerpt).not.toContain("alice@example.com");
		expect(nrqlItem?.excerpt).not.toContain("10.0.0.5");
		expect(nrqlItem?.excerpt).toContain("accountId=[account-redacted]");
		expect(nrqlItem?.excerpt).toContain(`accountId=${ACCOUNT}`);
		expect(nrqlItem?.excerpt).not.toContain(API_KEY);
	});

	test("caps the NRQL summary at 2,000 chars and 20 rows", async () => {
		const rows = Array.from({ length: 20 }, (_, index) => ({
			count: index,
			"error.class": "x".repeat(300),
		}));
		const { impl } = router({ rows });
		const bundle = await fetchNewRelicContext(deps(impl), contextInput());
		const item = bundle.items.find((entry) => entry.kind === "nrql_aggregate");
		expect(item).toBeDefined();
		expect(item?.excerpt.length ?? 0).toBeLessThanOrEqual(
			NEWRELIC_CONTEXT_MAX_SUMMARY_CHARS,
		);
		expect(bundle.truncated).toBe(true);
		const rowLines = (item?.excerpt ?? "")
			.split("\n")
			.filter((line) => line.startsWith("Row "));
		expect(rowLines.length).toBeLessThanOrEqual(20);
	});

	test("drops an over-cap NRQL row set instead of forwarding it", async () => {
		const rows = Array.from({ length: 25 }, (_, index) => ({ count: index }));
		const { impl } = router({ rows });
		const bundle = await fetchNewRelicContext(deps(impl), contextInput());
		expect(bundle.items.map((item) => item.kind)).toEqual(["entity"]);
		expect(bundle.truncated).toBe(true);
	});

	test("keeps a partial bundle on 403 and 404 entity lookups", async () => {
		for (const status of [403, 404]) {
			const { impl } = router({ entityStatus: status });
			const bundle = await fetchNewRelicContext(deps(impl), contextInput());
			expect(bundle.items.map((item) => item.kind)).toEqual(["nrql_aggregate"]);
			expect(bundle.truncated).toBe(true);
		}
	});

	test("fails closed on 401 and 429", async () => {
		for (const [status, code] of [
			[401, "INTEGRATION_UNAVAILABLE"],
			[429, "RATE_LIMITED"],
		] as const) {
			const { impl } = router({ entityStatus: status });
			await expect(
				fetchNewRelicContext(deps(impl), contextInput()),
			).rejects.toMatchObject({ code });
		}
	});

	test("fails closed on transport failure", async () => {
		const { impl } = router({ throwOn: "entity" });
		await expect(
			fetchNewRelicContext(deps(impl), contextInput()),
		).rejects.toBeInstanceOf(PlatformError);
	});

	test("never mixes an entity from another account", async () => {
		const { impl } = router({
			entityBody: {
				data: { actor: { entity: entity({ accountId: 9999999 }) } },
			},
		});
		const bundle = await fetchNewRelicContext(deps(impl), contextInput());
		expect(bundle.items.map((item) => item.kind)).toEqual(["nrql_aggregate"]);
		expect(bundle.truncated).toBe(true);
	});

	test("falls back to one entity search when no GUID is supplied", async () => {
		const { impl, calls } = router({
			searchEntities: [
				entity({ guid: "B-ENTITY", name: "beta" }),
				entity({ guid: "A-ENTITY", name: "alpha" }),
				entity({ guid: "OTHER", name: "foreign", accountId: 9999999 }),
			],
		});
		const bundle = await fetchNewRelicContext(
			deps(impl),
			contextInput({ entityGuid: null }),
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.query).toContain("entitySearch");
		expect(calls[0]?.variables.q).toBe("name LIKE '%checkout%'");
		expect(bundle.items[0]?.excerpt).toContain("Entity: alpha");
	});

	test("marks a requested window older than Free retention", async () => {
		const { impl } = router();
		const tenDaysAgo = new Date(
			NOW_MS - 10 * 24 * 60 * 60 * 1000,
		).toISOString();
		const bundle = await fetchNewRelicContext(
			deps(impl),
			contextInput({ startsAt: tenDaysAgo }),
		);
		const item = bundle.items.find((entry) => entry.kind === "nrql_aggregate");
		expect(item?.excerpt).toContain("Retention gap");
		expect(bundle.truncated).toBe(true);
	});

	test("honours per-call excerpt caps", async () => {
		const { impl } = router();
		const bundle = await fetchNewRelicContext(
			deps(impl, { maxExcerptChars: 120 }),
			contextInput(),
		);
		for (const item of bundle.items) {
			expect(item.excerpt.length).toBeLessThanOrEqual(120);
		}
		expect(bundle.truncated).toBe(true);
	});

	test("accepts the EU endpoint and rejects any other host", async () => {
		const { impl, calls } = router();
		const bundle = await fetchNewRelicContext(
			deps(impl, { endpoint: NEWRELIC_EU_ENDPOINT }),
			contextInput(),
		);
		expect(bundle.items.length).toBe(2);
		expect(calls.every((call) => call.url === NEWRELIC_EU_ENDPOINT)).toBe(true);

		const bad = router();
		for (const endpoint of [
			"https://api.example.com/graphql",
			"http://api.newrelic.com/graphql",
			"https://api.newrelic.com/other",
		]) {
			await expect(
				fetchNewRelicContext(deps(bad.impl, { endpoint }), contextInput()),
			).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		}
		expect(bad.calls).toHaveLength(0);
	});

	test("requires a configured key and valid account id", async () => {
		const { impl, calls } = router();
		await expect(
			fetchNewRelicContext(deps(impl, { apiKey: " " }), contextInput()),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
		await expect(
			fetchNewRelicContext(
				deps(impl, { accountId: "not-a-number" }),
				contextInput(),
			),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});

	test("bundle excerpts stay inside the shared byte budget", async () => {
		const { impl } = router({
			rows: Array.from({ length: 20 }, () => ({
				"error.class": "y".repeat(500),
				count: 1,
			})),
		});
		const bundle = await fetchNewRelicContext(deps(impl), contextInput());
		const bytes = new TextEncoder().encode(
			bundle.items.map((item) => item.excerpt).join(""),
		).byteLength;
		expect(bytes).toBeLessThanOrEqual(NEWRELIC_CONTEXT_MAX_TOTAL_EXCERPT_BYTES);
	});
});
