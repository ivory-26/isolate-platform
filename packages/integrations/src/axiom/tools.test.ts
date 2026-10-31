import { describe, expect, test } from "bun:test";
import type { AxiomContextDependencies, AxiomFetchLike } from "./context";
import {
	AXIOM_TOOL_RISK_BANDS,
	axiomGetMonitorInputSchema,
	axiomListDatasetsInputSchema,
	axiomQueryAplInputSchema,
	createAxiomReadTools,
	getAxiomMonitor,
	listAxiomDatasets,
	queryAxiomApl,
} from "./tools";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const BASE = "https://api.axiom.co";
const TOKEN = "xapt_w17tools0123456789";
const DATASET = "app-logs";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function router(options: { status?: number; datasets?: number } = {}): {
	impl: AxiomFetchLike;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl: AxiomFetchLike = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		const status = options.status ?? 200;
		if (status !== 200) return json(status, { message: "unavailable" });
		if (url.endsWith("/v1/datasets")) {
			const count = options.datasets ?? 2;
			return json(200, {
				datasets: Array.from({ length: count }, (_, index) => ({
					id: `ds-${index}`,
					name: `dataset-${String(index).padStart(2, "0")}`,
				})),
			});
		}
		return json(200, {
			matches: [
				{
					fields: ["service", "status", "count"],
					data: [["checkout", "500", 41]],
				},
			],
		});
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

describe("Axiom read tools", () => {
	test("every tool is read_only and registry descriptors match", () => {
		expect(AXIOM_TOOL_RISK_BANDS).toEqual({
			"axiom.query_apl": "read_only",
			"axiom.get_monitor": "read_only",
			"axiom.list_datasets": "read_only",
		});
		const tools = createAxiomReadTools(dependencies(router().impl));
		expect(tools.map((tool) => tool.name)).toEqual([
			"axiom.query_apl",
			"axiom.get_monitor",
			"axiom.list_datasets",
		]);
		for (const tool of tools) expect(tool.risk).toBe("read_only");
	});

	test("inputs are strict: no dataset, URL, range or extra argument", () => {
		const apl = `['${DATASET}'] | limit 1`;
		expect(axiomQueryAplInputSchema.safeParse({ apl }).success).toBe(true);
		expect(
			axiomQueryAplInputSchema.safeParse({ apl, dataset: "other" }).success,
		).toBe(false);
		expect(
			axiomQueryAplInputSchema.safeParse({ apl, url: "https://x.example" })
				.success,
		).toBe(false);
		expect(
			axiomQueryAplInputSchema.safeParse({
				apl,
				endTime: "2026-10-31T00:00:00Z",
			}).success,
		).toBe(false);
		expect(
			axiomQueryAplInputSchema.safeParse({ apl, windowMinutes: 90 }).success,
		).toBe(false);
		expect(
			axiomGetMonitorInputSchema.safeParse({ monitorId: "../../admin" })
				.success,
		).toBe(false);
		expect(
			axiomListDatasetsInputSchema.safeParse({ dataset: DATASET }).success,
		).toBe(false);
	});

	test("query_apl executes one guarded call and returns a bounded item", async () => {
		const { impl, calls } = router();
		const result = await queryAxiomApl(dependencies(impl), {
			apl: `['${DATASET}'] | summarize count = count() by service | limit 5`,
		});
		expect(result.ok).toBe(true);
		expect(result.tool).toBe("axiom.query_apl");
		expect(result.risk).toBe("read_only");
		if (result.ok) {
			expect(result.item?.kind).toBe("apl_aggregate");
			expect(result.item?.trustLevel).toBe("untrusted");
			expect(result.item?.excerpt).toContain("checkout | 500 | 41");
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(`${BASE}/v1/query/_apl?format=tabular`);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("query_apl rejects mutation, wildcard and cross-dataset APL before any call", async () => {
		const { impl, calls } = router();
		const rejected = [
			`['${DATASET}'] | delete`,
			`['${DATASET}'] | update set x = 1`,
			`['${DATASET}'] | project *`,
			`['${DATASET}'] | join (['other-logs']) on service`,
			`['${DATASET}'] | summarize x = evil(service)`,
			`['${DATASET}'] | limit 1; drop ${DATASET}`,
			"let x = 1",
			"['other-logs'] | limit 1",
		];
		for (const apl of rejected) {
			const result = await queryAxiomApl(dependencies(impl), { apl });
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("expected a validation failure");
			expect(result.code).toBe("VALIDATION_FAILED");
		}
		expect(calls.length).toBe(0);
	});

	test("query_apl maps 429 and invalid arguments without leaking the token", async () => {
		const rateLimited = await queryAxiomApl(
			dependencies(router({ status: 429 }).impl),
			{
				apl: `['${DATASET}'] | limit 1`,
			},
		);
		expect(rateLimited.ok).toBe(false);
		if (!rateLimited.ok) {
			expect(rateLimited.code).toBe("RATE_LIMITED");
			expect(rateLimited.message).toContain("rate limited");
		}
		const invalid = await queryAxiomApl(dependencies(router().impl), {
			apl: "",
		});
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.code).toBe("VALIDATION_FAILED");
		expect(JSON.stringify(rateLimited)).not.toContain(TOKEN);
	});

	test("get_monitor reads the registry and never calls the provider", async () => {
		const { impl, calls } = router();
		const result = await getAxiomMonitor(
			dependencies(impl, {
				monitors: [
					{
						id: "mon-1",
						name: "Checkout errors",
						dataset: DATASET,
						state: "triggered",
						threshold: 10,
					},
				],
			}),
			{ monitorId: "mon-1" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.item?.kind).toBe("monitor");
			expect(result.item?.excerpt).toContain("Checkout errors");
		}
		expect(calls.length).toBe(0);

		const unknown = await getAxiomMonitor(
			dependencies(impl, {
				monitors: [{ id: "mon-1", name: "X", dataset: DATASET }],
			}),
			{ monitorId: "mon-2" },
		);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.code).toBe("NOT_FOUND");

		const outOfScope = await getAxiomMonitor(
			dependencies(impl, {
				monitors: [{ id: "mon-1", name: "X", dataset: "other-logs" }],
			}),
			{ monitorId: "mon-1" },
		);
		expect(outOfScope.ok).toBe(false);
		if (!outOfScope.ok) expect(outOfScope.code).toBe("POLICY_DENIED");

		const missingRegistry = await getAxiomMonitor(dependencies(impl), {
			monitorId: "mon-1",
		});
		expect(missingRegistry.ok).toBe(false);
		if (!missingRegistry.ok)
			expect(missingRegistry.code).toBe("MISSING_CONFIG");
		expect(calls.length).toBe(0);
	});

	test("list_datasets reads one bound page and caps the rendered list", async () => {
		const { impl, calls } = router({ datasets: 60 });
		const result = await listAxiomDatasets(dependencies(impl), {});
		expect(result.ok).toBe(true);
		expect(result.tool).toBe("axiom.list_datasets");
		if (result.ok) {
			expect(result.item?.kind).toBe("dataset_list");
			expect(result.item?.excerpt).toContain("Datasets: 60");
			expect(result.item?.excerpt).toContain("- dataset-00 (ds-0)");
			expect(result.item?.excerpt).toContain("dataset-49");
			expect(result.item?.excerpt).not.toContain("dataset-50");
			expect(result.item?.excerpt.length).toBeLessThanOrEqual(2000);
			expect(result.truncated).toBe(true);
		}
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(`${BASE}/v1/datasets`);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("list_datasets degrades on 403 and fails on 401", async () => {
		const denied = await listAxiomDatasets(
			dependencies(router({ status: 403 }).impl),
			{},
		);
		expect(denied.ok).toBe(true);
		if (denied.ok) {
			expect(denied.item).toBeNull();
			expect(denied.truncated).toBe(true);
		}
		const unauthorized = await listAxiomDatasets(
			dependencies(router({ status: 401 }).impl),
			{},
		);
		expect(unauthorized.ok).toBe(false);
		if (!unauthorized.ok) {
			expect(unauthorized.code).toBe("INTEGRATION_UNAVAILABLE");
		}
	});

	test("invalid arguments are rejected before any provider call", async () => {
		const { impl, calls } = router();
		const result = await queryAxiomApl(dependencies(impl), {
			apl: `['${DATASET}'] | limit 1`,
			dataset: "other",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("VALIDATION_FAILED");
		expect(calls.length).toBe(0);
	});
});
