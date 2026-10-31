import { describe, expect, test } from "bun:test";
import { type IncidentSeverity, incidentSignalSchema } from "@isolate/shared";
import {
	datadogIncidentFingerprint,
	datadogServiceFromTags,
	datadogSeverityOf,
	normalizeDatadogIncident,
} from "./normalize";

const SITE = "https://app.datadoghq.com";

function payload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "1234567890",
		title: "High error rate on checkout",
		priority: "P1",
		alert_type: "error",
		alert_transition: "Triggered",
		date_happened: 1761955200,
		tags: "service:checkout,env:prod,host:web-1",
		url: "https://app.datadoghq.com/event/event?id=1",
		dashboard_url: "https://app.datadoghq.com/dashboard/abc-def?from=now",
		org: "acme",
		...overrides,
	};
}

describe("datadogSeverityOf", () => {
	test("maps priority P1..P5 and absent/unknown to the shared bands", () => {
		const table: Array<[string | null | undefined, IncidentSeverity]> = [
			["P1", "critical"],
			["p1", "critical"],
			["P2", "high"],
			["P3", "medium"],
			["P4", "low"],
			["P5", "low"],
			[null, "medium"],
			[undefined, "medium"],
			["P6", "medium"],
			["", "medium"],
		];
		for (const [input, expected] of table) {
			expect(datadogSeverityOf(input)).toBe(expected);
		}
	});
});

describe("datadogServiceFromTags", () => {
	test("uses the service tag and falls back safely", () => {
		expect(datadogServiceFromTags(["env:prod", "service:checkout"])).toBe(
			"checkout",
		);
		expect(datadogServiceFromTags(["SERVICE:API", "env:prod"])).toBe("API");
		expect(datadogServiceFromTags(["service:bad service"])).toBe("bad_service");
		expect(datadogServiceFromTags(["env:prod"])).toBe("datadog");
		expect(datadogServiceFromTags([])).toBe("datadog");
	});
});

describe("datadogIncidentFingerprint", () => {
	test("is stable across tag order and delivery id", () => {
		const first = datadogIncidentFingerprint({
			monitorId: "1234567890",
			tags: ["service:checkout", "env:prod", "host:web-1"],
		});
		const second = datadogIncidentFingerprint({
			monitorId: "1234567890",
			tags: ["host:web-1", "env:prod", "service:checkout"],
		});
		const redelivered = normalizeDatadogIncident(payload(), {
			site: SITE,
			receivedAt: "2026-10-31T00:00:00.000Z",
		});
		expect(second).toBe(first);
		expect(redelivered?.fingerprint).toBe(first);
	});

	test("changes with the monitor id or the group tags", () => {
		const base = datadogIncidentFingerprint({
			monitorId: "123",
			tags: ["service:checkout", "host:web-1"],
		});
		expect(
			datadogIncidentFingerprint({
				monitorId: "124",
				tags: ["service:checkout", "host:web-1"],
			}),
		).not.toBe(base);
		expect(
			datadogIncidentFingerprint({
				monitorId: "123",
				tags: ["service:checkout", "host:web-2"],
			}),
		).not.toBe(base);
		expect(base.length).toBeLessThanOrEqual(128);
	});
});

describe("normalizeDatadogIncident", () => {
	test("produces a contract-valid signal with P1 as critical", () => {
		const signal = normalizeDatadogIncident(payload(), {
			site: SITE,
			receivedAt: "2026-10-31T00:00:00.000Z",
		});
		expect(signal).not.toBeNull();
		expect(incidentSignalSchema.safeParse(signal).success).toBe(true);
		expect(signal?.source).toBe("datadog");
		expect(signal?.severity).toBe("critical");
		expect(signal?.service).toBe("checkout");
		expect(signal?.title.length).toBeLessThanOrEqual(200);
		expect(signal?.title).toContain("checkout");
		expect(signal?.summary.length).toBeLessThanOrEqual(2000);
		expect(signal?.summary).toContain("Priority: P1 -> critical");
		expect(signal?.summary).toContain("Service: checkout");
		expect(signal?.summary).toContain("Monitor/incident id: 1234567890");
		expect(signal?.receivedAt).toBe("2026-10-31T00:00:00.000Z");
	});

	test("maps every priority through normalization", () => {
		const table: Array<[string, IncidentSeverity]> = [
			["P1", "critical"],
			["P2", "high"],
			["P3", "medium"],
			["P4", "low"],
			["P5", "low"],
		];
		for (const [priority, severity] of table) {
			const signal = normalizeDatadogIncident(payload({ priority }));
			expect(signal?.severity).toBe(severity);
		}
		expect(
			normalizeDatadogIncident(payload({ priority: undefined }))?.severity,
		).toBe("medium");
	});

	test("links to the monitor and the dashboard without query strings", () => {
		const signal = normalizeDatadogIncident(payload(), { site: `${SITE}/` });
		expect(signal?.links).toEqual([
			{
				label: "Monitor",
				url: "https://app.datadoghq.com/monitors/1234567890",
			},
			{
				label: "Dashboard",
				url: "https://app.datadoghq.com/dashboard/abc-def",
			},
			{
				label: "Event",
				url: "https://app.datadoghq.com/event/event",
			},
		]);
	});

	test("drops an http or credential-bearing link", () => {
		const signal = normalizeDatadogIncident(
			payload({
				dashboard_url: "http://app.datadoghq.com/dashboard/abc",
				url: "https://user:pass@app.datadoghq.com/event/1",
			}),
			{ site: "http://app.datadoghq.com" },
		);
		expect(signal?.links).toEqual([]);
	});

	test("uses monitor_id and accepts a raw event without org", () => {
		const withMonitor = normalizeDatadogIncident(payload({ monitor_id: "42" }));
		expect(withMonitor?.fingerprint).toBe(
			datadogIncidentFingerprint({
				monitorId: "42",
				tags: ["service:checkout", "env:prod", "host:web-1"],
			}),
		);

		const raw: Record<string, unknown> = payload({
			org: undefined,
			text: "raw event text",
			unknown: { nested: true },
		});
		delete raw.org;
		delete raw.url;
		delete raw.dashboard_url;
		const signal = normalizeDatadogIncident(raw);
		expect(signal).not.toBeNull();
		expect(signal?.summary).not.toContain("raw event text");
	});

	test("a Recovered transition creates nothing", () => {
		expect(
			normalizeDatadogIncident(payload({ alert_transition: "Recovered" })),
		).toBeNull();
		expect(
			normalizeDatadogIncident(payload({ alert_transition: "recovered" })),
		).toBeNull();
	});

	test("rejects an unknown template field, a missing title and an oversize one", () => {
		expect(normalizeDatadogIncident(payload({ body: "raw text" }))).toBeNull();
		expect(normalizeDatadogIncident(payload({ title: undefined }))).toBeNull();
		expect(
			normalizeDatadogIncident(payload({ title: "x".repeat(2001) })),
		).toBeNull();
	});

	test("bounds a long title and summary before validation", () => {
		const long = `${"error ".repeat(280)}end`;
		const signal = normalizeDatadogIncident(payload({ title: long }));
		expect(signal).not.toBeNull();
		expect(signal?.title.length).toBeLessThanOrEqual(200);
		expect(signal?.summary.length).toBeLessThanOrEqual(2000);
	});

	test("redacts credentials and PII from tags and title", () => {
		const signal = normalizeDatadogIncident(
			payload({
				title: "failure for alice@example.com from 10.1.2.3",
				tags: "service:checkout,owner:alice@example.com",
			}),
		);
		expect(signal?.title).not.toContain("alice@example.com");
		expect(signal?.summary).not.toContain("10.1.2.3");
		expect(signal?.summary).toContain("[email-redacted]");
	});
});
