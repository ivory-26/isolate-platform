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
	DATADOG_CONTEXT_MAX_FETCH_CALLS,
	DATADOG_CONTEXT_MAX_LOG_CHARS,
	DATADOG_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
	type DatadogContextDependencies,
	type DatadogFetchLike,
	fetchDatadogContext,
	normalizeDatadogBaseUrl,
	resolveDatadogWindow,
} from "./context";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const BASE = "https://api.datadoghq.com";
const API_KEY = "redacted-sample";
const APP_KEY = "redacted-sample";
const INCIDENT_ID = "incident-abc-123";
const MONITOR_ID = "1234567890";

type Call = { url: string; init: RequestInit };

type RouterOptions = {
	incidentStatus?: number;
	monitorStatus?: number;
	metricsStatus?: number;
	logsStatus?: number;
	incidentId?: string;
	series?: number;
	points?: number;
	logEntries?: number;
	logsAfter?: string | null;
	oversized?: "incident" | "monitor" | "metrics" | "logs";
	throwOn?: "incident" | "monitor" | "metrics" | "logs";
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function incidentBody(id = INCIDENT_ID): unknown {
	return {
		data: {
			id,
			type: "incidents",
			attributes: {
				title: "Checkout outage",
				severity: "SEV-1",
				state: "active",
				created: "2026-10-30T23:50:00.000Z",
				modified: "2026-10-30T23:55:00.000Z",
				customer_impact_scope:
					"Checkout failing for alice@example.com from 10.1.2.3",
				customer_impacted: true,
				notes: ["responder note", "private detail"],
			},
		},
	};
}

function monitorBody(): unknown {
	return {
		id: Number(MONITOR_ID),
		name: "Checkout error rate",
		type: "metric alert",
		overall_state: "Alert",
		priority: 1,
		created: "2026-10-01T00:00:00.000Z",
		modified: "2026-10-30T23:55:00.000Z",
		tags: ["service:checkout", "env:prod", "host:web-1", "owner:alice"],
		message: "raw monitor message token=supersecret",
		options: { webhook_url: "https://hooks.example.com/secret" },
	};
}

function metricsBody(seriesCount: number, points: number): unknown {
	const series = Array.from({ length: seriesCount }, (_, index) => ({
		query_index: index % 2,
		aggr: index % 2 === 0 ? "avg" : "sum",
		scope:
			index % 2 === 0
				? "avg:system.cpu.user{service:checkout}"
				: "sum:trace.http.request.errors{service:checkout}.as_count()",
		pointlist: Array.from({ length: points }, (_, point) => [
			NOW_MS - (points - 1 - point) * 60_000,
			index * 100 + point,
		]),
	}));
	return {
		data: {
			id: "query-1",
			type: "timeseries_response",
			attributes: {
				series,
				query: "avg:system.cpu.user{service:checkout}",
			},
		},
	};
}

function logEntries(count: number): unknown[] {
	return Array.from({ length: count }, (_, index) => {
		const status = index < 12 ? "error" : index < 15 ? "warn" : "info";
		const kind =
			index < 7
				? "timeout"
				: index < 9
					? "connection_refused"
					: index < 12
						? "contact alice@example.com from 10.1.2.3"
						: undefined;
		return {
			id: `log-${index}`,
			type: "log",
			attributes: {
				timestamp: new Date(NOW_MS - index * 1000).toISOString(),
				status,
				service: "checkout",
				message: "raw log body token=logsecret",
				attributes:
					kind === undefined
						? { "http.status_code": "200" }
						: { "error.kind": kind, "http.status_code": "500" },
			},
		};
	});
}

function router(options: RouterOptions = {}): {
	impl: DatadogFetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl: DatadogFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const request = init ?? {};
		calls.push({ url, init: request });
		const step = url.includes("/api/v2/incidents/")
			? "incident"
			: url.includes("/api/v1/monitor/")
				? "monitor"
				: url.endsWith("/api/v2/query/timeseries")
					? "metrics"
					: url.endsWith("/api/v2/logs/events/search")
						? "logs"
						: "unknown";
		if (options.throwOn === step) throw new Error("socket closed");
		if (options.oversized === step) {
			return new Response("x".repeat(300 * 1024), { status: 200 });
		}
		if (step === "incident") {
			const status = options.incidentStatus ?? 200;
			if (status !== 200) return json(status, { errors: ["unavailable"] });
			return json(200, incidentBody(options.incidentId ?? INCIDENT_ID));
		}
		if (step === "monitor") {
			const status = options.monitorStatus ?? 200;
			if (status !== 200) return json(status, { errors: ["unavailable"] });
			return json(200, monitorBody());
		}
		if (step === "metrics") {
			const status = options.metricsStatus ?? 200;
			if (status !== 200) return json(status, { errors: ["unavailable"] });
			return json(200, metricsBody(options.series ?? 2, options.points ?? 3));
		}
		if (step === "logs") {
			const status = options.logsStatus ?? 200;
			if (status !== 200) return json(status, { errors: ["unavailable"] });
			return json(200, {
				data: logEntries(options.logEntries ?? 20),
				meta: {
					page:
						options.logsAfter === undefined || options.logsAfter === null
							? {}
							: { after: options.logsAfter },
				},
			});
		}
		return json(404, { errors: ["not found"] });
	};
	return { impl, calls };
}

function dependencies(
	impl: DatadogFetchLike,
	overrides: Partial<DatadogContextDependencies> = {},
): DatadogContextDependencies {
	return {
		baseUrl: BASE,
		apiKey: API_KEY,
		appKey: APP_KEY,
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

function requestBody(call: Call): Record<string, unknown> {
	return JSON.parse(String(call.init.body));
}

describe("fetchDatadogContext", () => {
	test("assembles a contract-valid bundle with a four-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1234567890:abc",
			service: "checkout",
			incidentId: INCIDENT_ID,
			monitorId: MONITOR_ID,
			startsAt: "2026-10-30T23:50:00Z",
		});

		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"incident",
			"monitor",
			"metrics",
			"logs",
		]);
		for (const item of bundle.items) {
			expect(item.source).toBe("datadog");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.url?.startsWith("https://")).toBe(true);
		}
		expect(bundle.truncated).toBe(false);
		expect(calls.length).toBe(4);
		expect(calls.length).toBeLessThanOrEqual(DATADOG_CONTEXT_MAX_FETCH_CALLS);

		for (const call of calls) {
			const headers = call.init.headers as Record<string, string>;
			expect(headers["DD-API-KEY"]).toBe(API_KEY);
			expect(headers["DD-APPLICATION-KEY"]).toBe(APP_KEY);
			expect(call.url).not.toContain(API_KEY);
			expect(call.url).not.toContain(APP_KEY);
		}

		const metricsRequest = requestBody(calls[2]);
		const attributes = (
			metricsRequest.data as {
				attributes: {
					from: number;
					to: number;
					queries: Array<{ name: string; query: string }>;
				};
			}
		).attributes;
		expect(attributes.from).toBe(
			Math.floor(Date.parse("2026-10-30T23:35:00Z") / 1000),
		);
		expect(attributes.to).toBe(Math.floor(NOW_MS / 1000));
		expect(attributes.queries.map((query) => query.name)).toEqual([
			"cpu",
			"errors",
		]);
		expect(attributes.queries[0]?.query).toBe(
			"avg:system.cpu.user{service:checkout}",
		);

		const logRequest = JSON.stringify(requestBody(calls[3]));
		expect(logRequest).not.toContain("message");
		expect(logRequest).toContain("service:checkout");
	});

	test("clamps the window to startsAt − 15 min and 60 minutes", async () => {
		const recent = router();
		await fetchDatadogContext(dependencies(recent.impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
			startsAt: "2026-10-30T23:50:00Z",
		});
		const recentWindow = resolveDatadogWindow({
			nowMs: NOW_MS,
			startsAt: "2026-10-30T23:50:00Z",
		});
		expect(recentWindow.fromMs).toBe(Date.parse("2026-10-30T23:35:00Z"));
		expect(recentWindow.toMs).toBe(NOW_MS);

		const old = router();
		await fetchDatadogContext(dependencies(old.impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
			startsAt: "2026-10-29T00:00:00Z",
		});
		expect(
			resolveDatadogWindow({
				nowMs: NOW_MS,
				startsAt: "2026-10-29T00:00:00Z",
			}).fromMs,
		).toBe(NOW_MS - 60 * 60_000);
		expect(
			resolveDatadogWindow({ nowMs: NOW_MS, windowMinutes: 5 }).fromMs,
		).toBe(NOW_MS - 15 * 60_000);
		expect(
			resolveDatadogWindow({ nowMs: NOW_MS, windowMinutes: 120 }).fromMs,
		).toBe(NOW_MS - 60 * 60_000);
	});

	test("caps series, points and the metric summary", async () => {
		const { impl } = router({ series: 5, points: 30 });
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
		});
		const metrics = bundle.items.find((item) => item.kind === "metrics");
		expect(metrics).toBeDefined();
		expect(metrics?.excerpt.length).toBeLessThanOrEqual(
			DATADOG_CONTEXT_MAX_METRIC_SUMMARY_CHARS,
		);
		expect((metrics?.excerpt.match(/^Series /gm) ?? []).length).toBe(3);
		expect(metrics?.excerpt).toContain("Omitted series: 2");
		expect(metrics?.excerpt).toContain("Points truncated to the last 20");
		for (const line of metrics?.excerpt.split("\n") ?? []) {
			if (line.startsWith("  points: ")) {
				expect(line.split(",").length).toBeLessThanOrEqual(20);
			}
		}
		expect(bundle.truncated).toBe(true);
	});

	test("aggregates logs without message bodies and redacts PII", async () => {
		const { impl } = router({ logEntries: 20 });
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
		});
		const logs = bundle.items.find((item) => item.kind === "logs");
		expect(logs).toBeDefined();
		expect(logs?.title).toContain("20 entries");
		expect(logs?.excerpt.length).toBeLessThanOrEqual(
			DATADOG_CONTEXT_MAX_LOG_CHARS,
		);
		expect(logs?.excerpt).toContain("Status: error=12, warn=3, info=5");
		expect(logs?.excerpt).toContain("Error kinds: timeout=");
		expect(logs?.excerpt).toContain("[email-redacted]");
		expect(logs?.excerpt).toContain("[ip-redacted]");
		expect(logs?.excerpt).not.toContain("raw log body");
		expect(logs?.excerpt).not.toContain("logsecret");
		expect(logs?.excerpt).not.toContain("alice@example.com");
		expect(bundle.truncated).toBe(true);
	});

	test("caps a long log page at 20 entries and marks truncation", async () => {
		const { impl } = router({ logEntries: 25, logsAfter: null });
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
		});
		const logs = bundle.items.find((item) => item.kind === "logs");
		expect(logs?.excerpt).toContain("Entries: 20 (limit 20)");
		expect(bundle.truncated).toBe(true);
	});

	test("incident and monitor excerpts drop notes and message bodies", async () => {
		const { impl } = router();
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
			incidentId: INCIDENT_ID,
			monitorId: MONITOR_ID,
		});
		const incident = bundle.items.find((item) => item.kind === "incident");
		const monitor = bundle.items.find((item) => item.kind === "monitor");
		expect(incident?.excerpt).toContain("[email-redacted]");
		expect(incident?.excerpt).toContain("[ip-redacted]");
		expect(incident?.excerpt).not.toContain("responder note");
		expect(monitor?.excerpt).toContain("State: Alert");
		expect(monitor?.excerpt).not.toContain("supersecret");
		expect(monitor?.excerpt).not.toContain("hooks.example.com");
		expect(monitor?.excerpt).not.toContain("owner:alice");
	});

	test("degrades to a partial bundle on 403 and 404", async () => {
		const { impl, calls } = router({
			incidentStatus: 403,
			monitorStatus: 404,
			metricsStatus: 403,
			logsStatus: 404,
		});
		const bundle = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: "checkout",
			incidentId: INCIDENT_ID,
			monitorId: MONITOR_ID,
		});
		expect(bundle.items).toEqual([]);
		expect(bundle.truncated).toBe(true);
		expect(calls.length).toBe(4);
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
	});

	test("skips incident and monitor calls, and logs when disabled", async () => {
		const { impl, calls } = router();
		const bundle = await fetchDatadogContext(
			dependencies(impl, { logsEnabled: false }),
			{
				incidentFingerprint: "datadog:1:abc",
				service: "checkout",
			},
		);
		expect(calls.length).toBe(1);
		expect(bundle.items.map((item) => item.kind)).toEqual(["metrics"]);
		expect(bundle.truncated).toBe(true);
	});

	test("maps 429, 401, timeouts and oversized responses without leaking keys", async () => {
		const rateLimited = await fetchDatadogContext(
			dependencies(router({ metricsStatus: 429 }).impl),
			{ incidentFingerprint: "datadog:1:abc", service: "checkout" },
		).catch((error: unknown) => error);
		expect(rateLimited).toBeInstanceOf(PlatformError);
		expect((rateLimited as PlatformError).code).toBe("RATE_LIMITED");

		const unauthorized = await fetchDatadogContext(
			dependencies(router({ incidentStatus: 401 }).impl),
			{
				incidentFingerprint: "datadog:1:abc",
				service: "checkout",
				incidentId: INCIDENT_ID,
			},
		).catch((error: unknown) => error);
		expect(unauthorized).toBeInstanceOf(PlatformError);
		expect((unauthorized as PlatformError).code).toBe(
			"INTEGRATION_UNAVAILABLE",
		);

		const timeout = await fetchDatadogContext(
			dependencies(router({ throwOn: "metrics" }).impl),
			{ incidentFingerprint: "datadog:1:abc", service: "checkout" },
		).catch((error: unknown) => error);
		expect(timeout).toBeInstanceOf(PlatformError);
		expect((timeout as PlatformError).code).toBe("INTEGRATION_UNAVAILABLE");

		const oversized = await fetchDatadogContext(
			dependencies(router({ oversized: "logs" }).impl),
			{
				incidentFingerprint: "datadog:1:abc",
				service: "checkout",
				incidentId: INCIDENT_ID,
				monitorId: MONITOR_ID,
			},
		);
		expect(oversized.items.map((item) => item.kind)).toEqual([
			"incident",
			"monitor",
			"metrics",
		]);
		expect(oversized.truncated).toBe(true);

		for (const error of [rateLimited, unauthorized, timeout]) {
			const serialized = JSON.stringify(error);
			expect(serialized).not.toContain(API_KEY);
			expect(serialized).not.toContain(APP_KEY);
			expect(serialized).not.toContain(BASE);
			expect(serialized).not.toContain("socket");
		}
	});

	test("rejects invalid configuration and inputs with fixed errors", async () => {
		const { impl, calls } = router();
		const cases: Array<{
			deps?: Partial<DatadogContextDependencies>;
			input?: Partial<Parameters<typeof fetchDatadogContext>[1]>;
			code: ErrorCode;
		}> = [
			{
				deps: { baseUrl: "http://api.datadoghq.com" },
				code: "VALIDATION_FAILED",
			},
			{
				deps: { baseUrl: "https://user:pass@api.datadoghq.com" },
				code: "VALIDATION_FAILED",
			},
			{
				deps: { baseUrl: "https://api.datadoghq.com/api/v2" },
				code: "VALIDATION_FAILED",
			},
			{ deps: { apiKey: "  " }, code: "MISSING_CONFIG" },
			{ deps: { appKey: "" }, code: "MISSING_CONFIG" },
			{ input: { service: "" }, code: "VALIDATION_FAILED" },
			{
				input: { service: 'api"} or vector(1)' },
				code: "VALIDATION_FAILED",
			},
			{ input: { incidentFingerprint: "" }, code: "VALIDATION_FAILED" },
			{
				input: { incidentId: "../../admin" },
				code: "VALIDATION_FAILED",
			},
			{ input: { monitorId: "12a" }, code: "VALIDATION_FAILED" },
		];
		for (const entry of cases) {
			const error = await fetchDatadogContext(dependencies(impl, entry.deps), {
				incidentFingerprint: "datadog:1:abc",
				service: "checkout",
				...entry.input,
			}).catch((thrown: unknown) => thrown);
			expect(error).toBeInstanceOf(PlatformError);
			expect((error as PlatformError).code).toBe(entry.code);
		}
		expect(calls.length).toBe(0);
	});

	test("payload text cannot alter the metric or log template", async () => {
		const { impl, calls } = router();
		const error = await fetchDatadogContext(dependencies(impl), {
			incidentFingerprint: "datadog:1:abc",
			service: 'api"} or vector(1)',
		}).catch((thrown: unknown) => thrown);
		expect((error as PlatformError).code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);
	});

	test("normalizes site API origins only", () => {
		expect(normalizeDatadogBaseUrl("https://api.datadoghq.com/")).toBe(BASE);
		expect(normalizeDatadogBaseUrl("https://api.us5.datadoghq.com")).toBe(
			"https://api.us5.datadoghq.com",
		);
		for (const bad of [
			"http://api.datadoghq.com",
			"https://api.datadoghq.com/api",
			"https://api.datadoghq.com/?x=1",
			"https://user@api.datadoghq.com",
		]) {
			expect(() => normalizeDatadogBaseUrl(bad)).toThrow(PlatformError);
		}
	});

	test("honors a reduced excerpt cap and hashes the redacted excerpt", async () => {
		const { impl } = router();
		const bundle = await fetchDatadogContext(
			dependencies(impl, { maxExcerptChars: 40 }),
			{
				incidentFingerprint: "datadog:1:abc",
				service: "checkout",
				incidentId: INCIDENT_ID,
				monitorId: MONITOR_ID,
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
		expect(bundleBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
	});
});
