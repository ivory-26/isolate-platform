import { describe, expect, test } from "bun:test";
import {
	type ContextBundle,
	contextBundleSchema,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import { PAGERDUTY_MAX_CONTEXT_CALLS } from "./client";
import {
	fetchPagerDutyContext,
	PAGERDUTY_CONTEXT_MAX_LOG_EXCERPT_CHARS,
	type PagerDutyContextDependencies,
} from "./context";

const TOKEN = "u+readtoken-0123456789abcdef";
const FROM_EMAIL = "ops@acme.com";
const BASE_URL = "https://pd.test";
const INCIDENT_URL = "https://acme.pagerduty.com/incidents/PABC123";
const SERVICE_URL = "https://acme.pagerduty.com/services/PSVC1";
const NOW = Date.parse("2026-10-31T00:00:00.000Z");

type FetchCall = { url: string; init: RequestInit };

type RouterOptions = {
	incidentStatus?: number;
	logStatus?: number;
	serviceStatus?: number;
	policyStatus?: number;
	logCount?: number;
	logTypeLength?: number;
	oversizedService?: boolean;
	incidentTitle?: string;
	serviceName?: string;
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function incidentBody(options: RouterOptions): unknown {
	return {
		incident: {
			id: "PABC123",
			number: 42,
			status: "triggered",
			title: options.incidentTitle ?? "Checkout latency above SLO",
			urgency: "high",
			priority: { id: "PPRIO1", name: "P1" },
			service: {
				id: "PSVC1",
				name: options.serviceName ?? "checkout",
				html_url: SERVICE_URL,
				escalation_policy: { id: "PEP1", name: "Primary" },
			},
			created_at: "2026-10-30T23:59:00Z",
			updated_at: "2026-10-31T00:00:00Z",
			html_url: INCIDENT_URL,
			assignments: [
				{ assignee: { id: "PUSER1", summary: "Alice Smith alice@acme.com" } },
			],
		},
	};
}

function router(options: RouterOptions = {}): {
	impl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });

		if (url.includes("/log_entries")) {
			const status = options.logStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			const count = options.logCount ?? 20;
			const type = `incident.${"x".repeat(
				Math.max(0, (options.logTypeLength ?? 14) - 9),
			)}`;
			return json(200, {
				log_entries: Array.from({ length: count }, (_, index) => ({
					id: `PLOG${index}`,
					type,
					created_at: new Date(
						Date.parse("2026-10-30T22:00:00.000Z") + index * 60_000,
					).toISOString(),
					agent: {
						id: "PUSER1",
						type: "user",
						summary: `Alice Smith alice@acme.com +1 415-555-0100`,
					},
					channel: { type: "web_trigger" },
					note: `free text ${"n".repeat(500)}`,
				})),
				more: count > 20,
			});
		}
		if (url.includes("/escalation_policies/")) {
			const status = options.policyStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			return json(200, {
				escalation_policy: { id: "PEP1", name: "Primary" },
			});
		}
		if (url.includes("/services/")) {
			const status = options.serviceStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			if (options.oversizedService === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			return json(200, {
				service: {
					id: "PSVC1",
					name: options.serviceName ?? "checkout",
					html_url: SERVICE_URL,
					escalation_policy: { id: "PEP1", name: "Primary" },
				},
			});
		}
		if (url.startsWith(`${BASE_URL}/incidents/PABC123?`)) {
			const status = options.incidentStatus ?? 200;
			if (status !== 200) return json(status, { error: "nope" });
			return json(200, incidentBody(options));
		}
		return json(404, { error: "not found" });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function dependencies(
	impl: typeof fetch,
	overrides: Partial<PagerDutyContextDependencies> = {},
): PagerDutyContextDependencies {
	return {
		token: TOKEN,
		baseUrl: BASE_URL,
		fromEmail: FROM_EMAIL,
		fetchImpl: impl,
		now: () => NOW,
		...overrides,
	};
}

function totalBytes(bundle: ContextBundle): number {
	return new TextEncoder().encode(
		bundle.items.map((item) => item.excerpt).join(""),
	).byteLength;
}

async function captureError(promise: Promise<unknown>): Promise<PlatformError> {
	try {
		await promise;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(PlatformError);
		return thrown as PlatformError;
	}
	throw new Error("expected the promise to reject");
}

describe("fetchPagerDutyContext", () => {
	test("assembles a bounded, redacted bundle from the fixed four-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
		});

		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.incidentFingerprint).toBe("pagerduty:PSVC1:PABC123");
		expect(bundle.truncated).toBe(false);
		expect(calls).toHaveLength(PAGERDUTY_MAX_CONTEXT_CALLS);
		expect(calls.length).toBeLessThanOrEqual(PAGERDUTY_MAX_CONTEXT_CALLS);
		for (const call of calls) {
			expect(
				(call.init.headers as Record<string, string> | undefined)
					?.Authorization,
			).toBe(`Token token=${TOKEN}`);
		}

		expect(bundle.items.map((item) => item.kind)).toEqual([
			"incident",
			"log_entry",
			"service",
		]);
		for (const item of bundle.items) {
			expect(item.source).toBe("pagerduty");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe(new Date(NOW).toISOString());
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.excerpt.length).toBeLessThanOrEqual(4000);
			expect(item.url !== undefined || item.path !== undefined).toBe(true);
		}

		const log = bundle.items.find((item) => item.kind === "log_entry");
		expect(log).toBeDefined();
		expect(log?.excerpt.length).toBeLessThanOrEqual(
			PAGERDUTY_CONTEXT_MAX_LOG_EXCERPT_CHARS,
		);
		expect(log?.excerpt).toContain("actor:user");
		expect(log?.excerpt).not.toContain("Alice");
		expect(log?.excerpt).not.toContain("alice@acme.com");

		const service = bundle.items.find((item) => item.kind === "service");
		expect(service?.excerpt).toContain("Escalation policy: Primary");

		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
		const serialized = JSON.stringify(bundle);
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain(FROM_EMAIL);
		expect(serialized).not.toContain("PUSER1");
		expect(serialized).not.toContain("415-555-0100");
	});

	test("redacts PII in incident and service free text", async () => {
		const { impl } = router({
			incidentTitle: "jane@acme.com paged, call +1 415-555-0100",
			serviceName: "checkout ops@acme.com",
		});
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
		});
		const serialized = JSON.stringify(bundle);
		expect(serialized).not.toContain("jane@acme.com");
		expect(serialized).not.toContain("ops@acme.com");
		expect(serialized).not.toContain("415-555-0100");
		expect(serialized).toContain("[email-redacted]");
		expect(serialized).toContain("[phone-redacted]");
	});

	test("caps the log timeline at 20 entries and 2,000 chars", async () => {
		const { impl } = router({ logCount: 30, logTypeLength: 60 });
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
		});
		const log = bundle.items.find((item) => item.kind === "log_entry");
		expect(log).toBeDefined();
		expect(log?.excerpt.length).toBeLessThanOrEqual(2000);
		expect(log?.title).toContain("20 recent entries");
		expect(bundle.truncated).toBe(true);
	});

	test("returns a partial bundle on 403/404 for optional resources", async () => {
		const { impl } = router({ logStatus: 403, serviceStatus: 404 });
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
		});
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.map((item) => item.kind)).toEqual(["incident"]);
		expect(bundle.truncated).toBe(true);
	});

	test("treats a missing incident as absent evidence, not a hard failure", async () => {
		const { impl } = router({ incidentStatus: 404 });
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
			incidentFingerprint: "pagerduty:PSVC1:PABC123",
		});
		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items).toHaveLength(0);
		expect(bundle.truncated).toBe(true);
		expect(bundle.incidentFingerprint).toBe("pagerduty:PSVC1:PABC123");
	});

	test("fails closed on 403 for the incident itself", async () => {
		const { impl } = router({ incidentStatus: 403 });
		const error = await captureError(
			fetchPagerDutyContext(dependencies(impl), { incidentId: "PABC123" }),
		);
		expect(error.code).toBe("POLICY_DENIED");
	});

	test("maps 429 to RATE_LIMITED and 401 to INTEGRATION_UNAVAILABLE", async () => {
		for (const [status, code] of [
			[429, "RATE_LIMITED"],
			[401, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ incidentStatus: status });
			const error = await captureError(
				fetchPagerDutyContext(dependencies(impl), { incidentId: "PABC123" }),
			);
			expect(error.code).toBe(code);
			expect(error.message).not.toContain(TOKEN);
		}
	});

	test("drops an oversized provider response and marks truncation", async () => {
		const { impl } = router({ oversizedService: true });
		const bundle = await fetchPagerDutyContext(dependencies(impl), {
			incidentId: "PABC123",
		});
		expect(bundle.items.map((item) => item.kind)).not.toContain("service");
		expect(bundle.truncated).toBe(true);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
	});

	test("rejects invalid inputs before any fetch", async () => {
		const { impl, calls } = router();
		for (const input of [
			{ incidentId: "bad id" },
			{ incidentId: "PABC123", incidentFingerprint: "x".repeat(129) },
		]) {
			const error = await captureError(
				fetchPagerDutyContext(dependencies(impl), input),
			);
			expect(error.code).toBe("VALIDATION_FAILED");
		}
		expect(calls).toHaveLength(0);
	});

	test("rejects an unconfigured token without a request", async () => {
		const { impl, calls } = router();
		const error = await captureError(
			fetchPagerDutyContext(dependencies(impl, { token: "" }), {
				incidentId: "PABC123",
			}),
		);
		expect(error.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(error.message).not.toContain("TOKEN");
		expect(calls).toHaveLength(0);
	});
});
