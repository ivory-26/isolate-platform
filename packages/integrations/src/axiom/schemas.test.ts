import { describe, expect, test } from "bun:test";
import {
	AXIOM_WEBHOOK_MAX_BODY_BYTES,
	axiomAplResponseSchema,
	axiomDatasetListResponseSchema,
	axiomMonitorSchema,
	axiomWebhookPayloadSchema,
	parseAxiomWebhookPayload,
} from "./schemas";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");

function payload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		action: "triggered",
		monitor_id: "mon-checkout-errors",
		monitor_name: "Checkout error rate",
		dataset: "app-logs",
		group: "checkout",
		state: "triggered",
		value: 12.5,
		threshold: 10,
		timestamp: new Date(NOW_MS - 60_000).toISOString(),
		service: "checkout",
		environment: "production",
		severity: "critical",
		url: "https://app.axiom.co/datasets/app-logs",
		fields: {
			service: "checkout",
			runbook_url: "https://runbooks.example.com/x",
		},
		...overrides,
	};
}

describe("axiom webhook schema", () => {
	test("accepts the pinned template and treats extra fields as an error", () => {
		expect(axiomWebhookPayloadSchema.safeParse(payload()).success).toBe(true);
		expect(
			axiomWebhookPayloadSchema.safeParse(payload({ delivery_id: "d-1" }))
				.success,
		).toBe(false);
		expect(
			axiomWebhookPayloadSchema.safeParse(payload({ monitor: { id: "x" } }))
				.success,
		).toBe(false);
	});

	test("requires a timestamp, action and a valid dataset name", () => {
		const missingTimestamp = payload();
		delete (missingTimestamp as Record<string, unknown>).timestamp;
		expect(axiomWebhookPayloadSchema.safeParse(missingTimestamp).success).toBe(
			false,
		);
		expect(
			axiomWebhookPayloadSchema.safeParse(payload({ action: "" })).success,
		).toBe(false);
		for (const dataset of [
			"",
			"-logs",
			"logs/other",
			"a".repeat(65),
			"logs; drop",
		]) {
			expect(
				axiomWebhookPayloadSchema.safeParse(payload({ dataset })).success,
			).toBe(false);
		}
	});

	test("bounds every string and the fields map", () => {
		expect(
			axiomWebhookPayloadSchema.safeParse(
				payload({ monitor_name: "x".repeat(201) }),
			).success,
		).toBe(false);
		expect(
			axiomWebhookPayloadSchema.safeParse(payload({ group: "g".repeat(201) }))
				.success,
		).toBe(false);
		expect(
			axiomWebhookPayloadSchema.safeParse(
				payload({
					fields: Object.fromEntries(
						Array.from({ length: 33 }, (_, index) => [`k${index}`, "v"]),
					),
				}),
			).success,
		).toBe(false);
	});

	test("parses text and UTF-8 bytes under the 64 KiB cap", () => {
		const text = JSON.stringify(payload());
		expect(parseAxiomWebhookPayload(text)?.monitor_id).toBe(
			"mon-checkout-errors",
		);
		expect(
			parseAxiomWebhookPayload(new TextEncoder().encode(text))?.dataset,
		).toBe("app-logs");
		expect(parseAxiomWebhookPayload("{not json")).toBeNull();
		expect(parseAxiomWebhookPayload([])).toBeNull();
		const oversized = JSON.stringify({
			...payload(),
			monitor_name: "x".repeat(AXIOM_WEBHOOK_MAX_BODY_BYTES),
		});
		expect(parseAxiomWebhookPayload(oversized)).toBeNull();
		expect(
			parseAxiomWebhookPayload(
				new TextEncoder().encode(oversized),
				AXIOM_WEBHOOK_MAX_BODY_BYTES,
			),
		).toBeNull();
	});
});

describe("axiom APL response schema", () => {
	test("accepts matches[].fields/data and columns/rows", () => {
		expect(
			axiomAplResponseSchema.safeParse({
				matches: [
					{
						fields: ["service", "count"],
						data: [["checkout", 12]],
						unknown: "stripped",
					},
				],
			}).success,
		).toBe(true);
		expect(
			axiomAplResponseSchema.safeParse({
				columns: ["service", "count"],
				rows: [["checkout", 12]],
			}).success,
		).toBe(true);
	});

	test("bounds rows, fields and cell shapes", () => {
		expect(
			axiomAplResponseSchema.safeParse({
				matches: [
					{
						fields: ["count"],
						data: Array.from({ length: 101 }, () => [1]),
					},
				],
			}).success,
		).toBe(false);
		expect(
			axiomAplResponseSchema.safeParse({
				matches: [
					{ fields: Array.from({ length: 33 }, (_, i) => `f${i}`), data: [] },
				],
			}).success,
		).toBe(false);
		expect(
			axiomAplResponseSchema.safeParse({
				matches: [{ fields: ["count"], data: [[{ nested: true }]] }],
			}).success,
		).toBe(false);
		expect(
			axiomAplResponseSchema.safeParse({
				matches: [{ fields: ["count"], data: [[Number.NaN]] }],
			}).success,
		).toBe(false);
	});
});

describe("axiom dataset and monitor schemas", () => {
	test("accepts both dataset list spellings and rejects bad names", () => {
		const list = [{ id: "ds-1", name: "app-logs" }, { name: "checkout-prod" }];
		expect(axiomDatasetListResponseSchema.safeParse(list).success).toBe(true);
		expect(
			axiomDatasetListResponseSchema.safeParse({ datasets: list }).success,
		).toBe(true);
		expect(
			axiomDatasetListResponseSchema.safeParse([{ name: "bad name" }]).success,
		).toBe(false);
	});

	test("monitor registry entries are strict and dataset-bound", () => {
		const monitor = {
			id: "mon-1",
			name: "Checkout errors",
			dataset: "app-logs",
			state: "triggered",
			threshold: 10,
		};
		expect(axiomMonitorSchema.safeParse(monitor).success).toBe(true);
		expect(
			axiomMonitorSchema.safeParse({ ...monitor, secret: "x" }).success,
		).toBe(false);
		expect(
			axiomMonitorSchema.safeParse({ ...monitor, dataset: "../other" }).success,
		).toBe(false);
	});
});
