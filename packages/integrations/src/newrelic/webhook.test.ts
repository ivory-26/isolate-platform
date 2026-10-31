import { describe, expect, test } from "bun:test";
import { NEWRELIC_WEBHOOK_MAX_BODY_BYTES } from "./schemas";
import {
	parseNewRelicVerifiedPayload,
	readNewRelicHeader,
	verifyNewRelicWebhook,
} from "./webhook";

const NOW = "2026-10-31T00:00:00.000Z";
const BODY = JSON.stringify({
	id: "issue-1",
	issueUrl: "https://one.newrelic.com/alerts-ai/issue/1",
	title: "High error rate",
	priority: "CRITICAL",
	state: "ACTIVATED",
	createdAt: NOW,
	impactedEntities: [{ guid: "ENTITY-1", name: "checkout-api" }],
	policyName: "Checkout",
	conditionName: "Error rate",
});
const CUSTOM_HEADER = "x-isolate-bridge";
const CUSTOM_SECRET = "shared-secret-value-0123456789";

describe("verifyNewRelicWebhook", () => {
	test("returns an explicit unsigned result: the vendor signs nothing", () => {
		const result = verifyNewRelicWebhook({
			rawBody: BODY,
			headers: { [CUSTOM_HEADER]: CUSTOM_SECRET },
			customHeader: CUSTOM_HEADER,
		});
		expect(result).toEqual({
			ok: true,
			vendorSignature: "none",
			status: "unsigned",
			bridgeVerified: false,
			customHeaderPresent: true,
		});
		expect(JSON.stringify(result)).not.toContain("bridge_verified");
	});

	test("a custom header is presence only, never a signature", () => {
		const missing = verifyNewRelicWebhook({
			rawBody: BODY,
			headers: {},
			customHeader: CUSTOM_HEADER,
		});
		if (!missing.ok || missing.status !== "unsigned") {
			throw new Error("expected unsigned");
		}
		expect(missing.customHeaderPresent).toBe(false);

		const wrong = verifyNewRelicWebhook({
			rawBody: BODY,
			headers: { [CUSTOM_HEADER]: "wrong" },
			customHeader: CUSTOM_HEADER,
		});
		if (!wrong.ok || wrong.status !== "unsigned") {
			throw new Error("expected unsigned");
		}
		expect(wrong.customHeaderPresent).toBe(true);
	});

	test("accepts a bridge attestation as the only verified path", () => {
		expect(
			verifyNewRelicWebhook({ rawBody: BODY, bridgeVerified: true }),
		).toEqual({
			ok: true,
			vendorSignature: "none",
			status: "bridge_verified",
			bridgeVerified: true,
		});
	});

	test("a malformed configured header name is not evidence", () => {
		const result = verifyNewRelicWebhook({
			rawBody: BODY,
			headers: { "bad header": CUSTOM_SECRET },
			customHeader: "bad header",
		});
		if (!result.ok || result.status !== "unsigned") {
			throw new Error("expected unsigned");
		}
		expect(result.customHeaderPresent).toBe(false);
	});

	test("caps the body at 64 KiB before doing anything else", () => {
		const exact = "x".repeat(NEWRELIC_WEBHOOK_MAX_BODY_BYTES);
		expect(
			verifyNewRelicWebhook({ rawBody: exact, bridgeVerified: true }).ok,
		).toBe(true);

		const oversized = `${exact}x`;
		expect(
			verifyNewRelicWebhook({ rawBody: oversized, bridgeVerified: true }),
		).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("accepts raw bytes and never echoes the body or secret", () => {
		const result = verifyNewRelicWebhook({
			rawBody: new TextEncoder().encode(BODY),
			headers: { [CUSTOM_HEADER]: CUSTOM_SECRET },
			customHeader: CUSTOM_HEADER,
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("High error rate");
		expect(serialized).not.toContain(CUSTOM_SECRET);
		expect(serialized).not.toContain("issue-1");
	});

	test("reads headers case-insensitively from records and Headers", () => {
		expect(readNewRelicHeader({ "X-Custom": "value" }, "x-custom")).toBe(
			"value",
		);
		expect(
			readNewRelicHeader(new Headers({ "x-custom": "value" }), "X-Custom"),
		).toBe("value");
		expect(readNewRelicHeader(undefined, "x-custom")).toBeNull();
	});
});

describe("parseNewRelicVerifiedPayload", () => {
	test("parses only the pinned strict template", () => {
		const payload = parseNewRelicVerifiedPayload(BODY);
		expect(payload?.id).toBe("issue-1");
		expect(payload?.priority).toBe("CRITICAL");

		const withUnknown = JSON.stringify({
			...(JSON.parse(BODY) as Record<string, unknown>),
			accountId: 1234567,
		});
		expect(parseNewRelicVerifiedPayload(withUnknown)).toBeNull();
		expect(parseNewRelicVerifiedPayload(`${BODY}{}`)).toBeNull();
		expect(parseNewRelicVerifiedPayload("")).toBeNull();
		expect(parseNewRelicVerifiedPayload("{not json")).toBeNull();
		expect(
			parseNewRelicVerifiedPayload(new Uint8Array([0xff, 0xfe])),
		).toBeNull();
	});

	test("rejects a body above the cap", () => {
		const oversized = `{"id":"${"x".repeat(NEWRELIC_WEBHOOK_MAX_BODY_BYTES)}"}`;
		expect(parseNewRelicVerifiedPayload(oversized)).toBeNull();
	});
});
