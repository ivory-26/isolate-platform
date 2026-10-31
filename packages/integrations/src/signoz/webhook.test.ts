import { describe, expect, test } from "bun:test";
import {
	SIGNOZ_WEBHOOK_MAX_BODY_BYTES,
	SIGNOZ_WEBHOOK_TOKEN_HEADER,
	signozDedupeKey,
	verifySignozDelivery,
	verifySignozWebhook,
} from "./webhook";

const USER = "isolate";
const PASSWORD = "w17-signoz-basic-password";
const TOKEN = "w17-signoz-shared-token-0123456789";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const STARTED_AT = new Date(NOW_MS - 60_000).toISOString();

function basicHeader(): string {
	return `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
}

function payload(
	overrides: { startsAt?: string; status?: string } = {},
): string {
	return JSON.stringify({
		alerts: [
			{
				status: overrides.status ?? "firing",
				labels: {
					alertname: "HighErrorRate",
					"service.name": "api",
					severity: "critical",
				},
				annotations: { summary: "Error rate above 5%" },
				startsAt: overrides.startsAt ?? STARTED_AT,
				endsAt: new Date(NOW_MS + 3_600_000).toISOString(),
				generatorURL: "https://signoz.example.com/alerts/rules/rule-1",
				fingerprint: "alert-fingerprint-1",
			},
		],
		status: overrides.status ?? "firing",
		fingerprint: "delivery-fingerprint-1",
		version: "4",
		receiver: "isolate",
	});
}

describe("verifySignozWebhook", () => {
	test("accepts the configured Basic credential", () => {
		const result = verifySignozWebhook({
			rawBody: payload(),
			headers: { Authorization: basicHeader() },
			credentials: { basicUser: USER, basicPassword: PASSWORD },
		});
		expect(result).toEqual({ ok: true, authenticated: "basic" });
	});

	test("rejects a wrong user or password in constant-time comparison", () => {
		const wrongPassword = `Basic ${Buffer.from(`${USER}:not-the-password`).toString("base64")}`;
		const wrongUser = `Basic ${Buffer.from(`other:${PASSWORD}`).toString("base64")}`;
		for (const header of [wrongPassword, wrongUser]) {
			expect(
				verifySignozWebhook({
					rawBody: payload(),
					headers: { authorization: header },
					credentials: { basicUser: USER, basicPassword: PASSWORD },
				}),
			).toEqual({ ok: false, reason: "invalid_credentials" });
		}
	});

	test("rejects a missing, malformed or non-Basic Authorization header", () => {
		const credentials = { basicUser: USER, basicPassword: PASSWORD };
		expect(
			verifySignozWebhook({ rawBody: payload(), headers: {}, credentials }),
		).toEqual({ ok: false, reason: "missing_headers" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { Authorization: "Basic !!!not-base64!!!" },
				credentials,
			}),
		).toEqual({ ok: false, reason: "malformed_headers" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: {
					Authorization: `Basic ${Buffer.from("no-colon").toString("base64")}`,
				},
				credentials,
			}),
		).toEqual({ ok: false, reason: "malformed_headers" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { Authorization: "Bearer some-token" },
				credentials,
			}),
		).toEqual({ ok: false, reason: "malformed_headers" });
	});

	test("a short or empty credential fails closed as not_configured", () => {
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { Authorization: basicHeader() },
				credentials: { basicUser: USER, basicPassword: "short" },
			}),
		).toEqual({ ok: false, reason: "not_configured" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: {},
				credentials: {},
			}),
		).toEqual({ ok: false, reason: "not_configured" });
	});

	test("accepts a configured shared token header", () => {
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { [SIGNOZ_WEBHOOK_TOKEN_HEADER]: TOKEN },
				credentials: { token: TOKEN },
			}),
		).toEqual({ ok: true, authenticated: "token" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { "x-custom-token": TOKEN },
				credentials: { token: TOKEN, tokenHeader: "X-Custom-Token" },
			}),
		).toEqual({ ok: true, authenticated: "token" });
	});

	test("rejects a wrong token, a missing token header and an unconfigured scheme", () => {
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { [SIGNOZ_WEBHOOK_TOKEN_HEADER]: "wrong-token-value" },
				credentials: { token: TOKEN },
			}),
		).toEqual({ ok: false, reason: "invalid_credentials" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: {},
				credentials: { token: TOKEN },
			}),
		).toEqual({ ok: false, reason: "missing_headers" });
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { [SIGNOZ_WEBHOOK_TOKEN_HEADER]: TOKEN },
				credentials: { basicUser: USER, basicPassword: PASSWORD },
			}),
		).toEqual({ ok: false, reason: "invalid_credentials" });
	});

	test("rejects a malformed token header name", () => {
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: {},
				credentials: { token: TOKEN, tokenHeader: "bad header name" },
			}),
		).toEqual({ ok: false, reason: "malformed_headers" });
	});

	test("refuses an oversize body before any parsing", () => {
		expect(
			verifySignozWebhook({
				rawBody: payload(),
				headers: { Authorization: basicHeader() },
				credentials: { basicUser: USER, basicPassword: PASSWORD },
				maxBodyBytes: 16,
			}),
		).toEqual({ ok: false, reason: "body_too_large" });
		expect(SIGNOZ_WEBHOOK_MAX_BODY_BYTES).toBe(64 * 1024);
	});
});

describe("verifySignozDelivery", () => {
	const credentials = { basicUser: USER, basicPassword: PASSWORD };

	test("returns the strictly parsed payload for a fresh firing alert", () => {
		const result = verifySignozDelivery({
			rawBody: payload(),
			headers: { Authorization: basicHeader() },
			credentials,
			nowMs: NOW_MS,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.authenticated).toBe("basic");
		expect(result.payload.alerts[0]?.labels["service.name"]).toBe("api");
	});

	test("rejects a delivery older than 15 minutes", () => {
		const result = verifySignozDelivery({
			rawBody: payload({
				startsAt: new Date(NOW_MS - 16 * 60_000).toISOString(),
			}),
			headers: { Authorization: basicHeader() },
			credentials,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ ok: false, reason: "stale_alert" });
	});

	test("accepts an alert just inside the replay window", () => {
		const result = verifySignozDelivery({
			rawBody: payload({
				startsAt: new Date(NOW_MS - 14 * 60_000).toISOString(),
			}),
			headers: { Authorization: basicHeader() },
			credentials,
			nowMs: NOW_MS,
		});
		expect(result.ok).toBe(true);
	});

	test("rejects a resolved-only delivery", () => {
		const body = JSON.stringify({
			alerts: [
				{
					status: "resolved",
					labels: { alertname: "HighErrorRate" },
					startsAt: STARTED_AT,
				},
			],
			status: "resolved",
		});
		expect(
			verifySignozDelivery({
				rawBody: body,
				headers: { Authorization: basicHeader() },
				credentials,
				nowMs: NOW_MS,
			}),
		).toEqual({ ok: false, reason: "no_firing_alert" });
	});

	test("rejects unknown payload fields, missing startsAt and future startsAt", () => {
		const unknownField = JSON.stringify({
			alerts: [
				{
					status: "firing",
					labels: { alertname: "HighErrorRate" },
					startsAt: STARTED_AT,
					unexpected: true,
				},
			],
		});
		const missingStart = JSON.stringify({
			alerts: [{ status: "firing", labels: { alertname: "HighErrorRate" } }],
		});
		const futureStart = payload({
			startsAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
		});
		for (const body of [unknownField, missingStart, futureStart]) {
			expect(
				verifySignozDelivery({
					rawBody: body,
					headers: { Authorization: basicHeader() },
					credentials,
					nowMs: NOW_MS,
				}),
			).toEqual({ ok: false, reason: "malformed_payload" });
		}
	});

	test("fails with the auth reason before parsing the payload", () => {
		expect(
			verifySignozDelivery({
				rawBody: "not json",
				headers: {},
				credentials,
				nowMs: NOW_MS,
			}),
		).toEqual({ ok: false, reason: "missing_headers" });
	});
});

describe("signozDedupeKey", () => {
	test("is signoz:<rule-id>:<fingerprint>:<state>", () => {
		expect(
			signozDedupeKey({
				ruleId: "rule-1",
				alertFingerprint: "abc123",
				state: "firing",
			}),
		).toBe("signoz:rule-1:abc123:firing");
	});
});
