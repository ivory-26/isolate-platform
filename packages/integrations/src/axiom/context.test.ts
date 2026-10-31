import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import {
	AXIOM_CONTEXT_MAX_FETCH_CALLS,
	AXIOM_CONTEXT_MAX_ROWS,
	AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
	type AxiomContextDependencies,
	type AxiomFetchLike,
	axiomContextBundleSchema,
	fetchAxiomIncidentContext,
	fetchAxiomMonitorEvidence,
	normalizeAxiomBaseUrl,
} from "./context";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const BASE = "https://api.axiom.co";
const TOKEN = "xapt_w17context0123456789";
const DATASET = "app-logs";

type Call = { url: string; init: RequestInit };

type RouterOptions = {
	datasetStatus?: number;
	aplStatus?: number;
	rows?: number;
	oversized?: boolean;
	malformed?: boolean;
	throwOn?: "datasets" | "apl";
	piiCell?: boolean;
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function aplRows(count: number, piiCell: boolean): unknown[][] {
	return Array.from({ length: count }, (_, index) =>
		index === 0 && piiCell
			? ["checkout", "alice@example.com", "500", "10.1.2.3", 99]
			: ["checkout", "production", "500", "timeout", index + 1],
	);
}

function router(options: RouterOptions = {}): {
	impl: AxiomFetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl: AxiomFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		const request = init ?? {};
		calls.push({ url, init: request });
		if (url.endsWith("/v1/datasets")) {
			if (options.throwOn === "datasets") throw new Error("socket closed");
			const status = options.datasetStatus ?? 200;
			if (status !== 200) return json(status, { message: "unavailable" });
			return json(200, {
				datasets: [
					{ id: "ds-1", name: DATASET, description: "dropped" },
					{ id: "ds-2", name: "other-logs" },
				],
			});
		}
		if (url.endsWith("/v1/query/_apl?format=tabular")) {
			if (options.throwOn === "apl") throw new Error("timeout");
			const status = options.aplStatus ?? 200;
			if (status !== 200) return json(status, { message: "unavailable" });
			if (options.oversized === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			if (options.malformed === true) {
				return new Response("{not json", { status: 200 });
			}
			return json(200, {
				matches: [
					{
						fields: ["service", "environment", "status", "error_kind", "count"],
						data: aplRows(options.rows ?? 2, options.piiCell === true),
					},
				],
			});
		}
		return json(404, { message: "not found" });
	};
	return { impl, calls };
}

function dependencies(
	impl: AxiomFetchLike,
	overrides: Partial<AxiomContextDependencies> = {},
): AxiomContextDependencies {
	return {
		baseUrl: BASE,
		token: TOKEN,
		dataset: DATASET,
		allowedDatasets: [DATASET],
		fetchImpl: impl,
		now: () => NOW_MS,
		timeoutMs: 5000,
		...overrides,
	};
}

function requestBody(call: Call): {
	apl: string;
	startTime: string;
	endTime: string;
} {
	return JSON.parse(String(call.init.body));
}

async function platformError(
	promise: Promise<unknown>,
): Promise<PlatformError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof PlatformError) return error;
		throw error;
	}
	throw new Error("expected a PlatformError");
}

describe("fetchAxiomIncidentContext", () => {
	test("assembles a contract-valid bundle with the fixed two-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchAxiomIncidentContext(
			dependencies(impl, {
				monitors: [
					{
						id: "mon-1",
						name: "Checkout errors",
						dataset: DATASET,
						state: "triggered",
						threshold: 10,
						value: 12.5,
					},
				],
			}),
			{
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
				monitorId: "mon-1",
			},
		);

		expect(axiomContextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"apl_aggregate",
			"monitor",
			"dataset",
		]);
		for (const item of bundle.items) {
			expect(item.source).toBe("axiom");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(item.sha256).toBe(
				createHash("sha256").update(item.excerpt).digest("hex"),
			);
			expect(item.url?.startsWith("https://")).toBe(true);
		}
		expect(bundle.truncated).toBe(false);
		expect(calls.length).toBe(2);
		expect(calls.length).toBeLessThanOrEqual(AXIOM_CONTEXT_MAX_FETCH_CALLS);
		expect(calls[0]?.url).toBe(`${BASE}/v1/datasets`);
		expect(calls[1]?.url).toBe(`${BASE}/v1/query/_apl?format=tabular`);

		for (const call of calls) {
			const headers = call.init.headers as Record<string, string>;
			expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
			expect(call.url).not.toContain(TOKEN);
		}

		const body = requestBody(calls[1] as Call);
		expect(body.apl.startsWith(`['${DATASET}']`)).toBe(true);
		expect(body.apl).toContain("summarize count = count()");
		expect(body.apl).not.toContain("project *");
		expect(body.apl).toContain("limit 20");
		expect(body.startTime).toBe("2026-10-30T23:30:00.000Z");
		expect(body.endTime).toBe("2026-10-31T00:00:00.000Z");

		expect(bundle.items[0]?.excerpt).toContain("checkout | production");
		expect(bundle.items[0]?.excerpt.length).toBeLessThanOrEqual(
			AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
		);
		expect(bundle.items[2]?.excerpt).toContain(`Dataset: ${DATASET}`);
		expect(bundle.items[2]?.excerpt).toContain("ID: ds-1");
		expect(JSON.stringify(bundle)).not.toContain(TOKEN);
	});

	test("clamps the window to startsAt − 15 min and 60 minutes", async () => {
		const recent = router();
		await fetchAxiomIncidentContext(dependencies(recent.impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
			startsAt: "2026-10-30T23:50:00Z",
		});
		expect(requestBody(recent.calls[1] as Call).startTime).toBe(
			"2026-10-30T23:35:00.000Z",
		);

		const old = router();
		await fetchAxiomIncidentContext(dependencies(old.impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
			startsAt: "2026-10-29T00:00:00Z",
		});
		expect(requestBody(old.calls[1] as Call).startTime).toBe(
			"2026-10-30T23:00:00.000Z",
		);

		const narrow = router();
		await fetchAxiomIncidentContext(dependencies(narrow.impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
			windowMinutes: 5,
		});
		expect(requestBody(narrow.calls[1] as Call).startTime).toBe(
			"2026-10-30T23:55:00.000Z",
		);
	});

	test("caps rows and the aggregate summary", async () => {
		const { impl } = router({ rows: 40 });
		const bundle = await fetchAxiomIncidentContext(dependencies(impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
		});
		const aggregate = bundle.items[0];
		expect(aggregate?.kind).toBe("apl_aggregate");
		expect(aggregate?.excerpt).toContain("showing 20");
		expect(aggregate?.excerpt.length).toBeLessThanOrEqual(
			AXIOM_CONTEXT_MAX_SUMMARY_CHARS,
		);
		const rowLines = (aggregate?.excerpt.match(/^checkout \|/gm) ?? []).length;
		expect(rowLines).toBeLessThanOrEqual(AXIOM_CONTEXT_MAX_ROWS);
		expect(bundle.truncated).toBe(true);
	});

	test("redacts credentials and PII before truncation", async () => {
		const { impl } = router({ piiCell: true, rows: 2 });
		const bundle = await fetchAxiomIncidentContext(dependencies(impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
		});
		const excerpt = bundle.items[0]?.excerpt ?? "";
		expect(excerpt).not.toContain("alice@example.com");
		expect(excerpt).not.toContain("10.1.2.3");
		expect(excerpt).toContain("[email-redacted]");
		expect(excerpt).toContain("[ip-redacted]");
		expect(JSON.stringify(bundle)).not.toContain(TOKEN);
	});

	test("degrades to a partial bundle on 403 and 404", async () => {
		const { impl, calls } = router({
			datasetStatus: 403,
			aplStatus: 404,
		});
		const bundle = await fetchAxiomIncidentContext(dependencies(impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
		});
		expect(bundle.items).toEqual([]);
		expect(bundle.truncated).toBe(true);
		expect(calls.length).toBe(2);
		expect(axiomContextBundleSchema.safeParse(bundle).success).toBe(true);

		const partial = router({ datasetStatus: 403 });
		const withAggregate = await fetchAxiomIncidentContext(
			dependencies(partial.impl),
			{
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
			},
		);
		expect(withAggregate.items.map((item) => item.kind)).toEqual([
			"apl_aggregate",
		]);
		expect(withAggregate.truncated).toBe(true);
	});

	test("maps 401, 429, transport failures and oversized responses", async () => {
		const unauthorized = await platformError(
			fetchAxiomIncidentContext(dependencies(router({ aplStatus: 401 }).impl), {
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
			}),
		);
		expect(unauthorized.code).toBe("INTEGRATION_UNAVAILABLE");

		const rateLimited = await platformError(
			fetchAxiomIncidentContext(dependencies(router({ aplStatus: 429 }).impl), {
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
			}),
		);
		expect(rateLimited.code).toBe("RATE_LIMITED");

		const transport = await platformError(
			fetchAxiomIncidentContext(dependencies(router({ throwOn: "apl" }).impl), {
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
			}),
		);
		expect(transport.code).toBe("INTEGRATION_UNAVAILABLE");

		const oversized = await fetchAxiomIncidentContext(
			dependencies(router({ oversized: true }).impl),
			{ incidentFingerprint: "axiom:mon-1:abc", service: "checkout" },
		);
		expect(oversized.items.map((item) => item.kind)).toEqual(["dataset"]);
		expect(oversized.truncated).toBe(true);

		const malformed = await fetchAxiomIncidentContext(
			dependencies(router({ malformed: true }).impl),
			{ incidentFingerprint: "axiom:mon-1:abc", service: "checkout" },
		);
		expect(malformed.items.map((item) => item.kind)).toEqual(["dataset"]);
		expect(malformed.truncated).toBe(true);
	});

	test("rejects an unknown dataset before any request", async () => {
		const { impl, calls } = router();
		const error = await platformError(
			fetchAxiomIncidentContext(dependencies(impl), {
				incidentFingerprint: "axiom:mon-1:abc",
				service: "checkout",
				dataset: "other-logs",
			}),
		);
		expect(error.code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);

		const configError = await platformError(
			fetchAxiomIncidentContext(
				dependencies(impl, { dataset: "unknown-logs" }),
				{ incidentFingerprint: "axiom:mon-1:abc", service: "checkout" },
			),
		);
		expect(configError.code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);
	});

	test("enforces the item budget and input validation", async () => {
		const { impl } = router();
		const bundle = await fetchAxiomIncidentContext(
			dependencies(impl, { maxItems: 1 }),
			{ incidentFingerprint: "axiom:mon-1:abc", service: "checkout" },
		);
		expect(bundle.items.map((item) => item.kind)).toEqual(["apl_aggregate"]);
		expect(bundle.truncated).toBe(true);

		expect(
			(
				await platformError(
					fetchAxiomIncidentContext(dependencies(impl), {
						incidentFingerprint: "",
						service: "checkout",
					}),
				)
			).code,
		).toBe("VALIDATION_FAILED");
		expect(
			(
				await platformError(
					fetchAxiomIncidentContext(dependencies(impl), {
						incidentFingerprint: "axiom:mon-1:abc",
						service: "",
					}),
				)
			).code,
		).toBe("VALIDATION_FAILED");
		expect(
			(
				await platformError(
					fetchAxiomIncidentContext(dependencies(impl, { token: "" }), {
						incidentFingerprint: "axiom:mon-1:abc",
						service: "checkout",
					}),
				)
			).code,
		).toBe("MISSING_CONFIG");
	});

	test("adds no monitor item for an unknown registry id", async () => {
		const { impl } = router();
		const bundle = await fetchAxiomIncidentContext(dependencies(impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
			monitorId: "mon-unknown",
		});
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"apl_aggregate",
			"dataset",
		]);
		expect(bundle.truncated).toBe(false);
	});
});

describe("fetchAxiomMonitorEvidence", () => {
	test("resolves from the trusted registry without a provider call", () => {
		const { impl, calls } = router();
		const evidence = fetchAxiomMonitorEvidence(
			dependencies(impl, {
				monitors: [
					{
						id: "mon-1",
						name: "Checkout errors",
						dataset: DATASET,
						state: "triggered",
						threshold: 10,
						value: 12.5,
					},
				],
			}),
			{ monitorId: "mon-1" },
		);
		expect(evidence.item?.kind).toBe("monitor");
		expect(evidence.item?.excerpt).toContain("Threshold: 10");
		expect(calls.length).toBe(0);
	});

	test("rejects an unknown or out-of-scope monitor", () => {
		const { impl } = router();
		expect(() =>
			fetchAxiomMonitorEvidence(
				dependencies(impl, {
					monitors: [{ id: "mon-1", name: "Checkout", dataset: DATASET }],
				}),
				{ monitorId: "mon-2" },
			),
		).toThrow("not in the configured registry");
		expect(() =>
			fetchAxiomMonitorEvidence(
				dependencies(impl, {
					monitors: [{ id: "mon-1", name: "Checkout", dataset: "other-logs" }],
				}),
				{ monitorId: "mon-1" },
			),
		).toThrow("not in the configured allowlist");
	});
});

describe("configuration bounds", () => {
	test("rejects non-https and credentialed base URLs", () => {
		for (const value of [
			"http://api.axiom.co",
			"https://user:pass@api.axiom.co",
			"https://api.axiom.co?x=1",
			"not-a-url",
		]) {
			expect(() => normalizeAxiomBaseUrl(value)).toThrow(
				"axiom baseUrl is invalid",
			);
		}
		expect(normalizeAxiomBaseUrl("https://api.axiom.co/")).toBe(
			"https://api.axiom.co",
		);
	});

	test("the total excerpt budget is the shared 256 KiB cap", async () => {
		const { impl } = router({ rows: 40 });
		const bundle = await fetchAxiomIncidentContext(dependencies(impl), {
			incidentFingerprint: "axiom:mon-1:abc",
			service: "checkout",
		});
		const bytes = new TextEncoder().encode(
			bundle.items.map((item) => item.excerpt).join(""),
		).byteLength;
		expect(bytes).toBeLessThanOrEqual(MAX_CONTEXT_TOTAL_EXCERPT_BYTES);
	});
});
