import { describe, expect, test } from "bun:test";
import { AXIOM_WEBHOOK_MAX_BODY_BYTES } from "./schemas";
import {
	AXIOM_REPLAY_WINDOW_MS,
	type AxiomWebhookVerification,
	isAxiomAlertFresh,
	verifyAxiomWebhook,
} from "./webhook";

const NOW_MS = Date.parse("2026-10-31T00:00:00.000Z");
const SECRET = "w17-axiom-shared-secret-0123456789";
const HEADER = "x-axiom-shared";
const BODY = JSON.stringify({
	action: "triggered",
	monitor_id: "mon-1",
	dataset: "app-logs",
	timestamp: new Date(NOW_MS).toISOString(),
});

function verify(
	overrides: Partial<Parameters<typeof verifyAxiomWebhook>[0]> = {},
): AxiomWebhookVerification {
	return verifyAxiomWebhook({
		rawBody: BODY,
		headers: { [HEADER]: SECRET },
		headerName: HEADER,
		secret: SECRET,
		...overrides,
	});
}

describe("verifyAxiomWebhook", () => {
	test("returns an explicit unsigned result when nothing is configured", () => {
		expect(verify({ headerName: null, secret: null, headers: {} })).toEqual({
			ok: true,
			status: "unsigned",
			signed: false,
			signature: "none",
			sharedHeaderPresent: false,
			sharedHeaderValid: null,
		});
	});

	test("accepts a matching shared header in constant time", () => {
		expect(verify()).toEqual({
			ok: true,
			status: "unsigned",
			signed: false,
			signature: "none",
			sharedHeaderPresent: true,
			sharedHeaderValid: true,
		});
		const viaHeaders = verify({
			headers: new Headers({ [HEADER]: SECRET }),
		});
		expect(viaHeaders.ok).toBe(true);
	});

	test("never claims a signature: no HMAC branch exists", () => {
		const result = verify();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected an accepted delivery");
		expect(result.status).toBe("unsigned");
		expect(result.signed).toBe(false);
		expect("signatureVerified" in result).toBe(false);
	});

	test("rejects a missing, malformed or wrong shared header", () => {
		expect(verify({ headers: {} })).toEqual({
			ok: false,
			reason: "missing_headers",
		});
		expect(verify({ headers: { [HEADER]: "x".repeat(513) } })).toEqual({
			ok: false,
			reason: "malformed_headers",
		});
		expect(verify({ headers: { [HEADER]: "wrong-secret" } })).toEqual({
			ok: false,
			reason: "invalid_header",
		});
	});

	test("fails closed on a misconfigured secret or header name", () => {
		expect(verify({ secret: "too-short" })).toEqual({
			ok: false,
			reason: "not_configured",
		});
		expect(verify({ headerName: null })).toEqual({
			ok: false,
			reason: "not_configured",
		});
		expect(verify({ headerName: "bad header!" })).toEqual({
			ok: false,
			reason: "malformed_headers",
		});
	});

	test("rejects a body above 64 KiB before the header check", () => {
		const oversized = "x".repeat(AXIOM_WEBHOOK_MAX_BODY_BYTES + 1);
		expect(
			verify({
				rawBody: oversized,
				headers: {},
				headerName: null,
				secret: null,
			}),
		).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("no failure echoes the body, header value or secret", () => {
		const failures = [
			verify({ headers: { [HEADER]: "wrong-secret" } }),
			verify({ headers: {} }),
			verify({ rawBody: `${BODY} `, secret: `${SECRET}-rotated` }),
		];
		for (const failure of failures) {
			const serialized = JSON.stringify(failure);
			expect(serialized).not.toContain(SECRET);
			expect(serialized).not.toContain("wrong-secret");
			expect(serialized).not.toContain("mon-1");
		}
	});
});

describe("isAxiomAlertFresh", () => {
	test("accepts a timestamp inside the 15-minute window", () => {
		expect(isAxiomAlertFresh(new Date(NOW_MS).toISOString(), NOW_MS)).toBe(
			true,
		);
		expect(
			isAxiomAlertFresh(
				new Date(NOW_MS - AXIOM_REPLAY_WINDOW_MS).toISOString(),
				NOW_MS,
			),
		).toBe(true);
	});

	test("rejects stale, future and unparsable timestamps", () => {
		expect(
			isAxiomAlertFresh(
				new Date(NOW_MS - AXIOM_REPLAY_WINDOW_MS - 1).toISOString(),
				NOW_MS,
			),
		).toBe(false);
		expect(
			isAxiomAlertFresh(
				new Date(NOW_MS + AXIOM_REPLAY_WINDOW_MS + 1).toISOString(),
				NOW_MS,
			),
		).toBe(false);
		expect(isAxiomAlertFresh("yesterday", NOW_MS)).toBe(false);
		expect(isAxiomAlertFresh(new Date(NOW_MS).toISOString(), Number.NaN)).toBe(
			false,
		);
	});
});
