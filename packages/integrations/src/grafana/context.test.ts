import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ContextBundle,
	contextBundleSchema,
	type ErrorCode,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import {
	fetchGrafanaContext,
	GRAFANA_CONTEXT_MAX_FETCH_CALLS,
	GRAFANA_CONTEXT_MAX_LOG_CHARS,
	GRAFANA_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
	type GrafanaContextDependencies,
	type GrafanaFetchLike,
	grafanaPromQlForService,
	resolveGrafanaWindow,
} from "./context";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const BASE = "https://grafana.example.com";
const TOKEN = "glsa_w16context0123456789abcdef";
const RULE_UID = "rule-checkout-errors";

type Call = { url: string; init: RequestInit };

type RouterOptions = {
	ruleStatus?: number;
	metricsStatus?: number;
	logsStatus?: number;
	series?: number;
	points?: number;
	logLines?: string[];
	oversized?: boolean;
	metricsStream?: StreamOption;
	throwOn?: "rule" | "metrics" | "logs";
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Pull-based stream body so the adapter — not the test — decides how much of
 * the payload is consumed; `onCancel` proves the reader is abandoned at the cap.
 */
function streamed(chunks: readonly string[], onCancel: () => void): Response {
	const encoder = new TextEncoder();
	let index = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const next = chunks[index];
				if (next === undefined) {
					controller.close();
					return;
				}
				index += 1;
				controller.enqueue(encoder.encode(next));
			},
			cancel() {
				onCancel();
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

type StreamOption = { chunks: readonly string[]; onCancel: () => void };

function metricFrames(series: number, points: number): unknown[] {
	const times = Array.from(
		{ length: points },
		(_, index) => NOW_MS - (points - 1 - index) * 60_000,
	);
	const fields: unknown[] = [{ name: "Time", type: "time" }];
	const columns: unknown[] = [times];
	for (let index = 0; index < series; index += 1) {
		fields.push({
			name: `metric_${index}`,
			type: "number",
			labels: { job: "checkout", instance: `10.0.0.${index}:8080` },
		});
		columns.push(
			Array.from({ length: points }, (_, point) => index * 100 + point),
		);
	}
	return [{ schema: { fields }, data: { values: columns } }];
}

function logFrames(lines: string[]): unknown[] {
	const times = lines.map(
		(_, index) => NOW_MS - (lines.length - 1 - index) * 1000,
	);
	return [
		{
			schema: {
				fields: [
					{ name: "Time", type: "time" },
					{ name: "Line", type: "string" },
				],
			},
			data: { values: [times, lines] },
		},
	];
}

function router(options: RouterOptions = {}): {
	impl: GrafanaFetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl: GrafanaFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const request = init ?? {};
		calls.push({ url, init: request });
		const bodyText =
			typeof request.body === "string"
				? request.body
				: request.body === undefined
					? ""
					: await new Response(request.body).text();
		const body = bodyText === "" ? null : JSON.parse(bodyText);

		if (url.includes("/api/v1/provisioning/alert-rules/")) {
			if (options.throwOn === "rule") throw new Error("socket closed");
			const status = options.ruleStatus ?? 200;
			if (status !== 200) return json(status, { message: "rule unavailable" });
			return json(200, {
				uid: RULE_UID,
				title: "Checkout error rate",
				condition: "C",
				for: "5m",
				ruleGroup: "checkout",
				folderUID: "folder-1",
				labels: { severity: "critical", customer_id: "acme" },
				annotations: {
					summary: "5xx above SLO",
					description: "error ratio 12%",
					runbook_url: "https://runbooks.example.com/checkout",
				},
				unknown: "dropped",
			});
		}

		if (url.endsWith("/api/ds/query")) {
			const refId = body?.queries?.[0]?.refId;
			const step = refId === "logs" ? "logs" : "metrics";
			if (options.throwOn === step) throw new Error("timeout");
			const status =
				step === "logs"
					? (options.logsStatus ?? 200)
					: (options.metricsStatus ?? 200);
			if (status !== 200) return json(status, { message: "unavailable" });
			if (options.oversized === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			if (step === "metrics" && options.metricsStream !== undefined) {
				return streamed(
					options.metricsStream.chunks,
					options.metricsStream.onCancel,
				);
			}
			if (step === "logs") {
				return json(200, {
					results: {
						logs: {
							status: 200,
							frames: logFrames(
								options.logLines ??
									Array.from({ length: 3 }, (_, index) => `line-${index}`),
							),
						},
					},
				});
			}
			return json(200, {
				results: {
					metrics: {
						status: 200,
						frames: metricFrames(options.series ?? 2, options.points ?? 3),
					},
				},
			});
		}

		return json(404, { message: "not found" });
	};
	return { impl, calls };
}

function dependencies(
	impl: GrafanaFetchLike,
	overrides: Partial<GrafanaContextDependencies> = {},
): GrafanaContextDependencies {
	return {
		baseUrl: BASE,
		token: TOKEN,
		orgId: 42,
		metricsDatasourceUid: "prom-uid",
		logsDatasourceUid: "loki-uid",
		fetchImpl: impl,
		now: () => NOW_MS,
		timeoutMs: 5000,
		...overrides,
	};
}

function bundleBytes(bundle: ContextBundle): number {
	return new TextEncoder().encode(
		bundle.items.map((item) => item.excerpt).join(""),
	).byteLength;
}

function requestBody(call: Call): {
	from: string;
	to: string;
	queries: Array<Record<string, unknown>>;
} {
	return JSON.parse(String(call.init.body));
}

describe("fetchGrafanaContext", () => {
	test("assembles a contract-valid bundle with the fixed three-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: `grafana:${RULE_UID}:abc`,
			service: "checkout",
			alertRuleUid: RULE_UID,
			startsAt: "2026-10-30T23:50:00Z",
		});

		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"alert_rule",
			"metrics",
			"logs",
		]);
		for (const item of bundle.items) {
			expect(item.source).toBe("grafana");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.url?.startsWith("https://")).toBe(true);
		}
		expect(bundle.truncated).toBe(false);
		expect(calls.length).toBe(3);
		expect(calls.length).toBeLessThanOrEqual(GRAFANA_CONTEXT_MAX_FETCH_CALLS);

		for (const call of calls) {
			const headers = call.init.headers as Record<string, string>;
			expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
			expect(headers["X-Grafana-Org-Id"]).toBe("42");
			expect(call.url).not.toContain(TOKEN);
		}

		const metricsQuery = requestBody(calls[1]).queries[0] as {
			expr: string;
			maxDataPoints: number;
			datasource: { uid: string };
		};
		expect(metricsQuery.expr).toBe('{job="checkout"}');
		expect(metricsQuery.maxDataPoints).toBe(20);
		expect(metricsQuery.datasource.uid).toBe("prom-uid");

		const logsQuery = requestBody(calls[2]).queries[0] as {
			maxLines: number;
			format: string;
			queryType: string;
			datasource: { type: string; uid: string };
		};
		expect(logsQuery.maxLines).toBe(200);
		expect(logsQuery.format).toBe("table");
		expect(logsQuery.queryType).toBe("range");
		expect(logsQuery.datasource).toEqual({ type: "loki", uid: "loki-uid" });

		const rule = bundle.items[0];
		expect(rule?.excerpt).toContain("Condition: C");
		expect(rule?.excerpt).toContain("For: 5m");
		expect(rule?.excerpt).not.toContain("customer_id");
		expect(bundle.items[1]?.excerpt.length).toBeLessThanOrEqual(
			GRAFANA_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
		);
		expect(bundle.items[2]?.excerpt.length).toBeLessThanOrEqual(
			GRAFANA_CONTEXT_MAX_LOG_CHARS,
		);
		expect(bundleBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
	});

	test("clamps the window to startsAt − 15 min and 60 minutes", async () => {
		const recent = router();
		await fetchGrafanaContext(dependencies(recent.impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			startsAt: "2026-10-30T23:50:00Z",
		});
		const recentBody = requestBody(recent.calls[0]);
		expect(recentBody.from).toBe(String(Date.parse("2026-10-30T23:35:00Z")));
		expect(recentBody.to).toBe(String(NOW_MS));

		const old = router();
		await fetchGrafanaContext(dependencies(old.impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			startsAt: "2026-10-29T00:00:00Z",
		});
		expect(requestBody(old.calls[0]).from).toBe(String(NOW_MS - 60 * 60_000));

		const narrow = router();
		await fetchGrafanaContext(dependencies(narrow.impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			windowMinutes: 5,
		});
		expect(requestBody(narrow.calls[0]).from).toBe(
			String(NOW_MS - 15 * 60_000),
		);

		expect(
			resolveGrafanaWindow({ nowMs: NOW_MS, windowMinutes: 120 }).fromMs,
		).toBe(NOW_MS - 60 * 60_000);
	});

	test("caps series, points and the metric summary", async () => {
		const { impl } = router({ series: 7, points: 50 });
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			alertRuleUid: RULE_UID,
		});
		const metrics = bundle.items.find((item) => item.kind === "metrics");
		expect(metrics).toBeDefined();
		expect(metrics?.excerpt.length).toBeLessThanOrEqual(1500);
		expect((metrics?.excerpt.match(/^Series /gm) ?? []).length).toBe(5);
		expect(metrics?.excerpt).toContain("Omitted series: 2");
		expect(metrics?.excerpt).toContain("Points truncated");
		for (const line of metrics?.excerpt.split("\n") ?? []) {
			if (line.startsWith("  points: ")) {
				expect(line.split(",").length).toBeLessThanOrEqual(20);
			}
		}
		expect(bundle.truncated).toBe(true);
	});

	test("bounds and redacts the log tail before truncation", async () => {
		const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`);
		lines[249] = `panic token=${TOKEN} password=hunter2`;
		const { impl } = router({ logLines: lines });
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			alertRuleUid: RULE_UID,
		});
		const logs = bundle.items.find((item) => item.kind === "logs");
		expect(logs).toBeDefined();
		expect(logs?.title).toContain("200 lines");
		expect(logs?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(logs?.excerpt).toContain("panic");
		expect(logs?.excerpt).toContain("[auth-redacted]");
		expect(logs?.excerpt).toContain("[auth-redacted]");
		expect(logs?.excerpt).not.toContain(TOKEN);
		expect(logs?.excerpt).not.toContain("hunter2");
		expect(logs?.excerpt).not.toContain("line-0");
		expect(bundle.truncated).toBe(true);
		expect(bundleBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
	});

	test("degrades to a partial bundle on 403 and 404", async () => {
		const { impl, calls } = router({
			ruleStatus: 404,
			metricsStatus: 403,
			logsStatus: 404,
		});
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
			alertRuleUid: RULE_UID,
		});
		expect(bundle.items).toEqual([]);
		expect(bundle.truncated).toBe(true);
		expect(calls.length).toBe(3);
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
	});

	test("skips the rule call when no rule UID is known", async () => {
		const { impl, calls } = router();
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: "checkout",
		});
		expect(calls.length).toBe(2);
		expect(bundle.items.map((item) => item.kind)).toEqual(["metrics", "logs"]);
		expect(bundle.truncated).toBe(true);
	});

	test("skips logs when no logs datasource is configured", async () => {
		const { impl, calls } = router();
		const bundle = await fetchGrafanaContext(
			dependencies(impl, { logsDatasourceUid: null }),
			{
				incidentFingerprint: "grafana:rule:abc",
				service: "checkout",
				alertRuleUid: RULE_UID,
			},
		);
		expect(calls.length).toBe(2);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"alert_rule",
			"metrics",
		]);
		expect(bundle.truncated).toBe(true);
	});

	test("reads a multi-chunk provider body and never cancels a bounded stream", async () => {
		const body = JSON.stringify({
			results: { metrics: { status: 200, frames: metricFrames(2, 3) } },
		});
		const midpoint = Math.floor(body.length / 2);
		let cancelled = 0;
		const { impl } = router({
			metricsStream: {
				chunks: [body.slice(0, midpoint), body.slice(midpoint)],
				onCancel: () => {
					cancelled += 1;
				},
			},
		});
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: `grafana:${RULE_UID}:abc`,
			service: "checkout",
			alertRuleUid: RULE_UID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"alert_rule",
			"metrics",
			"logs",
		]);
		expect(bundle.truncated).toBe(false);
		expect(cancelled).toBe(0);
	});

	test("cancels a provider stream the moment it crosses the response cap", async () => {
		const secret = "STREAMED-PROVIDER-SECRET";
		let cancelled = 0;
		const { impl } = router({
			metricsStream: {
				chunks: ['{"results":', secret, "x".repeat(300 * 1024)],
				onCancel: () => {
					cancelled += 1;
				},
			},
		});
		const bundle = await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: `grafana:${RULE_UID}:abc`,
			service: "checkout",
			alertRuleUid: RULE_UID,
		});
		expect(cancelled).toBe(1);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"alert_rule",
			"logs",
		]);
		expect(bundle.truncated).toBe(true);
		expect(JSON.stringify(bundle)).not.toContain(secret);
	});

	test("maps 429, 401, timeouts and oversized responses without leaking secrets", async () => {
		const rateLimited = await fetchGrafanaContext(
			dependencies(router({ metricsStatus: 429 }).impl),
			{ incidentFingerprint: "grafana:rule:abc", service: "checkout" },
		).catch((error: unknown) => error);
		expect(rateLimited).toBeInstanceOf(PlatformError);
		expect((rateLimited as PlatformError).code).toBe("RATE_LIMITED");

		const unauthorized = await fetchGrafanaContext(
			dependencies(router({ ruleStatus: 401 }).impl),
			{
				incidentFingerprint: "grafana:rule:abc",
				service: "checkout",
				alertRuleUid: RULE_UID,
			},
		).catch((error: unknown) => error);
		expect(unauthorized).toBeInstanceOf(PlatformError);
		expect((unauthorized as PlatformError).code).toBe(
			"INTEGRATION_UNAVAILABLE",
		);

		const timeout = await fetchGrafanaContext(
			dependencies(router({ throwOn: "metrics" }).impl),
			{ incidentFingerprint: "grafana:rule:abc", service: "checkout" },
		).catch((error: unknown) => error);
		expect(timeout).toBeInstanceOf(PlatformError);
		expect((timeout as PlatformError).code).toBe("INTEGRATION_UNAVAILABLE");

		const oversized = await fetchGrafanaContext(
			dependencies(router({ oversized: true }).impl),
			{
				incidentFingerprint: "grafana:rule:abc",
				service: "checkout",
				alertRuleUid: RULE_UID,
			},
		);
		expect(oversized.items.map((item) => item.kind)).toEqual(["alert_rule"]);
		expect(oversized.truncated).toBe(true);

		for (const error of [rateLimited, unauthorized, timeout]) {
			const serialized = JSON.stringify(error);
			expect(serialized).not.toContain(TOKEN);
			expect(serialized).not.toContain(BASE);
			expect(serialized).not.toContain("socket");
		}
	});

	test("rejects invalid configuration and inputs with fixed errors", async () => {
		const { impl, calls } = router();
		const cases: Array<{
			deps?: Partial<GrafanaContextDependencies>;
			input?: Partial<Parameters<typeof fetchGrafanaContext>[1]>;
			code: ErrorCode;
		}> = [
			{
				deps: { baseUrl: "http://grafana.example.com" },
				code: "VALIDATION_FAILED",
			},
			{
				deps: { baseUrl: "https://user:pass@grafana.example.com" },
				code: "VALIDATION_FAILED",
			},
			{
				deps: { baseUrl: "https://grafana.example.com/?x=1" },
				code: "VALIDATION_FAILED",
			},
			{ deps: { token: "  " }, code: "MISSING_CONFIG" },
			{ deps: { metricsDatasourceUid: null }, code: "MISSING_CONFIG" },
			{
				deps: { metricsDatasourceUid: "../prom" },
				code: "VALIDATION_FAILED",
			},
			{ input: { service: "" }, code: "VALIDATION_FAILED" },
			{ input: { incidentFingerprint: "" }, code: "VALIDATION_FAILED" },
			{
				input: { alertRuleUid: "../../admin" },
				code: "VALIDATION_FAILED",
			},
		];
		for (const entry of cases) {
			const error = await fetchGrafanaContext(dependencies(impl, entry.deps), {
				incidentFingerprint: "grafana:rule:abc",
				service: "checkout",
				...entry.input,
			}).catch((thrown: unknown) => thrown);
			expect(error).toBeInstanceOf(PlatformError);
			expect((error as PlatformError).code).toBe(entry.code);
		}
		expect(calls.length).toBe(0);
	});

	test("payload text cannot alter the PromQL template", async () => {
		const { impl, calls } = router();
		await fetchGrafanaContext(dependencies(impl), {
			incidentFingerprint: "grafana:rule:abc",
			service: 'api"} or vector(1)',
		});
		const body = requestBody(calls[0]);
		expect(body.queries).toHaveLength(1);
		expect((body.queries[0] as { expr: string }).expr).toBe(
			'{job="api\\"} or vector(1)"}',
		);
		expect(grafanaPromQlForService('api"}')).toBe('{job="api\\"}"}');
	});

	test("honors a reduced excerpt cap and marks the bundle truncated", async () => {
		const { impl } = router();
		const bundle = await fetchGrafanaContext(
			dependencies(impl, { maxExcerptChars: 40 }),
			{
				incidentFingerprint: "grafana:rule:abc",
				service: "checkout",
				alertRuleUid: RULE_UID,
			},
		);
		expect(bundle.items.length).toBeGreaterThan(0);
		for (const item of bundle.items) {
			expect(item.excerpt.length).toBeLessThanOrEqual(40);
			expect(item.sha256).toBe(
				createHash("sha256").update(item.excerpt).digest("hex"),
			);
		}
		expect(bundle.truncated).toBe(true);
	});
});
