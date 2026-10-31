import { describe, expect, test } from "bun:test";
import type { NewRelicContextDependencies } from "./context";
import {
	checkReadOnlyNewRelicNrql,
	createNewRelicReadTools,
	getNewRelicEntity,
	isReadOnlyNewRelicNrql,
	listNewRelicAlertPolicies,
	NEWRELIC_TOOL_RISK_BANDS,
	type NewRelicNrqlRejection,
	runNewRelicNrql,
} from "./tools";

const API_KEY = "NRAK-TOOLSKEY0123456789ABCDEF";
const ACCOUNT = "1234567";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
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

function entity(overrides: Record<string, unknown> = {}) {
	return {
		guid: GUID,
		accountId: Number(ACCOUNT),
		name: "checkout-api",
		type: "APPLICATION",
		domain: "APM",
		alertSeverity: "CRITICAL",
		reporting: true,
		tags: [{ key: "service", values: ["checkout"] }],
		...overrides,
	};
}

type RouterOptions = {
	entityStatus?: number;
	entityBody?: unknown;
	nrqlStatus?: number;
	rows?: unknown[];
	policiesStatus?: number;
	policies?: unknown[];
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

		if (query.includes("entity(guid")) {
			const status = options.entityStatus ?? 200;
			if (status !== 200) return json(status, {});
			return json(
				200,
				options.entityBody ?? { data: { actor: { entity: entity() } } },
			);
		}
		if (query.includes("nrql(query")) {
			const status = options.nrqlStatus ?? 200;
			if (status !== 200) return json(status, {});
			return json(200, {
				data: {
					actor: {
						account: {
							nrql: {
								results: options.rows ?? [
									{ count: 12, "error.class": "TimeoutError" },
								],
							},
						},
					},
				},
			});
		}
		if (query.includes("policies")) {
			const status = options.policiesStatus ?? 200;
			if (status !== 200) return json(status, {});
			return json(200, {
				data: {
					actor: {
						account: {
							alerts: {
								policies: options.policies ?? [
									{ id: "1", name: "Checkout SLO" },
									{ id: "2", name: "Payments SLO" },
									{ id: "3", name: "Platform SLO" },
								],
							},
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
	overrides: Partial<NewRelicContextDependencies> = {},
): NewRelicContextDependencies {
	return {
		apiKey: API_KEY,
		accountId: ACCOUNT,
		fetchImpl: impl,
		now: () => NOW_MS,
		...overrides,
	};
}

describe("checkReadOnlyNewRelicNrql", () => {
	test("accepts a single bounded SELECT aggregate", () => {
		for (const query of [
			"SELECT count(*) FROM Transaction",
			"SELECT average(duration), percentile(duration, 95) FROM Transaction",
			"SELECT count(*) FROM Transaction WHERE appName = 'checkout' FACET error.class",
			"SELECT uniqueCount(userId) FROM PageView",
		]) {
			expect(checkReadOnlyNewRelicNrql(query)).toEqual({ ok: true });
			expect(isReadOnlyNewRelicNrql(query)).toBe(true);
		}
	});

	test("rejects every mutation, raw-row and unbounded shape", () => {
		const cases: Array<[string, NewRelicNrqlRejection]> = [
			["DELETE FROM Transaction", "not_select"],
			["DROP TABLE Transaction", "not_select"],
			[
				"SELECT count(*) FROM Transaction UPDATE x SET y = 1",
				"forbidden_keyword",
			],
			[
				"SELECT count(*) FROM Transaction; DELETE FROM Transaction",
				"multiple_statements",
			],
			["SELECT count(*) FROM Transaction -- comment", "comment"],
			["SELECT count(*) FROM Transaction /* comment */", "comment"],
			["SELECT * FROM Transaction", "wildcard_rows"],
			["SELECT count(*) FROM Log", "raw_logs"],
			["SELECT count(*) FROM Logging", "raw_logs"],
			["SELECT count(*) FROM Transaction TIMESERIES", "timeseries"],
			["SELECT count(*) FROM Transaction LIMIT 100", "caller_window"],
			["SELECT count(*) FROM Transaction SINCE 1 hour ago", "caller_window"],
			["SELECT foo FROM Transaction", "missing_aggregate"],
			["   ", "empty"],
			[`SELECT ${"x".repeat(700)}`, "too_long"],
		];
		for (const [query, reason] of cases) {
			expect(checkReadOnlyNewRelicNrql(query)).toEqual({
				ok: false,
				reason,
			});
		}
		expect(checkReadOnlyNewRelicNrql(null)).toEqual({
			ok: false,
			reason: "empty",
		});
	});
});

describe("runNewRelicNrql", () => {
	test("appends the server window and row limit; never trusts a caller window", async () => {
		const { impl, calls } = router();
		const result = await runNewRelicNrql(deps(impl), {
			query: "SELECT count(*) FROM Transaction",
			startsAt: "2026-10-30T23:45:00.000Z",
			windowMinutes: 30,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.tool).toBe("newrelic.run_nrql");
		expect(result.risk).toBe("read_only");
		expect(result.item?.kind).toBe("nrql_aggregate");
		expect(result.item?.excerpt).toContain("TimeoutError");
		expect(calls).toHaveLength(1);
		const sent = String(calls[0]?.variables.query);
		expect(sent.startsWith("SELECT count(*) FROM Transaction")).toBe(true);
		expect(sent).toContain("SINCE");
		expect(sent).toContain("UNTIL");
		expect(sent.endsWith("LIMIT 20")).toBe(true);
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	test("rejects hostile NRQL without echoing the query", async () => {
		const { impl, calls } = router();
		const result = await runNewRelicNrql(deps(impl), {
			query: "SELECT count(*) FROM Transaction; DELETE FROM Transaction",
		});
		expect(result).toMatchObject({
			ok: false,
			code: "POLICY_DENIED",
		});
		if (result.ok) return;
		expect(result.message).toContain("multiple_statements");
		expect(result.message).not.toContain("DELETE FROM");
		expect(calls).toHaveLength(0);
	});

	test("rejects unknown inputs and maps 429", async () => {
		const { impl } = router();
		expect(
			await runNewRelicNrql(deps(impl), {
				query: "SELECT count(*) FROM Transaction",
				accountId: ACCOUNT,
			}),
		).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });

		const limited = router({ nrqlStatus: 429 });
		expect(
			await runNewRelicNrql(deps(limited.impl), {
				query: "SELECT count(*) FROM Transaction",
			}),
		).toMatchObject({ ok: false, code: "RATE_LIMITED" });
	});

	test("redacts emails, IPs and foreign account ids in rows", async () => {
		const { impl } = router({
			rows: [
				{
					count: 1,
					"error.class": "alice@example.com 10.0.0.5",
					accountId: "9999999",
				},
			],
		});
		const result = await runNewRelicNrql(deps(impl), {
			query: "SELECT count(*) FROM Transaction",
		});
		if (!result.ok) throw new Error("expected success");
		expect(result.item?.excerpt).not.toContain("alice@example.com");
		expect(result.item?.excerpt).not.toContain("10.0.0.5");
		expect(result.item?.excerpt).toContain("[account-redacted]");
	});
});

describe("getNewRelicEntity", () => {
	test("returns selected entity attributes only", async () => {
		const { impl, calls } = router();
		const result = await getNewRelicEntity(deps(impl), { guid: GUID });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.item?.kind).toBe("entity");
		expect(result.item?.excerpt).toContain("Entity: checkout-api");
		expect(result.item?.excerpt).toContain("Account: 1234567");
		expect(result.item?.excerpt).not.toContain(API_KEY);
		expect(calls[0]?.headers.get("API-Key")).toBe(API_KEY);
	});

	test("maps 404, foreign tenants and invalid GUIDs", async () => {
		const missing = router({ entityStatus: 404 });
		expect(
			await getNewRelicEntity(deps(missing.impl), { guid: GUID }),
		).toMatchObject({ ok: false, code: "NOT_FOUND" });

		const foreign = router({
			entityBody: {
				data: { actor: { entity: entity({ accountId: 9999999 }) } },
			},
		});
		expect(
			await getNewRelicEntity(deps(foreign.impl), { guid: GUID }),
		).toMatchObject({ ok: false, code: "NOT_FOUND" });

		const invalid = router();
		expect(
			await getNewRelicEntity(deps(invalid.impl), { guid: "../../etc/passwd" }),
		).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(
			await getNewRelicEntity(deps(invalid.impl), {
				guid: GUID,
				url: "https://evil.example",
			}),
		).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(invalid.calls).toHaveLength(0);
	});

	test("maps a missing key to MISSING_CONFIG", async () => {
		const { impl } = router();
		expect(
			await getNewRelicEntity(deps(impl, { apiKey: "" }), { guid: GUID }),
		).toMatchObject({ ok: false, code: "MISSING_CONFIG" });
	});
});

describe("listNewRelicAlertPolicies", () => {
	test("returns ids and names under the requested limit", async () => {
		const { impl, calls } = router();
		const result = await listNewRelicAlertPolicies(deps(impl), { limit: 2 });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.item?.kind).toBe("alert_policies");
		expect(result.item?.excerpt).toContain("Checkout SLO");
		expect(result.item?.excerpt).toContain("Payments SLO");
		expect(result.item?.excerpt).not.toContain("Platform SLO");
		expect(result.item?.excerpt).not.toContain(API_KEY);
		expect(calls[0]?.query).toContain("policies { id name }");
		expect(calls[0]?.query).not.toContain("destination");
	});

	test("rejects bad limits and maps 403", async () => {
		const { impl } = router();
		expect(
			await listNewRelicAlertPolicies(deps(impl), { limit: 0 }),
		).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
		expect(
			await listNewRelicAlertPolicies(deps(impl), { limit: 2, all: true }),
		).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });

		const denied = router({ policiesStatus: 403 });
		expect(
			await listNewRelicAlertPolicies(deps(denied.impl), {}),
		).toMatchObject({ ok: false, code: "POLICY_DENIED" });
	});
});

describe("createNewRelicReadTools", () => {
	test("declares exactly three read-only descriptors", () => {
		const tools = createNewRelicReadTools(deps(router().impl));
		expect(tools.map((tool) => tool.name)).toEqual([
			"newrelic.run_nrql",
			"newrelic.get_entity",
			"newrelic.list_alert_policies",
		]);
		for (const tool of tools) {
			expect(tool.risk).toBe("read_only");
			expect(NEWRELIC_TOOL_RISK_BANDS[tool.name]).toBe("read_only");
		}
	});
});
