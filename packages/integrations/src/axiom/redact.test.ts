import { describe, expect, test } from "bun:test";
import {
	AXIOM_REDACTION_MARKERS,
	MAX_AXIOM_MESSAGE_CHARS,
	redactAxiomMessage,
	redactAxiomText,
} from "./redact";

describe("redactAxiomText", () => {
	test("removes credentials, emails, IPs, identifiers and URL queries", () => {
		const text = [
			"Authorization: Bearer xapt_secret0123456789",
			"user alice@example.com from 10.1.2.3 and 2001:db8::1",
			'user_id="u-123" session_id=s-456',
			"see https://app.axiom.co/datasets/app-logs?query=secret&token=abc#panel",
			"password=hunter2",
		].join("\n");
		const redacted = redactAxiomText(text);
		expect(redacted).not.toContain("xapt_secret0123456789");
		expect(redacted).not.toContain("alice@example.com");
		expect(redacted).not.toContain("10.1.2.3");
		expect(redacted).not.toContain("2001:db8::1");
		expect(redacted).not.toContain("u-123");
		expect(redacted).not.toContain("s-456");
		expect(redacted).not.toContain("query=secret");
		expect(redacted).not.toContain("hunter2");
		expect(redacted).toContain(AXIOM_REDACTION_MARKERS.email);
		expect(redacted).toContain(AXIOM_REDACTION_MARKERS.ip);
		expect(redacted).toContain(AXIOM_REDACTION_MARKERS.identifier);
		expect(redacted).toContain(AXIOM_REDACTION_MARKERS.query);
	});

	test("removes an explicitly injected secret of 8+ characters", () => {
		const secret = "injected-secret-value";
		expect(redactAxiomText(`token ${secret}`, [secret])).not.toContain(secret);
	});

	test("leaves ordinary text intact", () => {
		expect(redactAxiomText("checkout 500 timeout")).toBe(
			"checkout 500 timeout",
		);
	});
});

describe("redactAxiomMessage", () => {
	test("caps a long message after redaction", () => {
		const message = redactAxiomMessage(
			`x${"y".repeat(MAX_AXIOM_MESSAGE_CHARS + 100)} alice@example.com`,
		);
		expect(message.length).toBeLessThanOrEqual(MAX_AXIOM_MESSAGE_CHARS);
		expect(message).not.toContain("alice@example.com");
	});
});
