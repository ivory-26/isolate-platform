import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	SENTRY_RESOURCE_HEADER,
	SENTRY_SIGNATURE_HEADER,
	SENTRY_TIMESTAMP_HEADER,
	SENTRY_WEBHOOK_MAX_BODY_BYTES,
	verifySentryWebhook,
} from "./webhook";

const SECRET = "w16-sentry-webhook-secret-0123456789abcdef";
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({
	action: "created",
	issue: { id: "467", level: "error" },
});

function sign(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function headers(
	timestamp: number = NOW_SECONDS,
	overrides: Record<string, string | null> = {},
): Record<string, string | null> {
	return {
		[SENTRY_SIGNATURE_HEADER]: sign(BODY, SECRET),
		[SENTRY_TIMESTAMP_HEADER]: String(timestamp),
		[SENTRY_RESOURCE_HEADER]: "issue",
		...overrides,
	};
}

describe("verifySentryWebhook", () => {
	test("accepts a correctly signed delivery and returns the resource", () => {
		const result = verifySentryWebhook({
			rawBody: BODY,
			headers: headers(),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({
			ok: true,
			resource: "issue",
			timestamp: NOW_SECONDS,
		});
	});

	test("accepts raw bytes and a Headers instance", () => {
		const result = verifySentryWebhook({
			rawBody: new TextEncoder().encode(BODY),
			headers: new Headers(headers() as Record<string, string>),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(result.ok).toBe(true);
	});

	test("rejects a tampered body", () => {
		const result = verifySentryWebhook({
			rawBody: `${BODY} `,
			headers: headers(),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects the wrong secret", () => {
		const result = verifySentryWebhook({
			rawBody: BODY,
			headers: headers(),
			secret: `${SECRET}-rotated`,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects a missing signature, timestamp or resource header", () => {
		for (const missing of [
			SENTRY_SIGNATURE_HEADER,
			SENTRY_TIMESTAMP_HEADER,
			SENTRY_RESOURCE_HEADER,
		]) {
			const result = verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS, { [missing]: null }),
				secret: SECRET,
				nowMs: NOW_MS,
			});
			expect(result).toEqual({ ok: false, reason: "missing_headers" });
		}
	});

	test("rejects malformed signatures without comparing them", () => {
		for (const value of [
			"deadbeef",
			"a".repeat(63),
			"z".repeat(64),
			`sha256=${"a".repeat(64)}`,
			"",
		]) {
			const result = verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS, { [SENTRY_SIGNATURE_HEADER]: value }),
				secret: SECRET,
				nowMs: NOW_MS,
			});
			expect(result).toEqual({
				ok: false,
				reason: value === "" ? "missing_headers" : "malformed_signature",
			});
		}
	});

	test("rejects malformed timestamp and resource headers", () => {
		const badTimestamp = verifySentryWebhook({
			rawBody: BODY,
			headers: headers(NOW_SECONDS, { [SENTRY_TIMESTAMP_HEADER]: "31/10" }),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(badTimestamp).toEqual({ ok: false, reason: "malformed_headers" });

		const badResource = verifySentryWebhook({
			rawBody: BODY,
			headers: headers(NOW_SECONDS, {
				[SENTRY_RESOURCE_HEADER]: "Bad Resource",
			}),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(badResource).toEqual({ ok: false, reason: "malformed_headers" });
	});

	test("rejects a resource this connector does not subscribe to", () => {
		for (const resource of ["event_alert", "metric_alert"]) {
			const result = verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS, { [SENTRY_RESOURCE_HEADER]: resource }),
				secret: SECRET,
				nowMs: NOW_MS,
			});
			expect(result).toEqual({
				ok: false,
				reason: "unsupported_resource",
			});
		}
	});

	test("enforces the ±300 s replay window on the unsigned timestamp", () => {
		const atBoundary = verifySentryWebhook({
			rawBody: BODY,
			headers: headers(NOW_SECONDS - 300),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(atBoundary.ok).toBe(true);

		for (const drift of [-301, 301]) {
			const result = verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS + drift),
				secret: SECRET,
				nowMs: NOW_MS,
			});
			expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
		}
	});

	test("rejects a body above 64 KiB before verifying", () => {
		const oversized = "x".repeat(SENTRY_WEBHOOK_MAX_BODY_BYTES + 1);
		const result = verifySentryWebhook({
			rawBody: oversized,
			headers: headers(NOW_SECONDS, {
				[SENTRY_SIGNATURE_HEADER]: sign(oversized, SECRET),
			}),
			secret: SECRET,
			nowMs: NOW_MS,
		});
		expect(result).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("treats a short or missing secret as not configured", () => {
		for (const secret of [null, undefined, "", "too-short"]) {
			expect(
				verifySentryWebhook({
					rawBody: BODY,
					headers: headers(),
					secret,
					nowMs: NOW_MS,
				}),
			).toEqual({ ok: false, reason: "not_configured" });
		}
	});

	test("no failure reason echoes the body, signature or secret", () => {
		const failures = [
			verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS, {
					[SENTRY_SIGNATURE_HEADER]: "0".repeat(64),
				}),
				secret: SECRET,
				nowMs: NOW_MS,
			}),
			verifySentryWebhook({
				rawBody: BODY,
				headers: headers(NOW_SECONDS, { [SENTRY_SIGNATURE_HEADER]: "zz" }),
				secret: SECRET,
				nowMs: NOW_MS,
			}),
		];
		for (const failure of failures) {
			const serialized = JSON.stringify(failure);
			expect(serialized).not.toContain(SECRET);
			expect(serialized).not.toContain("created");
			expect(serialized).not.toContain(sign(BODY, SECRET));
		}
	});
});
