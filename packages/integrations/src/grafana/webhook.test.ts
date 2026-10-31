import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	GRAFANA_SIGNATURE_HEADER,
	GRAFANA_WEBHOOK_MAX_BODY_BYTES,
	type GrafanaWebhookVerification,
	parseGrafanaTimestamp,
	verifyGrafanaWebhook,
} from "./webhook";

const SECRET = "w16-grafana-webhook-secret-0123456789abcdef";
const BODY = JSON.stringify({
	receiver: "isolate",
	status: "firing",
	version: "1",
	alerts: [{ status: "firing", labels: { alertname: "HighErrorRate" } }],
});
const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const TIMESTAMP_HEADER = "x-grafana-timestamp";

function sign(body: string, secret = SECRET, timestamp?: string): string {
	const mac = createHmac("sha256", secret);
	if (timestamp !== undefined) mac.update(`${timestamp}:`);
	return mac.update(body).digest("hex");
}

function headers(overrides: Record<string, string | null> = {}) {
	return {
		[GRAFANA_SIGNATURE_HEADER]: sign(BODY, SECRET, TIMESTAMP),
		[TIMESTAMP_HEADER]: TIMESTAMP,
		...overrides,
	} as Record<string, string | null>;
}

function verify(
	overrides: Partial<Parameters<typeof verifyGrafanaWebhook>[0]> = {},
): GrafanaWebhookVerification {
	return verifyGrafanaWebhook({
		secret: SECRET,
		rawBody: BODY,
		headers: headers(),
		timestampHeader: TIMESTAMP_HEADER,
		nowMs: NOW_MS,
		...overrides,
	});
}

describe("verifyGrafanaWebhook", () => {
	test("accepts HMAC-SHA256 over <timestamp>:<body>", () => {
		expect(verify()).toEqual({
			ok: true,
			status: "signed",
			signedString: "timestamp_body",
			timestampMs: NOW_MS,
			timestampHeader: TIMESTAMP_HEADER,
			signatureHeader: GRAFANA_SIGNATURE_HEADER,
		});
	});

	test("accepts raw bytes, a Headers instance and a sha256= prefix", () => {
		const result = verify({
			rawBody: new TextEncoder().encode(BODY),
			headers: new Headers({
				[GRAFANA_SIGNATURE_HEADER]: `sha256=${sign(BODY, SECRET, TIMESTAMP)}`,
				[TIMESTAMP_HEADER]: TIMESTAMP,
			}),
		});
		expect(result.ok).toBe(true);
	});

	test("signs the body alone when no timestamp header is configured", () => {
		const result = verify({
			timestampHeader: null,
			headers: { [GRAFANA_SIGNATURE_HEADER]: sign(BODY) },
		});
		expect(result).toEqual({
			ok: true,
			status: "signed",
			signedString: "body",
			timestampMs: null,
			timestampHeader: null,
			signatureHeader: GRAFANA_SIGNATURE_HEADER,
		});
	});

	test("returns an explicit unsigned result when no secret is configured", () => {
		expect(verify({ secret: null, headers: {} })).toEqual({
			ok: true,
			status: "unsigned",
			signaturePresent: false,
		});
		expect(verify({ secret: "", headers: {} })).toEqual({
			ok: true,
			status: "unsigned",
			signaturePresent: false,
		});
		expect(verify({ secret: undefined })).toEqual({
			ok: true,
			status: "unsigned",
			signaturePresent: true,
		});
	});

	test("a short secret fails closed instead of verifying", () => {
		expect(verify({ secret: "too-short" })).toEqual({
			ok: false,
			reason: "not_configured",
		});
	});

	test("rejects a tampered body, a wrong secret and a body-only signature", () => {
		expect(verify({ rawBody: `${BODY} ` })).toEqual({
			ok: false,
			reason: "invalid_signature",
		});
		expect(verify({ secret: `${SECRET}-rotated` })).toEqual({
			ok: false,
			reason: "invalid_signature",
		});
		const wrongSignedString = verify({
			headers: {
				[GRAFANA_SIGNATURE_HEADER]: sign(BODY),
				[TIMESTAMP_HEADER]: TIMESTAMP,
			},
		});
		expect(wrongSignedString).toEqual({
			ok: false,
			reason: "invalid_signature",
		});
	});

	test("requires the configured timestamp header", () => {
		expect(
			verify({ headers: { [GRAFANA_SIGNATURE_HEADER]: sign(BODY) } }),
		).toEqual({ ok: false, reason: "missing_headers" });
	});

	test("rejects a malformed timestamp and a 301 s skew", () => {
		expect(
			verify({
				headers: headers({ [TIMESTAMP_HEADER]: "not-a-timestamp" }),
			}),
		).toEqual({ ok: false, reason: "malformed_headers" });

		const stale = String(Math.floor(NOW_MS / 1000) - 301);
		expect(
			verify({
				headers: {
					[GRAFANA_SIGNATURE_HEADER]: sign(BODY, SECRET, stale),
					[TIMESTAMP_HEADER]: stale,
				},
			}),
		).toEqual({ ok: false, reason: "stale_timestamp" });

		const boundary = String(Math.floor(NOW_MS / 1000) - 300);
		expect(
			verify({
				headers: {
					[GRAFANA_SIGNATURE_HEADER]: sign(BODY, SECRET, boundary),
					[TIMESTAMP_HEADER]: boundary,
				},
			}).ok,
		).toBe(true);
	});

	test("accepts an ISO timestamp signed over the exact header value", () => {
		const iso = "2026-10-30T23:59:30.000Z";
		const result = verify({
			headers: {
				[GRAFANA_SIGNATURE_HEADER]: sign(BODY, SECRET, iso),
				[TIMESTAMP_HEADER]: iso,
			},
		});
		expect(result.ok).toBe(true);
		expect(parseGrafanaTimestamp(iso)).toBe(Date.parse(iso));
	});

	test("requires a well-formed signature header", () => {
		expect(verify({ headers: {} })).toEqual({
			ok: false,
			reason: "missing_headers",
		});
		for (const value of ["deadbeef", `sha256=${"a".repeat(63)}`, "sha256="]) {
			expect(
				verify({
					headers: headers({ [GRAFANA_SIGNATURE_HEADER]: value }),
				}),
			).toEqual({ ok: false, reason: "malformed_signature" });
		}
	});

	test("rejects a body above 64 KiB before verifying", () => {
		const oversized = "x".repeat(GRAFANA_WEBHOOK_MAX_BODY_BYTES + 1);
		expect(
			verify({
				rawBody: oversized,
				headers: headers({
					[GRAFANA_SIGNATURE_HEADER]: sign(oversized, SECRET, TIMESTAMP),
				}),
			}),
		).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("supports a custom signature header name", () => {
		const result = verify({
			signatureHeader: "X-Isolate-Signature",
			headers: {
				"X-Isolate-Signature": sign(BODY, SECRET, TIMESTAMP),
				[TIMESTAMP_HEADER]: TIMESTAMP,
			},
		});
		expect(result).toEqual({
			ok: true,
			status: "signed",
			signedString: "timestamp_body",
			timestampMs: NOW_MS,
			timestampHeader: TIMESTAMP_HEADER,
			signatureHeader: "x-isolate-signature",
		});
	});

	test("no failure echoes the body, signature, timestamp or secret", () => {
		const failures = [
			verify({ rawBody: `${BODY} ` }),
			verify({
				headers: headers({ [GRAFANA_SIGNATURE_HEADER]: "sha256=zz" }),
			}),
			verify({ secret: `${SECRET}-rotated` }),
		];
		for (const failure of failures) {
			const serialized = JSON.stringify(failure);
			expect(serialized).not.toContain(SECRET);
			expect(serialized).not.toContain("HighErrorRate");
			expect(serialized).not.toContain(TIMESTAMP);
			expect(serialized).not.toContain(sign(BODY, SECRET, TIMESTAMP));
		}
	});
});
