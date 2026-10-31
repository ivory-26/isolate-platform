import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type ErrorCode, isPlatformError } from "@isolate/shared";
import {
	buildSignozQueryRangeRequest,
	fetchSignozContext,
	fetchSignozQueryEvidence,
	fetchSignozRuleListEvidence,
	normalizeSignozBaseUrl,
	resolveSignozWindow,
	SIGNOZ_CONTEXT_MAX_FETCH_CALLS,
	SIGNOZ_CONTEXT_MAX_POINTS,
	SIGNOZ_CONTEXT_MAX_SERIES,
	type SignozContextDependencies,
	type SignozFetchLike,
} from "./context";

const BASE = "https://signoz.example.com";
const API_KEY = "signoz-read-key-0123456789";
const RULE_ID = "a1b2c3d4-0000-1111-2222-333344445555";
const NOW_MS = Date.parse("2026-10-31T12:00:00.000Z");
const PROMQL = 'sum(rate(http_requests_total{service_name="checkout"}[5m]))';

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function queryBody(seriesCount: number, pointsPerSeries: number): unknown {
	return {
		status: "success",
		data: {
			type: "time_series",
			data: {
				results: [
					{
						queryName: "A",
						series: Array.from({ length: seriesCount }, (_, series) => ({
							labels: {
								service_name: `svc-${series}`,
								operation: "GET /checkout",
								status_code: "500",
							},
							values: Array.from({ length: pointsPerSeries }, (_, point) => ({
								timestamp: NOW_MS - (pointsPerSeries - point) * 60_000,
								value: String(1 + series + point / 2),
							})),
						})),
					},
				],
			},
		},
	};
}

type RouterOptions = {
	ruleStatus?: number;
	ruleData?: unknown;
	ruleType?: string;
	ruleDescription?: string;
	queryStatus?: number;
	queryBody?: unknown;
	series?: number;
	points?: number;
	oversizeQuery?: boolean;
	transportFailure?: boolean;
	ruleList?: unknown;
};

function router(options: RouterOptions = {}): {
	impl: SignozFetchLike;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl: SignozFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (options.transportFailure === true) {
			throw new TypeError("connection refused");
		}
		if (url === `${BASE}/api/v1/rules/${RULE_ID}`) {
			if ((options.ruleStatus ?? 200) !== 200) {
				return json(options.ruleStatus ?? 200, { status: "error" });
			}
			const data =
				options.ruleData === undefined
					? {
							id: RULE_ID,
							alertName: "HighErrorRate",
							ruleType: options.ruleType ?? "promql_rule",
							alert: PROMQL,
							state: "firing",
							evalWindow: "5m0s",
							frequency: "1m0s",
							description:
								options.ruleDescription ??
								"Error rate above 5% for service checkout",
							labels: { "service.name": "checkout", severity: "critical" },
							annotations: { summary: "Error rate above 5%" },
						}
					: options.ruleData;
			return json(200, { status: "success", data });
		}
		if (url === `${BASE}/api/v1/rules`) {
			return json(200, {
				status: "success",
				data: {
					rules: options.ruleList ?? [
						{
							id: RULE_ID,
							alertName: "HighErrorRate",
							ruleType: "promql_rule",
							state: "firing",
						},
						{
							id: "rule-2",
							alertName: "HighLatency",
							ruleType: "promql_rule",
							state: "inactive",
						},
						{
							id: "rule-3",
							alertName: "DiskFull",
							ruleType: "threshold_rule",
							state: "firing",
						},
					],
					total: 3,
				},
			});
		}
		if (url === `${BASE}/api/v5/query_range`) {
			if ((options.queryStatus ?? 200) !== 200) {
				return json(options.queryStatus ?? 200, { status: "error" });
			}
			if (options.oversizeQuery === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			return json(
				200,
				options.queryBody ??
					queryBody(options.series ?? 2, options.points ?? 3),
			);
		}
		return json(404, { status: "error" });
	};
	return { impl, calls };
}

function deps(
	impl: SignozFetchLike,
	overrides: Partial<SignozContextDependencies> = {},
): SignozContextDependencies {
	return {
		baseUrl: BASE,
		apiKey: API_KEY,
		fetchImpl: impl,
		now: () => NOW_MS,
		...overrides,
	};
}

function queryRequest(calls: FetchCall[]): {
	start: number;
	end: number;
	stepInterval: number;
	compositeQuery: {
		queryType: string;
		promQueries: { A: { queryName: string; promql: string } };
	};
} {
	const call = calls.find(
		(entry) => entry.url === `${BASE}/api/v5/query_range`,
	);
	if (call === undefined) throw new Error("query_range was not called");
	return JSON.parse(String(call.init.body));
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("normalizeSignozBaseUrl", () => {
	test("accepts an https origin with a path and rejects everything else", () => {
		expect(normalizeSignozBaseUrl("https://signoz.example.com/")).toBe(BASE);
		expect(normalizeSignozBaseUrl("https://signoz.example.com/signoz/")).toBe(
			`${BASE}/signoz`,
		);
		for (const value of [
			"http://signoz.example.com",
			"https://user:pass@signoz.example.com",
			"https://signoz.example.com?x=1",
			"not-a-url",
			"",
		]) {
			expect(() => normalizeSignozBaseUrl(value)).toThrow();
		}
	});
});

describe("resolveSignozWindow", () => {
	test("clamps to 15–60 minutes and never reaches past 60 minutes", () => {
		const short = resolveSignozWindow({ nowMs: NOW_MS, windowMinutes: 1 });
		expect(short.toMs - short.fromMs).toBe(15 * 60_000);
		const long = resolveSignozWindow({
			nowMs: NOW_MS,
			startsAt: new Date(NOW_MS - 3 * 3_600_000).toISOString(),
			windowMinutes: 120,
		});
		expect(long.toMs - long.fromMs).toBe(60 * 60_000);
	});
});

describe("buildSignozQueryRangeRequest", () => {
	test("never widens the step below the 20-point floor", () => {
		const request = buildSignozQueryRangeRequest({
			query: PROMQL,
			fromMs: NOW_MS - 60 * 60_000,
			toMs: NOW_MS,
			stepSeconds: 30,
		});
		expect(request.stepInterval).toBeGreaterThanOrEqual(
			(60 * 60) / SIGNOZ_CONTEXT_MAX_POINTS,
		);
		expect(
			(request.end - request.start) / 1000 / request.stepInterval,
		).toBeLessThanOrEqual(SIGNOZ_CONTEXT_MAX_POINTS);
	});
});

describe("fetchSignozContext", () => {
	test("builds a bounded two-item bundle from the rule and one query_range", async () => {
		const { impl, calls } = router({ series: 8, points: 50 });
		const bundle = await fetchSignozContext(deps(impl), {
			incidentFingerprint: "signoz:rule-1:abc",
			service: "checkout",
			ruleId: RULE_ID,
			startsAt: new Date(NOW_MS - 20 * 60_000).toISOString(),
			windowMinutes: 30,
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]?.init.method).toBe("GET");
		expect(
			(calls[1]?.init.headers as Record<string, string>)["SIGNOZ-API-KEY"],
		).toBe(API_KEY);

		const body = queryRequest(calls);
		expect(body.compositeQuery.queryType).toBe("promql");
		expect(body.compositeQuery.promQueries.A.promql).toBe(PROMQL);
		expect(body.end - body.start).toBeLessThanOrEqual(60 * 60_000);
		expect(
			(body.end - body.start) / 1000 / body.stepInterval,
		).toBeLessThanOrEqual(SIGNOZ_CONTEXT_MAX_POINTS);

		expect(bundle.incidentFingerprint).toBe("signoz:rule-1:abc");
		expect(bundle.items).toHaveLength(2);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"alert_rule",
			"metrics",
		]);
		for (const item of bundle.items) {
			expect(item.source).toBe("signoz");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.excerpt.length).toBeLessThanOrEqual(4000);
			expect(item.sha256).toBe(sha256(item.excerpt));
		}
		const metrics = bundle.items[1];
		if (metrics === undefined) return;
		expect(metrics.excerpt.length).toBeLessThanOrEqual(1500);
		expect((metrics.excerpt.match(/^Series /gm) ?? []).length).toBe(
			SIGNOZ_CONTEXT_MAX_SERIES,
		);
		for (const line of metrics.excerpt
			.split("\n")
			.filter((entry) => entry.trimStart().startsWith("points:"))) {
			expect(line.split(", ").length).toBeLessThanOrEqual(
				SIGNOZ_CONTEXT_MAX_POINTS,
			);
		}
		expect(bundle.truncated).toBe(true);
	});

	test("ignores a withheld rule expression rather than inventing a query", async () => {
		const { impl, calls } = router({ ruleType: "threshold_rule" });
		const bundle = await fetchSignozContext(deps(impl), {
			incidentFingerprint: "fp",
			service: "checkout",
			ruleId: RULE_ID,
		});
		expect(calls).toHaveLength(1);
		expect(bundle.items.map((item) => item.kind)).toEqual(["alert_rule"]);
		expect(bundle.truncated).toBe(true);
	});

	test("a 403 or 404 on an optional resource yields a partial bundle", async () => {
		for (const ruleStatus of [403, 404]) {
			const { impl, calls } = router({ ruleStatus });
			const bundle = await fetchSignozContext(deps(impl), {
				incidentFingerprint: "fp",
				service: "checkout",
				ruleId: RULE_ID,
			});
			expect(bundle.items).toHaveLength(0);
			expect(bundle.truncated).toBe(true);
			expect(calls).toHaveLength(1);
		}

		const { impl } = router({ queryStatus: 404 });
		const bundle = await fetchSignozContext(deps(impl), {
			incidentFingerprint: "fp",
			service: "checkout",
			ruleId: RULE_ID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual(["alert_rule"]);
		expect(bundle.truncated).toBe(true);
	});

	test("drops an oversize or failed query response and keeps the rule", async () => {
		const { impl } = router({ oversizeQuery: true });
		const bundle = await fetchSignozContext(deps(impl), {
			incidentFingerprint: "fp",
			service: "checkout",
			ruleId: RULE_ID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual(["alert_rule"]);
		expect(bundle.truncated).toBe(true);
	});

	test("maps 401, 429 and transport failures to PlatformError codes", async () => {
		const cases: Array<{ options: RouterOptions; code: ErrorCode }> = [
			{ options: { ruleStatus: 401 }, code: "INTEGRATION_UNAVAILABLE" },
			{ options: { queryStatus: 429 }, code: "RATE_LIMITED" },
			{ options: { transportFailure: true }, code: "INTEGRATION_UNAVAILABLE" },
		];
		for (const entry of cases) {
			const { impl } = router(entry.options);
			try {
				await fetchSignozContext(deps(impl), {
					incidentFingerprint: "fp",
					service: "checkout",
					ruleId: RULE_ID,
				});
				expect.unreachable("expected a PlatformError");
			} catch (throwable) {
				expect(isPlatformError(throwable)).toBe(true);
				if (isPlatformError(throwable)) {
					expect(throwable.code).toBe(entry.code);
				}
			}
		}
	});

	test("redacts emails, IPs and keys in rule evidence", async () => {
		const { impl } = router({
			ruleDescription:
				"owner owner@example.com from 10.1.2.3 SIGNOZ-API-KEY: supersecretvalue123",
			ruleType: "threshold_rule",
		});
		const bundle = await fetchSignozContext(deps(impl), {
			incidentFingerprint: "fp",
			service: "checkout",
			ruleId: RULE_ID,
		});
		const excerpt = bundle.items[0]?.excerpt ?? "";
		expect(excerpt).not.toContain("owner@example.com");
		expect(excerpt).not.toContain("10.1.2.3");
		expect(excerpt).not.toContain("supersecretvalue123");
	});

	test("does nothing without a rule id and enforces the item cap", async () => {
		const idle = router();
		const empty = await fetchSignozContext(deps(idle.impl), {
			incidentFingerprint: "fp",
			service: "checkout",
		});
		expect(empty.items).toHaveLength(0);
		expect(empty.truncated).toBe(true);
		expect(idle.calls).toHaveLength(0);

		const limited = router();
		const capped = await fetchSignozContext(
			deps(limited.impl, { maxItems: 1 }),
			{ incidentFingerprint: "fp", service: "checkout", ruleId: RULE_ID },
		);
		expect(capped.items).toHaveLength(1);
		expect(capped.truncated).toBe(true);
	});

	test("requires an https base URL and an API key", async () => {
		const { impl } = router();
		await expect(
			fetchSignozContext(deps(impl, { baseUrl: "http://signoz.example.com" }), {
				incidentFingerprint: "fp",
				service: "checkout",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		await expect(
			fetchSignozContext(deps(impl, { apiKey: "" }), {
				incidentFingerprint: "fp",
				service: "checkout",
			}),
		).rejects.toMatchObject({ code: "MISSING_CONFIG" });
	});

	test("rejects an invalid rule id and empty fingerprint", async () => {
		const { impl } = router();
		await expect(
			fetchSignozContext(deps(impl), {
				incidentFingerprint: "fp",
				service: "checkout",
				ruleId: "bad rule id",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		await expect(
			fetchSignozContext(deps(impl), {
				incidentFingerprint: "",
				service: "checkout",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
	});

	test("never exceeds the two-call budget", async () => {
		expect(SIGNOZ_CONTEXT_MAX_FETCH_CALLS).toBe(2);
	});
});

describe("fetchSignozRuleListEvidence", () => {
	test("caps rows, applies filters and truncation", async () => {
		const { impl } = router();
		const result = await fetchSignozRuleListEvidence(deps(impl), {
			limit: 1,
			state: "firing",
		});
		expect(result.item?.kind).toBe("rule_list");
		const excerpt = result.item?.excerpt ?? "";
		expect(excerpt).toContain(RULE_ID);
		expect(excerpt).not.toContain("rule-2");
		expect(excerpt).not.toContain("rule-3");
		expect(excerpt).toContain("1 of 2");
		expect(result.truncated).toBe(true);
	});

	test("returns an empty item when the filter matches nothing", async () => {
		const { impl } = router();
		const result = await fetchSignozRuleListEvidence(deps(impl), {
			state: "no-such-state",
		});
		expect(result.item).toBeNull();
		expect(result.truncated).toBe(false);
	});
});

describe("fetchSignozQueryEvidence", () => {
	test("rejects unbounded queries before any fetch", async () => {
		const { impl, calls } = router();
		for (const query of [
			'up{job="x"}\n',
			"up; drop",
			"up /* comment */",
			"a".repeat(501),
		]) {
			await expect(
				fetchSignozQueryEvidence(deps(impl), {
					service: "checkout",
					query,
				}),
			).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
		}
		expect(calls).toHaveLength(0);
	});

	test("runs one bounded query and returns a metrics item", async () => {
		const { impl, calls } = router({ series: 1, points: 2 });
		const result = await fetchSignozQueryEvidence(deps(impl), {
			service: "checkout",
			query: PROMQL,
			windowMinutes: 30,
		});
		expect(calls).toHaveLength(1);
		expect(result.item?.kind).toBe("metrics");
		expect(result.item?.source).toBe("signoz");
		expect(result.truncated).toBe(false);
	});
});
