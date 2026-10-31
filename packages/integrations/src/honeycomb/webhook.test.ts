import { describe, expect, test } from "bun:test";
import {
	HONEYCOMB_DELIVERY_HEADER,
	HONEYCOMB_WEBHOOK_MAX_BODY_BYTES,
	readHoneycombHeader,
	verifyHoneycombDelivery,
	verifyHoneycombWebhookToken,
} from "./webhook";

const TOKEN = "webhook-token-0123456789";

describe("verifyHoneycombDelivery", () => {
	test("reports an explicitly unsigned delivery after bridge verification", () => {
		const result = verifyHoneycombDelivery({
			rawBody: '{"dataset":"checkout"}',
			headers: { [HONEYCOMB_DELIVERY_HEADER]: "delivery-1" },
			bridgeVerified: true,
		});
		expect(result).toEqual({
			ok: true,
			status: "unsigned",
			signedByVendor: false,
			bridgeVerified: true,
			deliveryId: "delivery-1",
		});
	});

	test("never treats a missing bridge verdict as verification", () => {
		const result = verifyHoneycombDelivery({
			rawBody: "{}",
			headers: {},
			bridgeVerified: false,
		});
		expect(result).toEqual({ ok: false, reason: "not_bridge_verified" });
	});

	test("enforces the 64 KiB body cap before anything else", () => {
		const exact = new Uint8Array(HONEYCOMB_WEBHOOK_MAX_BODY_BYTES);
		expect(
			verifyHoneycombDelivery({
				rawBody: exact,
				headers: {},
				bridgeVerified: true,
			}).ok,
		).toBe(true);

		const oversize = new Uint8Array(HONEYCOMB_WEBHOOK_MAX_BODY_BYTES + 1);
		expect(
			verifyHoneycombDelivery({
				rawBody: oversize,
				headers: {},
				bridgeVerified: true,
			}),
		).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("rejects a malformed delivery id without echoing it", () => {
		const result = verifyHoneycombDelivery({
			rawBody: "{}",
			headers: new Headers({ [HONEYCOMB_DELIVERY_HEADER]: "bad id!" }),
			bridgeVerified: true,
		});
		expect(result).toEqual({ ok: false, reason: "malformed_headers" });
	});

	test("reads headers case-insensitively from a plain record", () => {
		expect(
			readHoneycombHeader(
				{ "X-Honeycomb-Delivery-Id": "abc" },
				"x-honeycomb-delivery-id",
			),
		).toBe("abc");
		expect(readHoneycombHeader({}, "x-honeycomb-delivery-id")).toBeNull();
	});
});

describe("verifyHoneycombWebhookToken", () => {
	test("compares a bridge-held token in constant time", () => {
		expect(verifyHoneycombWebhookToken(TOKEN, TOKEN)).toBe(true);
		expect(verifyHoneycombWebhookToken(`${TOKEN}x`, TOKEN)).toBe(false);
		expect(verifyHoneycombWebhookToken(null, TOKEN)).toBe(false);
		expect(verifyHoneycombWebhookToken("", TOKEN)).toBe(false);
	});

	test("treats a short or missing expected token as not configured", () => {
		expect(verifyHoneycombWebhookToken("short", "short")).toBe(false);
		expect(verifyHoneycombWebhookToken(TOKEN, null)).toBe(false);
		expect(verifyHoneycombWebhookToken(TOKEN, undefined)).toBe(false);
	});
});
