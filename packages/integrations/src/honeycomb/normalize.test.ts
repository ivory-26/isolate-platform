import { describe, expect, test } from "bun:test";
import {
	HONEYCOMB_ALERT_MAX_AGE_MS,
	HONEYCOMB_TRIGGER_INCIDENT_KIND,
	honeycombIncidentFingerprint,
	honeycombIncidentSeverity,
	normalizeHoneycombIncident,
} from "./normalize";
import type { HoneycombAlertState } from "./schemas";

const RECEIVED_AT = "2026-10-31T00:00:00.000Z";

type FixtureOptions = {
	state?: HoneycombAlertState;
	observed?: number;
	timestamp?: string;
	unknownField?: boolean;
	triggerUrl?: string;
};

type FixturePayload = {
	dataset: string;
	service: { name: string };
	environment: string;
	trigger: {
		id: string;
		name: string;
		state: string;
		threshold: { op: string; value: number };
		url: string;
	};
	alert: {
		id: string;
		state: string;
		timestamp: string;
		url: string;
	};
	result: { value: number };
	recipients?: string[];
	webhook_url?: string;
};

function payload(options: FixtureOptions = {}): FixturePayload {
	const state = options.state ?? "triggered";
	return {
		dataset: "checkout",
		service: { name: "checkout-api" },
		environment: "production",
		trigger: {
			id: "trg-1",
			name: "Checkout latency",
			state,
			threshold: { op: ">", value: 500 },
			url:
				options.triggerUrl ?? "https://ui.honeycomb.io/checkout/triggers/trg-1",
		},
		alert: {
			id: "alert-1",
			state,
			timestamp: options.timestamp ?? "2026-10-30T23:55:00.000Z",
			url: "https://ui.honeycomb.io/checkout/alerts/alert-1",
		},
		result: { value: options.observed ?? 900 },
		...(options.unknownField === true
			? { recipients: ["ops@example.com"], webhook_url: "https://secret" }
			: {}),
	};
}

describe("normalizeHoneycombIncident", () => {
	test("normalizes one trigger delivery into a bounded signal", () => {
		const signal = normalizeHoneycombIncident(payload(), {
			receivedAt: RECEIVED_AT,
			deliveryId: "delivery-1",
		});
		expect(signal).not.toBeNull();
		expect(signal?.source).toBe("honeycomb");
		expect(signal?.kind).toBe(HONEYCOMB_TRIGGER_INCIDENT_KIND);
		expect(signal?.severity).toBe("high");
		expect(signal?.service).toBe("checkout-api");
		expect(signal?.fingerprint).toBe("honeycomb:checkout:trg-1:triggered");
		expect(signal?.receivedAt).toBe(RECEIVED_AT);
		expect(signal?.summary).toContain("Threshold: > 500");
		expect(signal?.summary).toContain("Observed: 900");
		expect(signal?.summary).toContain("Delivery: delivery-1");
		expect(signal?.summary).not.toContain("ops@example.com");
		expect(signal?.links.map((link) => link.label)).toEqual([
			"Honeycomb trigger",
			"Honeycomb alert",
		]);
		expect((signal?.title.length ?? 0) <= 200).toBe(true);
	});

	test("escalates a 2x threshold breach to critical", () => {
		const signal = normalizeHoneycombIncident(payload({ observed: 1200 }), {
			receivedAt: RECEIVED_AT,
		});
		expect(signal?.severity).toBe("critical");
	});

	test("maps state and threshold deterministically", () => {
		expect(honeycombIncidentSeverity({ state: "critical" })).toBe("critical");
		expect(honeycombIncidentSeverity({ state: "warning" })).toBe("medium");
		expect(honeycombIncidentSeverity({ state: "firing" })).toBe("high");
		expect(
			honeycombIncidentSeverity({
				state: "firing",
				threshold: { op: "<", value: 100 },
				observed: 40,
			}),
		).toBe("critical");
		expect(
			honeycombIncidentSeverity({
				state: "firing",
				threshold: { op: ">", value: 500 },
				observed: 900,
			}),
		).toBe("high");
		expect(honeycombIncidentSeverity({ state: "resolved" })).toBeNull();
		expect(honeycombIncidentSeverity({ state: "ok" })).toBeNull();
		expect(honeycombIncidentSeverity({ state: "recovered" })).toBeNull();
	});

	test("creates nothing for non-triggering lifecycle states", () => {
		for (const state of ["ok", "resolved", "recovered"] as const) {
			expect(
				normalizeHoneycombIncident(payload({ state }), {
					receivedAt: RECEIVED_AT,
				}),
			).toBeNull();
		}
	});

	test("rejects an alert older than 15 minutes", () => {
		const stale = new Date(
			Date.parse(RECEIVED_AT) - HONEYCOMB_ALERT_MAX_AGE_MS - 1000,
		).toISOString();
		expect(
			normalizeHoneycombIncident(payload({ timestamp: stale }), {
				receivedAt: RECEIVED_AT,
			}),
		).toBeNull();

		const fresh = new Date(
			Date.parse(RECEIVED_AT) - HONEYCOMB_ALERT_MAX_AGE_MS + 1000,
		).toISOString();
		expect(
			normalizeHoneycombIncident(payload({ timestamp: fresh }), {
				receivedAt: RECEIVED_AT,
			}),
		).not.toBeNull();
	});

	test("rejects an alert timestamped too far in the future", () => {
		expect(
			normalizeHoneycombIncident(
				payload({ timestamp: "2026-10-31T00:10:00.000Z" }),
				{
					receivedAt: RECEIVED_AT,
				},
			),
		).toBeNull();
		expect(
			normalizeHoneycombIncident(
				payload({ timestamp: "2026-10-31T00:03:00.000Z" }),
				{
					receivedAt: RECEIVED_AT,
				},
			),
		).not.toBeNull();
	});

	test("rejects unknown fields and unknown states", () => {
		expect(
			normalizeHoneycombIncident(payload({ unknownField: true }), {
				receivedAt: RECEIVED_AT,
			}),
		).toBeNull();
		expect(
			normalizeHoneycombIncident(
				{ ...payload(), trigger: { ...payload().trigger, state: "panic" } },
				{ receivedAt: RECEIVED_AT },
			),
		).toBeNull();
	});

	test("drops non-https links instead of forwarding them", () => {
		const signal = normalizeHoneycombIncident(
			payload({ triggerUrl: "http://ui.honeycomb.io/insecure" }),
			{ receivedAt: RECEIVED_AT },
		);
		expect(signal?.links.map((link) => link.label)).toEqual([
			"Honeycomb alert",
		]);
	});

	test("keeps a source-stable fingerprint across deliveries", () => {
		const first = normalizeHoneycombIncident(payload(), {
			receivedAt: RECEIVED_AT,
			deliveryId: "delivery-1",
		});
		const second = normalizeHoneycombIncident(payload(), {
			receivedAt: RECEIVED_AT,
			deliveryId: "delivery-2",
		});
		expect(first?.fingerprint).toBe(second?.fingerprint);
		expect(
			honeycombIncidentFingerprint({
				dataset: "checkout",
				triggerId: "trg-1",
				state: "resolved",
			}),
		).not.toBe(first?.fingerprint);
	});

	test("bounds a long fingerprint with a digest suffix", () => {
		const fingerprint = honeycombIncidentFingerprint({
			dataset: "a".repeat(64),
			triggerId: "b".repeat(64),
			state: "triggered",
		});
		expect(fingerprint.length).toBeLessThanOrEqual(128);
		expect(fingerprint).toContain("~");
	});
});
