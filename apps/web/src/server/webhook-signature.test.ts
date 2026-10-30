import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	readBoundedWebhookBody,
	readWebhookHeader,
	verifyWebhookSignature,
	WEBHOOK_MAX_BODY_BYTES,
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
	WebhookBodyTooLargeError,
} from "./webhook-signature.server";

const SECRET = "fabricated-webhook-secret-0123456789abcdef";
const NOW = 1_800_000_000_000; // milliseconds; the signed timestamp is seconds.

function signed(
	body: string | Uint8Array,
	options: { secret?: string; timestamp?: string; now?: number | Date } = {},
) {
	const timestamp = options.timestamp ?? String(Math.floor(NOW / 1000));
	const bytes =
		typeof body === "string" ? new TextEncoder().encode(body) : body;
	const signature = `sha256=${createHmac("sha256", options.secret ?? SECRET)
		.update(`${timestamp}.`)
		.update(bytes)
		.digest("hex")}`;
	return {
		rawBody: body,
		timestamp,
		signature,
		secret: SECRET,
		now: options.now ?? NOW,
	};
}

describe("verifyWebhookSignature", () => {
	test("accepts a valid sha256 signature over timestamp.body", () => {
		const result = verifyWebhookSignature(signed('{"ok":true}'));
		expect(result).toEqual({
			ok: true,
			timestamp: Math.floor(NOW / 1000),
		});
	});

	test("verifies raw bytes, not a re-encoded string", () => {
		const body = new TextEncoder().encode('{"ok":"✓"}');
		expect(verifyWebhookSignature(signed(body)).ok).toBe(true);
		// The same text re-encoded as a string is the same bytes; a different
		// byte sequence is not.
		const latin1 = new Uint8Array([
			0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0xff, 0x7d,
		]);
		expect(
			verifyWebhookSignature({ ...signed(body), rawBody: latin1 }),
		).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects missing headers", () => {
		const valid = signed("{}");
		expect(verifyWebhookSignature({ ...valid, timestamp: null }).ok).toBe(
			false,
		);
		expect(verifyWebhookSignature({ ...valid, signature: undefined })).toEqual({
			ok: false,
			reason: "missing_headers",
		});
	});

	test("rejects a malformed or stale timestamp", () => {
		const valid = signed("{}");
		expect(verifyWebhookSignature({ ...valid, timestamp: "" })).toEqual({
			ok: false,
			reason: "missing_headers",
		});
		for (const timestamp of ["12x", "-1", "1.5", "9".repeat(13)])
			expect(verifyWebhookSignature({ ...valid, timestamp })).toEqual({
				ok: false,
				reason: "malformed_timestamp",
			});
		const stale = signed("{}", {
			timestamp: String(Math.floor(NOW / 1000) - 301),
		});
		expect(verifyWebhookSignature(stale)).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
		const future = signed("{}", {
			timestamp: String(Math.floor(NOW / 1000) + 301),
		});
		expect(verifyWebhookSignature(future)).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
		// Exactly on the boundary is still inside the window.
		const boundary = signed("{}", {
			timestamp: String(Math.floor(NOW / 1000) - 300),
		});
		expect(verifyWebhookSignature(boundary).ok).toBe(true);
	});

	test("rejects malformed signatures", () => {
		const valid = signed("{}");
		for (const signature of [
			createHmac("sha256", SECRET).update("x").digest("hex"),
			`sha256=${"zz".repeat(32)}`,
			"sha256=abc",
			`sha1=${"a".repeat(64)}`,
		])
			expect(verifyWebhookSignature({ ...valid, signature })).toEqual({
				ok: false,
				reason: "malformed_signature",
			});
	});

	test("rejects a valid-shape signature from another secret or body", () => {
		const valid = signed("{}");
		const wrongSecret = signed("{}", {
			secret: "another-fabricated-secret-0123456789abcdef",
		});
		expect(
			verifyWebhookSignature({ ...valid, signature: wrongSecret.signature }),
		).toEqual({ ok: false, reason: "invalid_signature" });
		const wrongBody = signed('{"ok":false}');
		expect(
			verifyWebhookSignature({ ...valid, signature: wrongBody.signature }),
		).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects a body above 64 KiB before parsing", () => {
		const big = "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1);
		expect(verifyWebhookSignature(signed(big))).toEqual({
			ok: false,
			reason: "body_too_large",
		});
		expect(
			verifyWebhookSignature(signed("x".repeat(WEBHOOK_MAX_BODY_BYTES))).ok,
		).toBe(true);
	});

	test("fails closed when the secret is absent or too short", () => {
		const valid = signed("{}");
		for (const secret of [undefined, "", "short"])
			expect(verifyWebhookSignature({ ...valid, secret })).toEqual({
				ok: false,
				reason: "not_configured",
			});
	});

	test("never puts the body or signature in the result", () => {
		const result = verifyWebhookSignature(signed('{"secret":"value"}'));
		expect(Object.keys(result).sort()).toEqual(["ok", "timestamp"]);
	});
});

describe("readWebhookHeader", () => {
	test("reads case-insensitively from Headers and plain records", () => {
		const headers = new Headers({
			[WEBHOOK_TIMESTAMP_HEADER]: "123",
			[WEBHOOK_SIGNATURE_HEADER]: "sha256=abc",
		});
		expect(readWebhookHeader(headers, WEBHOOK_TIMESTAMP_HEADER)).toBe("123");
		expect(
			readWebhookHeader(
				{ "X-Isolate-Signature": "sha256=abc" },
				WEBHOOK_SIGNATURE_HEADER,
			),
		).toBe("sha256=abc");
		expect(readWebhookHeader({}, WEBHOOK_SIGNATURE_HEADER)).toBeNull();
	});
});

describe("readBoundedWebhookBody", () => {
	const request = (body: string, headers: Record<string, string> = {}) =>
		new Request("http://localhost/api/webhooks/route", {
			method: "POST",
			body,
			headers,
		});

	test("reads a body inside the cap as raw bytes", async () => {
		const bytes = await readBoundedWebhookBody(request('{"a":1}'), 1024);
		expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
		const empty = await readBoundedWebhookBody(
			new Request("http://localhost/api/webhooks/route", {
				method: "POST",
			}),
			1024,
		);
		expect(empty.byteLength).toBe(0);
	});

	test("rejects an oversize declared or streamed body", async () => {
		await expect(
			readBoundedWebhookBody(
				request("x", { "content-length": String(WEBHOOK_MAX_BODY_BYTES + 1) }),
				WEBHOOK_MAX_BODY_BYTES,
			),
		).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
		await expect(
			readBoundedWebhookBody(request("x".repeat(32)), 16),
		).rejects.toBeInstanceOf(WebhookBodyTooLargeError);
	});
});
