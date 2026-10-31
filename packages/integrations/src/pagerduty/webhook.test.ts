import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	isPagerDutyEventFresh,
	PAGERDUTY_REPLAY_WINDOW_MS,
	PAGERDUTY_SIGNATURE_HEADER,
	PAGERDUTY_WEBHOOK_MAX_BODY_BYTES,
	verifyPagerDutyWebhook,
} from "./webhook";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);
const BODY = JSON.stringify({
	event: { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", event_type: "incident.triggered" },
});

function sign(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function v1(secret: string, body = BODY): string {
	return `v1=${sign(secret, body)}`;
}

function headers(signature?: string): Headers {
	const result = new Headers();
	if (signature !== undefined)
		result.set(PAGERDUTY_SIGNATURE_HEADER, signature);
	return result;
}

describe("verifyPagerDutyWebhook", () => {
	test("accepts a valid v1 signature over the raw body", () => {
		const result = verifyPagerDutyWebhook({
			rawBody: BODY,
			headers: headers(v1(SECRET_A)),
			secret: SECRET_A,
		});
		expect(result).toEqual({ ok: true });
	});

	test("accepts either active signature during rotation (space or comma separated)", () => {
		for (const separator of [" ", ",", ", "]) {
			const result = verifyPagerDutyWebhook({
				rawBody: BODY,
				headers: headers(`${v1(SECRET_A)}${separator}${v1(SECRET_B)}`),
				secret: SECRET_B,
			});
			expect(result).toEqual({ ok: true });
		}
	});

	test("rejects a tampered body as invalid_signature", () => {
		const result = verifyPagerDutyWebhook({
			rawBody: `${BODY} `,
			headers: headers(v1(SECRET_A)),
			secret: SECRET_A,
		});
		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects a missing header", () => {
		expect(
			verifyPagerDutyWebhook({
				rawBody: BODY,
				headers: headers(),
				secret: SECRET_A,
			}),
		).toEqual({ ok: false, reason: "missing_headers" });
	});

	test("rejects malformed and non-v1 signatures", () => {
		for (const signature of [
			"v1=abc",
			`v2=${sign(SECRET_A, BODY)}`,
			`v1=${sign(SECRET_A, BODY)} v2=${sign(SECRET_A, BODY)}`,
			"   ",
		]) {
			const result = verifyPagerDutyWebhook({
				rawBody: BODY,
				headers: headers(signature),
				secret: SECRET_A,
			});
			expect(result.ok).toBe(false);
		}
	});

	test("rejects an oversize body before comparing digests", () => {
		const result = verifyPagerDutyWebhook({
			rawBody: "x".repeat(PAGERDUTY_WEBHOOK_MAX_BODY_BYTES + 1),
			headers: headers(v1(SECRET_A)),
			secret: SECRET_A,
		});
		expect(result).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("treats a short or absent secret as not configured", () => {
		for (const secret of [undefined, null, "short", "s".repeat(31)]) {
			expect(
				verifyPagerDutyWebhook({
					rawBody: BODY,
					headers: headers(v1(SECRET_A)),
					secret,
				}),
			).toEqual({ ok: false, reason: "not_configured" });
		}
	});

	test("no failure path echoes the body or signature", () => {
		const result = verifyPagerDutyWebhook({
			rawBody: BODY,
			headers: headers(`v1=${"0".repeat(64)}`),
			secret: SECRET_A,
		});
		expect(JSON.stringify(result)).not.toContain(BODY);
		expect(JSON.stringify(result)).not.toContain("0".repeat(64));
	});

	test("freshness is a trusted-clock ±300 s check (unsigned timestamp)", () => {
		const now = Date.parse("2026-10-31T00:00:00.000Z");
		expect(isPagerDutyEventFresh("2026-10-31T00:00:00.000Z", now)).toBe(true);
		expect(
			isPagerDutyEventFresh(
				"2026-10-31T00:00:00.000Z",
				now + PAGERDUTY_REPLAY_WINDOW_MS,
			),
		).toBe(true);
		expect(
			isPagerDutyEventFresh(
				"2026-10-31T00:00:00.000Z",
				now + PAGERDUTY_REPLAY_WINDOW_MS + 1,
			),
		).toBe(false);
		expect(isPagerDutyEventFresh("not-a-date", now)).toBe(false);
	});
});
