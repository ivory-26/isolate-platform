import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	GITHUB_DELIVERY_HEADER,
	GITHUB_EVENT_HEADER,
	GITHUB_SIGNATURE_HEADER,
	GITHUB_WEBHOOK_MAX_BODY_BYTES,
	verifyGitHubWebhook,
} from "./webhook";

const SECRET = "w13-gh-webhook-secret-0123456789abcdef";
const BODY = JSON.stringify({ action: "completed", zen: "keep it logically" });
const DELIVERY = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

function sign(body: string, secret: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function headers(overrides: Record<string, string | null> = {}) {
	return {
		[GITHUB_SIGNATURE_HEADER]: sign(BODY, SECRET),
		[GITHUB_EVENT_HEADER]: "workflow_run",
		[GITHUB_DELIVERY_HEADER]: DELIVERY,
		...overrides,
	} as Record<string, string | null>;
}

describe("verifyGitHubWebhook", () => {
	test("accepts a correctly signed delivery and returns event + delivery", () => {
		const result = verifyGitHubWebhook({
			rawBody: BODY,
			headers: headers(),
			secret: SECRET,
		});
		expect(result).toEqual({
			ok: true,
			event: "workflow_run",
			delivery: DELIVERY,
		});
	});

	test("accepts raw bytes and a Headers instance", () => {
		const result = verifyGitHubWebhook({
			rawBody: new TextEncoder().encode(BODY),
			headers: new Headers(headers() as Record<string, string>),
			secret: SECRET,
		});
		expect(result.ok).toBe(true);
	});

	test("rejects the wrong secret", () => {
		const result = verifyGitHubWebhook({
			rawBody: BODY,
			headers: headers(),
			secret: `${SECRET}-rotated`,
		});
		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("rejects a signature computed over a different body", () => {
		const result = verifyGitHubWebhook({
			rawBody: `${BODY} `,
			headers: headers(),
			secret: SECRET,
		});
		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	test("requires x-hub-signature-256, x-github-event and x-github-delivery", () => {
		for (const missing of [
			GITHUB_SIGNATURE_HEADER,
			GITHUB_EVENT_HEADER,
			GITHUB_DELIVERY_HEADER,
		]) {
			const result = verifyGitHubWebhook({
				rawBody: BODY,
				headers: headers({ [missing]: null }),
				secret: SECRET,
			});
			expect(result).toEqual({ ok: false, reason: "missing_headers" });
		}
	});

	test("rejects malformed signatures without comparing them", () => {
		for (const value of [
			"deadbeef",
			`sha256=${"a".repeat(63)}`,
			`sha256=${"z".repeat(64)}`,
			"sha256=",
		]) {
			const result = verifyGitHubWebhook({
				rawBody: BODY,
				headers: headers({ [GITHUB_SIGNATURE_HEADER]: value }),
				secret: SECRET,
			});
			expect(result).toEqual({ ok: false, reason: "malformed_signature" });
		}
	});

	test("rejects the deprecated sha1 signature header", () => {
		const result = verifyGitHubWebhook({
			rawBody: BODY,
			headers: headers({ [GITHUB_SIGNATURE_HEADER]: "sha1=deadbeef" }),
			secret: SECRET,
		});
		expect(result).toEqual({
			ok: false,
			reason: "unsupported_algorithm",
		});
	});

	test("rejects malformed event or delivery headers", () => {
		const badEvent = verifyGitHubWebhook({
			rawBody: BODY,
			headers: headers({ [GITHUB_EVENT_HEADER]: "Workflow Run" }),
			secret: SECRET,
		});
		expect(badEvent).toEqual({ ok: false, reason: "malformed_headers" });

		const badDelivery = verifyGitHubWebhook({
			rawBody: BODY,
			headers: headers({ [GITHUB_DELIVERY_HEADER]: "../delivery" }),
			secret: SECRET,
		});
		expect(badDelivery).toEqual({ ok: false, reason: "malformed_headers" });
	});

	test("rejects a body above 64 KiB before verifying", () => {
		const oversized = "x".repeat(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1);
		const result = verifyGitHubWebhook({
			rawBody: oversized,
			headers: headers({ [GITHUB_SIGNATURE_HEADER]: sign(oversized, SECRET) }),
			secret: SECRET,
		});
		expect(result).toEqual({ ok: false, reason: "body_too_large" });
	});

	test("treats a short or missing secret as not configured", () => {
		for (const secret of [null, undefined, "", "too-short"]) {
			expect(
				verifyGitHubWebhook({
					rawBody: BODY,
					headers: headers(),
					secret,
				}),
			).toEqual({ ok: false, reason: "not_configured" });
		}
	});

	test("no failure reason echoes the body, signature or secret", () => {
		const failures = [
			verifyGitHubWebhook({
				rawBody: BODY,
				headers: headers({
					[GITHUB_SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}`,
				}),
				secret: SECRET,
			}),
			verifyGitHubWebhook({
				rawBody: BODY,
				headers: headers({ [GITHUB_SIGNATURE_HEADER]: "sha256=zz" }),
				secret: SECRET,
			}),
		];
		for (const failure of failures) {
			const serialized = JSON.stringify(failure);
			expect(serialized).not.toContain(SECRET);
			expect(serialized).not.toContain("keep it logically");
			expect(serialized).not.toContain("sha256=");
		}
	});
});
