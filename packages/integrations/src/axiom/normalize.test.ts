import { describe, expect, test } from "bun:test";
import {
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import {
	AXIOM_INCIDENT_KIND,
	axiomIncidentFingerprint,
	axiomIncidentSignalSchema,
	axiomSeverityOf,
	normalizeAxiomIncident,
} from "./normalize";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const RECEIVED_AT = "2026-10-31T00:00:01.000Z";

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
		url: "https://app.axiom.co/datasets/app-logs?query=secret#panel",
		fields: {
			runbook_url: "https://runbooks.example.com/checkout?token=abc",
		},
		...overrides,
	};
}

function normalize(overrides: Record<string, unknown> = {}) {
	return normalizeAxiomIncident(payload(overrides), {
		receivedAt: RECEIVED_AT,
		nowMs: NOW_MS,
	});
}

describe("normalizeAxiomIncident", () => {
	test("normalizes a triggered monitor alert", () => {
		const signal = normalize();
		expect(signal).not.toBeNull();
		expect(signal?.source).toBe("axiom");
		expect(signal?.kind).toBe(AXIOM_INCIDENT_KIND);
		expect(signal?.severity).toBe("critical");
		expect(signal?.service).toBe("checkout");
		expect(signal?.fingerprint.startsWith("axiom:mon-checkout-errors:")).toBe(
			true,
		);
		expect(signal?.fingerprint.length).toBeLessThanOrEqual(128);
		expect(signal?.title).toContain("Checkout error rate");
		expect(signal?.summary).toContain("Dataset: app-logs");
		expect(signal?.summary).toContain("Value: 12.5");
		expect(signal?.summary).toContain("Threshold: 10");
		expect(signal?.receivedAt).toBe(RECEIVED_AT);
		expect(signal?.links.map((link) => link.label)).toEqual([
			"Monitor",
			"Runbook",
		]);
		// Query strings and fragments are dropped from display-only links.
		expect(signal?.links[0]?.url).toBe(
			"https://app.axiom.co/datasets/app-logs",
		);
		expect(signal?.links[1]?.url).toBe("https://runbooks.example.com/checkout");
		expect(axiomIncidentSignalSchema.safeParse(signal).success).toBe(true);
	});

	test("maps source severity deterministically", () => {
		expect(axiomSeverityOf("critical")).toBe("critical");
		expect(axiomSeverityOf("error")).toBe("high");
		expect(axiomSeverityOf("warning")).toBe("medium");
		expect(axiomSeverityOf("warn")).toBe("medium");
		expect(axiomSeverityOf("info")).toBe("low");
		expect(axiomSeverityOf("low")).toBe("low");
		expect(axiomSeverityOf(undefined)).toBe("high");
		expect(axiomSeverityOf("unexpected")).toBe("high");
	});

	test("creates nothing for resolved or unrecognized actions", () => {
		expect(normalize({ action: "resolved" })).toBeNull();
		expect(normalize({ action: "triggered", state: "resolved" })).toBeNull();
		expect(normalize({ action: "ok" })).toBeNull();
		expect(normalize({ action: "exploded" })).toBeNull();
	});

	test("rejects stale, future and missing timestamps", () => {
		expect(
			normalize({
				timestamp: new Date(NOW_MS - 15 * 60_000 - 1).toISOString(),
			}),
		).toBeNull();
		expect(
			normalize({
				timestamp: new Date(NOW_MS + 15 * 60_000 + 1).toISOString(),
			}),
		).toBeNull();
		const missing = payload();
		delete missing.timestamp;
		expect(
			normalizeAxiomIncident(missing, {
				nowMs: NOW_MS,
				receivedAt: RECEIVED_AT,
			}),
		).toBeNull();
	});

	test("rejects unknown payload fields", () => {
		expect(normalize({ delivery_id: "delivery-1" })).toBeNull();
		expect(normalize({ monitor: { id: "mon-1" } })).toBeNull();
	});

	test("derives the service from fields and fails back safely", () => {
		expect(
			normalize({
				service: undefined,
				fields: { service: "payments" },
			})?.service,
		).toBe("payments");
		expect(
			normalize({
				service: undefined,
				monitor_name: undefined,
				fields: { app: "cart" },
			})?.service,
		).toBe("cart");
		expect(
			normalize({
				service: undefined,
				monitor_name: undefined,
				fields: {},
			})?.service,
		).toBe("axiom");
	});

	test("redacts emails, IPs and URL queries before bounding", () => {
		const signal = normalize({
			monitor_name: "Errors for alice@example.com",
			service: "10.1.2.3",
		});
		expect(signal).not.toBeNull();
		const rendered = `${signal?.title}\n${signal?.summary}`;
		expect(rendered).not.toContain("alice@example.com");
		expect(rendered).not.toContain("10.1.2.3");
		expect(rendered).toContain("[email-redacted]");
		expect(rendered).toContain("[ip-redacted]");
		expect(signal?.links.map((link) => link.url)).not.toContain(
			"https://runbooks.example.com/checkout?token=abc",
		);
	});

	test("caps the title and summary", () => {
		const signal = normalize({
			monitor_name: "n".repeat(200),
			group: "g".repeat(200),
		});
		expect(signal?.title.length).toBeLessThanOrEqual(MAX_INCIDENT_TITLE_CHARS);
		expect(signal?.summary.length).toBeLessThanOrEqual(
			MAX_INCIDENT_SUMMARY_CHARS,
		);
	});

	test("fingerprint is stable and keyed by monitor, dataset, group and state", () => {
		const base = axiomIncidentFingerprint({
			monitorId: "mon-1",
			dataset: "app-logs",
			groupKey: "checkout",
			state: "triggered",
		});
		expect(
			axiomIncidentFingerprint({
				monitorId: "mon-1",
				dataset: "app-logs",
				groupKey: "checkout",
				state: "triggered",
			}),
		).toBe(base);
		expect(
			axiomIncidentFingerprint({
				monitorId: "mon-1",
				dataset: "other-logs",
				groupKey: "checkout",
				state: "triggered",
			}),
		).not.toBe(base);
		expect(
			axiomIncidentFingerprint({
				monitorId: "mon-1",
				dataset: "app-logs",
				groupKey: "payments",
				state: "triggered",
			}),
		).not.toBe(base);
		expect(
			axiomIncidentFingerprint({
				monitorId: "mon-1",
				dataset: "app-logs",
				groupKey: "checkout",
				state: "resolved",
			}),
		).not.toBe(base);
		expect(
			axiomIncidentFingerprint({
				monitorId: "m".repeat(96),
				dataset: "app-logs",
				groupKey: "g",
				state: "triggered",
			}).length,
		).toBeLessThanOrEqual(128);
	});
});
