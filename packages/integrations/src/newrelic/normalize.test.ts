import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	isNewRelicPayloadFresh,
	NEWRELIC_ALERT_INCIDENT_KIND,
	NEWRELIC_MAX_PAYLOAD_AGE_SECONDS,
	newRelicIncidentFingerprint,
	newRelicSeverityOf,
	normalizeNewRelicIncident,
} from "./normalize";

const ACCOUNT = "1234567";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const CREATED_AT = "2026-10-30T23:55:00.000Z";
const RECEIVED_AT = "2026-10-31T00:00:00.000Z";
const GUID = "NDQ2NjA0fEFQTXxBUFBMSUNBVElPTnwxNjI";

function payload(overrides: Record<string, unknown> = {}): unknown {
	return {
		id: "issue-1",
		issueUrl: "https://one.newrelic.com/alerts-ai/issue/1",
		title: "High error rate on checkout",
		priority: "CRITICAL",
		state: "ACTIVATED",
		createdAt: CREATED_AT,
		impactedEntities: [
			{
				id: "42",
				guid: GUID,
				name: "checkout-api",
				type: "APPLICATION",
				tags: [
					{ key: "service", values: ["checkout"] },
					{ key: "environment", values: ["production"] },
					{ key: "team", values: ["alice@example.com"] },
					{ key: "host", values: ["10.0.0.5"] },
				],
			},
		],
		policyName: "Checkout SLO",
		conditionName: "Error rate > 5%",
		...overrides,
	};
}

function normalize(
	input: unknown = payload(),
	nowMs = NOW_MS,
): ReturnType<typeof normalizeNewRelicIncident> {
	return normalizeNewRelicIncident(input, {
		accountId: ACCOUNT,
		receivedAt: RECEIVED_AT,
		nowMs,
	});
}

describe("normalizeNewRelicIncident", () => {
	test("normalizes an activated issue into a bounded signal", () => {
		const signal = normalize();
		expect(signal).not.toBeNull();
		expect(signal?.source).toBe("newrelic");
		expect(signal?.kind).toBe(NEWRELIC_ALERT_INCIDENT_KIND);
		expect(signal?.severity).toBe("critical");
		expect(signal?.service).toBe("checkout");
		expect(signal?.receivedAt).toBe(RECEIVED_AT);
		expect(signal?.fingerprint.startsWith("newrelic:")).toBe(true);
		expect(signal?.summary).toContain("Policy: Checkout SLO");
		expect(signal?.summary).toContain("Error rate > 5%");
		expect(signal?.title).toBe(
			'New Relic alert "High error rate on checkout" on checkout',
		);
		expect(signal?.links.map((link) => link.label)).toEqual([
			"Issue",
			"Entity",
		]);
		expect(signal?.links.every((link) => link.url.startsWith("https://"))).toBe(
			true,
		);
	});

	test("maps every priority deterministically", () => {
		expect(newRelicSeverityOf("CRITICAL")).toBe("critical");
		expect(newRelicSeverityOf("critical")).toBe("critical");
		expect(newRelicSeverityOf("HIGH")).toBe("high");
		expect(newRelicSeverityOf("MEDIUM")).toBe("medium");
		expect(newRelicSeverityOf("LOW")).toBe("low");
		expect(newRelicSeverityOf("INFO")).toBe("info");
		expect(newRelicSeverityOf("UNKNOWN")).toBe("medium");
		expect(newRelicSeverityOf(undefined)).toBe("medium");
	});

	test("fingerprint is stable across redeliveries and issue-id churn", () => {
		const first = normalize();
		const redelivered = normalize(
			payload({
				id: "issue-2",
				title: "A different title",
				createdAt: "2026-10-30T23:59:00.000Z",
			}),
		);
		expect(redelivered?.fingerprint).toBe(first?.fingerprint);

		const otherEntity = normalize(
			payload({
				impactedEntities: [{ guid: "OTHER-ENTITY", name: "payments-api" }],
			}),
		);
		expect(otherEntity?.fingerprint).not.toBe(first?.fingerprint);

		expect(
			newRelicIncidentFingerprint({
				accountId: ACCOUNT,
				policyName: "P",
				conditionName: "C",
				entityIdentity: "E",
			}),
		).toBe(
			newRelicIncidentFingerprint({
				accountId: ACCOUNT,
				policyName: " p ",
				conditionName: "c",
				entityIdentity: "e",
			}),
		);
	});

	test("creates nothing for acknowledged, closed or stale deliveries", () => {
		expect(normalize(payload({ state: "CLOSED" }))).toBeNull();
		expect(normalize(payload({ state: "ACKNOWLEDGED" }))).toBeNull();

		const stale = "2026-10-30T23:40:00.000Z";
		expect(
			isNewRelicPayloadFresh(stale, NOW_MS, NEWRELIC_MAX_PAYLOAD_AGE_SECONDS),
		).toBe(false);
		expect(normalize(payload({ createdAt: stale }))).toBeNull();

		const future = new Date(NOW_MS + 6 * 60_000).toISOString();
		expect(normalize(payload({ createdAt: future }))).toBeNull();
	});

	test("rejects unknown fields, missing template fields and oversize text", () => {
		expect(normalize(payload({ accountId: ACCOUNT }))).toBeNull();
		expect(normalize(payload({ description: "free text" }))).toBeNull();
		expect(normalize(payload({ priority: "SEVERE" }))).toBeNull();
		expect(normalize(payload({ policyName: undefined }))).toBeNull();
		expect(normalize(payload({ title: "x".repeat(201) }))).toBeNull();
		expect(normalize(payload({ impactedEntities: [] }))).toBeNull();
		expect(normalize(payload({ createdAt: "yesterday" }))).toBeNull();
	});

	test("redacts emails, IPs and credentials from the summary", () => {
		const signal = normalize(
			payload({
				title: "Errors for alice@example.com from 10.0.0.5",
				conditionName: "key NRAK-ABCDEFGH12345678 leaked",
			}),
		);
		expect(signal).not.toBeNull();
		expect(signal?.summary).not.toContain("alice@example.com");
		expect(signal?.summary).not.toContain("10.0.0.5");
		expect(signal?.summary).not.toContain("NRAK-ABCDEFGH12345678");
		expect(signal?.summary).toContain("[email-redacted]");
		expect(signal?.summary).toContain("[ip-redacted]");
		expect(signal?.summary).toContain("[token-redacted]");
		expect(signal?.title).not.toContain("alice@example.com");
		expect(signal?.title).not.toContain("10.0.0.5");
		expect(signal?.title).toContain("[email-redacted]");
	});

	test("uses a case-insensitive service tag before the entity name", () => {
		const fromTag = normalize(
			payload({
				impactedEntities: [
					{
						guid: GUID,
						name: "entity-name",
						tags: [{ key: "SERVICE.NAME", values: ["checkout-tag"] }],
					},
				],
			}),
		);
		expect(fromTag?.service).toBe("checkout-tag");

		const fromName = normalize(
			payload({
				impactedEntities: [{ guid: GUID, name: "entity-name" }],
			}),
		);
		expect(fromName?.service).toBe("entity-name");
	});

	test("orders entities deterministically for the fingerprint", () => {
		const forward = normalize(
			payload({
				impactedEntities: [
					{ guid: "B-ENTITY", name: "beta" },
					{ guid: "A-ENTITY", name: "alpha" },
				],
			}),
		);
		const reverse = normalize(
			payload({
				impactedEntities: [
					{ guid: "A-ENTITY", name: "alpha" },
					{ guid: "B-ENTITY", name: "beta" },
				],
			}),
		);
		expect(forward?.fingerprint).toBe(reverse?.fingerprint);
		expect(forward?.service).toBe("alpha");
	});

	test("requires a configured account id", () => {
		expect(() =>
			normalizeNewRelicIncident(payload(), {
				accountId: "not-an-account",
				nowMs: NOW_MS,
			}),
		).toThrow(PlatformError);
	});
});
