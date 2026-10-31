import { describe, expect, test } from "bun:test";
import {
	DATADOG_WEBHOOK_MAX_BODY_BYTES,
	type DatadogWebhookVerification,
	verifyDatadogDelivery,
	verifyDatadogWebhook,
} from "./webhook";

const BODY = JSON.stringify({
	id: "1234567890",
	title: "High error rate",
	priority: "P1",
	org: "acme",
});

function verify(
	overrides: Partial<Parameters<typeof verifyDatadogWebhook>[0]> = {},
): DatadogWebhookVerification {
	return verifyDatadogWebhook({ rawBody: BODY, ...overrides });
}

describe("verifyDatadogWebhook", () => {
	test("returns an explicit unsigned result, never valid", () => {
		expect(verify()).toEqual({
			ok: true,
			status: "unsigned",
			bridgeVerified: false,
			reason: "no_signature",
		});
		expect(JSON.stringify(verify())).not.toContain("valid");
	});

	test("reports bridge_verified only when the bridge flag is true", () => {
		expect(verify({ bridgeVerified: true })).toEqual({
			ok: true,
			status: "bridge_verified",
			bridgeVerified: true,
			reason: "bridge_verified",
		});
		expect(JSON.stringify(verify({ bridgeVerified: true }))).not.toContain(
			"valid",
		);
		// Any non-boolean truthy value is not an approval.
		expect(verify({ bridgeVerified: "yes" as unknown as boolean })).toEqual({
			ok: true,
			status: "unsigned",
			bridgeVerified: false,
			reason: "no_signature",
		});
	});

	test("accepts raw bytes and enforces the 64 KiB cap", () => {
		const raw = verify({ rawBody: new TextEncoder().encode(BODY) });
		expect(raw.ok).toBe(true);
		if (raw.ok) expect(raw.status).toBe("unsigned");
		const oversized = "x".repeat(DATADOG_WEBHOOK_MAX_BODY_BYTES + 1);
		expect(verify({ rawBody: oversized })).toEqual({
			ok: false,
			reason: "body_too_large",
		});
		expect(verify({ rawBody: oversized, bridgeVerified: true })).toEqual({
			ok: false,
			reason: "body_too_large",
		});
	});

	test("honors a reduced cap for a caller-specific receiver", () => {
		expect(verify({ rawBody: "abcd", maxBodyBytes: 3 })).toEqual({
			ok: false,
			reason: "body_too_large",
		});
	});

	test("the document-name alias behaves identically", () => {
		expect(verifyDatadogDelivery({ rawBody: BODY })).toEqual(verify());
	});

	test("verification results never echo the body", () => {
		for (const result of [
			verify(),
			verify({ bridgeVerified: true }),
			verify({ rawBody: "x".repeat(DATADOG_WEBHOOK_MAX_BODY_BYTES + 1) }),
		]) {
			const serialized = JSON.stringify(result);
			expect(serialized).not.toContain("1234567890");
			expect(serialized).not.toContain("High error rate");
			expect(serialized).not.toContain("acme");
		}
	});
});
