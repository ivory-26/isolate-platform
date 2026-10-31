import { describe, expect, test } from "bun:test";
import {
	type IncidentSeverity,
	incidentSignalSchema,
	MAX_INCIDENT_SUMMARY_CHARS,
	MAX_INCIDENT_TITLE_CHARS,
} from "@isolate/shared";
import {
	classifyPagerDutyEvent,
	normalizePagerDutyIncident,
	pagerDutyIncidentFingerprint,
	pagerDutySeverity,
} from "./normalize";

const RECEIVED_AT = "2026-10-31T00:00:00.000Z";
const INCIDENT_URL = "https://acme.pagerduty.com/incidents/PABC123";
const SERVICE_URL = "https://acme.pagerduty.com/services/PSVC1";

type Overrides = {
	eventType?: string;
	status?: string;
	urgency?: string | null;
	priorityName?: string | null;
	title?: string;
	serviceName?: string;
	incidentUrl?: string | null;
};

function envelope(overrides: Overrides = {}): Record<string, unknown> {
	const eventType = overrides.eventType ?? "incident.triggered";
	const data: Record<string, unknown> = {
		id: "PABC123",
		number: 42,
		status: overrides.status ?? "triggered",
		title: overrides.title ?? "Checkout latency above SLO",
		service: {
			id: "PSVC1",
			name: overrides.serviceName ?? "checkout",
			html_url: SERVICE_URL,
			// Responder-ish fields a real payload carries; never read.
			integrations: [{ id: "PINT1", label: "Datadog" }],
		},
		html_url: overrides.incidentUrl ?? INCIDENT_URL,
		created_at: "2026-10-30T23:59:00Z",
		assignments: [
			{ assignee: { id: "PUSER1", summary: "Jane Doe jane@acme.com" } },
		],
	};
	if (overrides.urgency !== null) {
		data.urgency = overrides.urgency ?? "high";
	}
	if (overrides.priorityName !== null) {
		data.priority = {
			id: "PPRIO1",
			name: overrides.priorityName ?? "P1",
		};
	}
	return {
		event: {
			id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
			event_type: eventType,
			resource_type: "incident",
			occurred_at: "2026-10-30T23:59:30.000Z",
			agent: { id: "PAGENT1", type: "user" },
			data,
		},
	};
}

describe("pagerDutySeverity", () => {
	test("maps the documented urgency/priority table", () => {
		const cases: Array<[string | null, string | null, IncidentSeverity]> = [
			["high", null, "critical"],
			[null, "P1", "critical"],
			[null, "P2", "high"],
			[null, "P3", "medium"],
			["low", null, "medium"],
			[null, "P4", "low"],
			[null, "P5", "low"],
			[null, null, "medium"],
		];
		for (const [urgency, priorityName, expected] of cases) {
			expect(pagerDutySeverity({ urgency, priorityName })).toBe(expected);
		}
	});
});

describe("pagerDutyIncidentFingerprint", () => {
	test("is source-stable and bounded", () => {
		expect(
			pagerDutyIncidentFingerprint({
				serviceId: "PSVC1",
				incidentId: "PABC123",
			}),
		).toBe("pagerduty:PSVC1:PABC123");
		const long = pagerDutyIncidentFingerprint({
			serviceId: "S".repeat(64),
			incidentId: "I".repeat(64),
		});
		expect(long.length).toBeLessThanOrEqual(128);
		expect(long).toContain("~");
	});
});

describe("classifyPagerDutyEvent", () => {
	test("triggered creates, lifecycle events update, service.updated ignores", () => {
		expect(classifyPagerDutyEvent(envelope()).kind).toBe("create");
		for (const eventType of [
			"incident.acknowledged",
			"incident.resolved",
			"incident.escalated",
			"incident.reassigned",
			"incident.priority_updated",
		]) {
			expect(
				classifyPagerDutyEvent(envelope({ eventType, status: "acknowledged" }))
					.kind,
			).toBe("update");
		}
		expect(
			classifyPagerDutyEvent(envelope({ eventType: "service.updated" })).kind,
		).toBe("ignore");
		expect(classifyPagerDutyEvent({ nope: true }).kind).toBe("invalid");
	});
});

describe("normalizePagerDutyIncident", () => {
	test("creates one contract-valid signal for incident.triggered", () => {
		const signal = normalizePagerDutyIncident(envelope(), RECEIVED_AT);
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(incidentSignalSchema.safeParse(signal).success).toBe(true);
		expect(signal.source).toBe("pagerduty");
		expect(signal.kind).toBe("incident");
		expect(signal.severity).toBe("critical");
		expect(signal.service).toBe("checkout");
		expect(signal.fingerprint).toBe("pagerduty:PSVC1:PABC123");
		expect(signal.title.length).toBeLessThanOrEqual(MAX_INCIDENT_TITLE_CHARS);
		expect(signal.title).toContain("Checkout latency");
		expect(signal.summary.length).toBeLessThanOrEqual(
			MAX_INCIDENT_SUMMARY_CHARS,
		);
		expect(signal.summary).toContain("Event: incident.triggered");
		expect(signal.summary).toContain("01HZZZZZZZZZZZZZZZZZZZZZZZ");
		expect(signal.summary).toContain("Dedupe: pagerduty:PSVC1:PABC123");
		expect(signal.links.map((link) => link.url)).toEqual([
			INCIDENT_URL,
			SERVICE_URL,
		]);
		expect(signal.receivedAt).toBe(RECEIVED_AT);
		expect(JSON.stringify(signal)).not.toContain("jane@acme.com");
		expect(JSON.stringify(signal)).not.toContain("PUSER1");
	});

	test("acknowledged/resolved never create a second signal", () => {
		for (const status of ["acknowledged", "resolved"]) {
			const eventType =
				status === "resolved" ? "incident.resolved" : "incident.acknowledged";
			expect(
				normalizePagerDutyIncident(
					envelope({ eventType, status }),
					RECEIVED_AT,
				),
			).toBeNull();
		}
	});

	test("redacts emails and phone numbers in free-text titles", () => {
		const signal = normalizePagerDutyIncident(
			envelope({
				title: "DB down for jane@acme.com, call +1 415-555-0100",
			}),
			RECEIVED_AT,
		);
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(signal.title).not.toContain("jane@acme.com");
		expect(signal.title).not.toContain("415-555-0100");
		expect(signal.title).toContain("[email-redacted]");
		expect(signal.title).toContain("[phone-redacted]");
	});

	test("caps long provider titles and service names", () => {
		const signal = normalizePagerDutyIncident(
			envelope({
				title: `t${"x".repeat(500)}`,
				serviceName: `s${"y".repeat(199)}`,
			}),
			RECEIVED_AT,
		);
		expect(signal).not.toBeNull();
		if (signal === null) return;
		expect(signal.title.length).toBeLessThanOrEqual(MAX_INCIDENT_TITLE_CHARS);
		expect(signal.service.length).toBeLessThanOrEqual(128);
		expect(signal.title.endsWith("…")).toBe(true);
	});

	test("drops invalid provider URLs and malformed envelopes", () => {
		const signal = normalizePagerDutyIncident(
			envelope({ incidentUrl: "http://insecure.example/incident" }),
			RECEIVED_AT,
		);
		expect(signal?.links.map((link) => link.url)).toEqual([SERVICE_URL]);
		expect(
			normalizePagerDutyIncident(
				envelope({ eventType: "incident.exploded" }),
				RECEIVED_AT,
			),
		).toBeNull();
		expect(
			normalizePagerDutyIncident("not-an-envelope", RECEIVED_AT),
		).toBeNull();
		expect(
			normalizePagerDutyIncident(
				envelope({ title: "x".repeat(600) }),
				RECEIVED_AT,
			),
		).toBeNull();
	});

	test("defaults receivedAt to a bounded ISO timestamp", () => {
		const signal = normalizePagerDutyIncident(envelope());
		expect(signal).not.toBeNull();
		expect(signal?.receivedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
	});
});
