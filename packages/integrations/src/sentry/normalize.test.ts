import { describe, expect, test } from "bun:test";
import { incidentSignalSchema } from "@isolate/shared";
import {
	normalizeSentryIncident,
	SENTRY_ISSUE_CREATED_KIND,
	SENTRY_ISSUE_UNRESOLVED_KIND,
	sentryIncidentFingerprint,
	sentryIncidentSeverity,
} from "./normalize";

const PERMALINK = "https://sentry.io/organizations/acme/issues/467/";

function issue(overrides: Record<string, unknown> = {}) {
	return {
		id: "467",
		shortId: "CHECKOUT-1",
		title: "TypeError: cannot read id",
		culprit: "app/checkout.js in submit",
		permalink: PERMALINK,
		level: "error",
		status: "unresolved",
		firstSeen: "2026-10-30T10:00:00Z",
		lastSeen: "2026-10-31T09:00:00Z",
		count: 12,
		metadata: {
			value: "Cannot read properties of undefined (reading 'id')",
			type: "TypeError",
			filename: "app/checkout.js",
		},
		project: { id: "450", slug: "checkout", name: "Checkout" },
		...overrides,
	};
}

function payload(
	overrides: {
		action?: string;
		issue?: Record<string, unknown>;
		extra?: Record<string, unknown>;
	} = {},
) {
	return {
		action: overrides.action ?? "created",
		issue: issue(overrides.issue),
		organization: { id: "1", slug: "acme" },
		project: { id: "450", slug: "checkout", name: "Checkout" },
		...overrides.extra,
	};
}

describe("sentryIncidentSeverity", () => {
	test("maps every Sentry level per the connector spec", () => {
		expect(sentryIncidentSeverity("fatal")).toBe("critical");
		expect(sentryIncidentSeverity("error")).toBe("high");
		expect(sentryIncidentSeverity("warning")).toBe("medium");
		expect(sentryIncidentSeverity("info")).toBe("low");
		expect(sentryIncidentSeverity("debug")).toBe("info");
		expect(sentryIncidentSeverity(undefined)).toBe("high");
		expect(sentryIncidentSeverity(null)).toBe("high");
	});
});

describe("normalizeSentryIncident", () => {
	test("normalizes a created fatal issue into a contract-valid signal", () => {
		const signal = normalizeSentryIncident(
			payload({ action: "created", issue: { level: "fatal" } }),
			{ receivedAt: "2026-10-31T00:00:00.000Z", deliveryId: "delivery-1" },
		);
		expect(signal).not.toBeNull();
		expect(incidentSignalSchema.safeParse(signal).success).toBe(true);
		expect(signal).toMatchObject({
			source: "sentry",
			kind: SENTRY_ISSUE_CREATED_KIND,
			severity: "critical",
			service: "checkout",
			fingerprint: "sentry:acme:450:467",
			title: "TypeError: cannot read id",
			receivedAt: "2026-10-31T00:00:00.000Z",
		});
		expect(signal?.links).toEqual([{ label: "Sentry issue", url: PERMALINK }]);
		expect(signal?.summary).toContain("Action: created");
		expect(signal?.summary).toContain("Delivery: delivery-1");
	});

	test("treats unresolved as a regression, not a new issue", () => {
		const signal = normalizeSentryIncident(payload({ action: "unresolved" }));
		expect(signal?.kind).toBe(SENTRY_ISSUE_UNRESOLVED_KIND);
		expect(signal?.severity).toBe("high");
	});

	test("maps levels to severities", () => {
		const table = [
			["fatal", "critical"],
			["error", "high"],
			["warning", "medium"],
			["info", "low"],
			["debug", "info"],
		] as const;
		for (const [level, severity] of table) {
			const signal = normalizeSentryIncident(payload({ issue: { level } }));
			expect(signal?.severity).toBe(severity);
		}
	});

	test("ignores lifecycle actions that are not new evidence", () => {
		for (const action of ["resolved", "assigned", "archived", "unknown"]) {
			expect(normalizeSentryIncident(payload({ action }))).toBeNull();
		}
	});

	test("rejects a malformed or incomplete envelope", () => {
		for (const value of [
			null,
			undefined,
			{},
			{ action: "created" },
			{ action: "created", issue: { id: "1" } },
			{
				action: "created",
				issue: issue({ project: {} }),
				organization: { slug: "acme" },
				project: {},
			},
			{
				action: "created",
				issue: issue({ project: {} }),
				organization: {},
				project: {},
			},
		]) {
			expect(normalizeSentryIncident(value)).toBeNull();
		}
	});

	test("accepts numeric ids and a string count", () => {
		const signal = normalizeSentryIncident(
			payload({ issue: { id: 467, count: "42" } }),
		);
		expect(signal?.fingerprint).toBe("sentry:acme:450:467");
		expect(signal?.summary).toContain("Count: 42");
	});

	test("bounds the title and summary and drops invalid links", () => {
		const signal = normalizeSentryIncident(
			payload({
				issue: {
					title: `Boom ${"x".repeat(251)}`,
					culprit: "c".repeat(512),
					metadata: {
						value: "v".repeat(2000),
						type: "TypeError",
						filename: "app/checkout.js",
					},
					permalink: "http://sentry.io/organizations/acme/issues/467/",
				},
			}),
		);
		expect(signal?.title.length).toBeLessThanOrEqual(200);
		expect(signal?.summary.length).toBeLessThanOrEqual(2000);
		expect(signal?.links).toEqual([]);
	});

	test("never forwards unknown provider fields into the summary", () => {
		const signal = normalizeSentryIncident(
			payload({
				extra: {
					request: {
						headers: { Cookie: "session=super-secret" },
						data: { password: "hunter2" },
					},
					user: { email: "alice@example.com", ip_address: "10.0.0.5" },
				},
				issue: { breadcrumbs: [{ message: "session=super-secret" }] },
			}),
		);
		const serialized = JSON.stringify(signal);
		expect(serialized).not.toContain("super-secret");
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("alice@example.com");
		expect(serialized).not.toContain("10.0.0.5");
	});

	test("redacts PII that appears in allowlisted text fields", () => {
		const signal = normalizeSentryIncident(
			payload({
				issue: {
					title: "TypeError for alice@example.com from 10.0.0.5",
					culprit: "submit (session cookie=abc123)",
				},
			}),
		);
		const serialized = JSON.stringify(signal);
		expect(serialized).not.toContain("alice@example.com");
		expect(serialized).not.toContain("10.0.0.5");
		expect(serialized).not.toContain("abc123");
		expect(serialized).toContain("[email-redacted]");
		expect(serialized).toContain("[ip-redacted]");
	});

	test("falls back to metadata when the issue has no title", () => {
		const signal = normalizeSentryIncident(
			payload({ issue: { title: null, shortId: null } }),
		);
		expect(signal?.title).toBe(
			"Cannot read properties of undefined (reading 'id')",
		);
	});

	test("derives a bounded fingerprint and keeps the delivery id out of it", () => {
		const long = "a".repeat(64);
		const signal = normalizeSentryIncident(
			payload({
				issue: { id: long, project: { id: long, slug: "checkout" } },
			}),
			{ deliveryId: "delivery-1" },
		);
		expect(signal?.fingerprint.length).toBeLessThanOrEqual(128);
		expect(signal?.fingerprint.startsWith("sentry:")).toBe(true);
		expect(signal?.fingerprint).not.toContain("delivery-1");
	});

	test("fingerprint is stable for the same issue and changes per project", () => {
		const base = { orgSlug: "acme", projectId: "450", issueId: "467" };
		expect(sentryIncidentFingerprint(base)).toBe("sentry:acme:450:467");
		expect(sentryIncidentFingerprint(base)).toBe(
			sentryIncidentFingerprint(base),
		);
		expect(sentryIncidentFingerprint({ ...base, issueId: "468" })).not.toBe(
			sentryIncidentFingerprint(base),
		);
		expect(sentryIncidentFingerprint({ ...base, orgSlug: "other" })).not.toBe(
			sentryIncidentFingerprint(base),
		);
	});
});
