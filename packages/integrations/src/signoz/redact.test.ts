import { describe, expect, test } from "bun:test";
import {
	MAX_SIGNOZ_MESSAGE_CHARS,
	redactSignozMessage,
	redactSignozText,
} from "./redact";

function fakeJwt(): string {
	const encode = (value: object): string =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: "fixture" })}.fixture-signature`;
}
const JWT = fakeJwt();

describe("redactSignozText", () => {
	test("redacts the SigNoz API key header and Basic credentials", () => {
		expect(redactSignozText("SIGNOZ-API-KEY: signoz-secret-value-123")).toBe(
			"SIGNOZ-API-KEY: [token-redacted]",
		);
		expect(redactSignozText("Authorization: Basic dXNlcjpzZWNyZXQ=")).toContain(
			"[auth-redacted]",
		);
		expect(redactSignozText("Basic dXNlcjpzZWNyZXQ=")).toBe(
			"Basic [auth-redacted]",
		);
	});

	test("redacts key=value secrets, JWTs and credential-bearing URLs", () => {
		expect(redactSignozText("password=hunter2")).toBe(
			"password=[auth-redacted]",
		);
		expect(redactSignozText(`api_key: ${"test-value"}`)).toBe(
			"api_key: [auth-redacted]",
		);
		expect(redactSignozText(JWT)).toBe("[token-redacted]");
		expect(
			redactSignozText("https://user:pass@signoz.example.com/alerts"),
		).toBe("https://[redacted]@signoz.example.com/alerts");
	});

	test("redacts emails and IPv4 addresses with optional ports", () => {
		expect(redactSignozText("owner: oncall@example.com")).toBe(
			"owner: [email-redacted]",
		);
		expect(redactSignozText("instance 10.1.2.3:8080 degraded")).toBe(
			"instance [ip-redacted] degraded",
		);
	});

	test("redacts injected secrets of at least eight characters", () => {
		expect(
			redactSignozText("value my-secret-token-xyz end", [
				"my-secret-token-xyz",
			]),
		).toBe("value [token-redacted] end");
	});
});

describe("redactSignozMessage", () => {
	test("caps messages and keeps provider text bounded", () => {
		const message = redactSignozMessage("a".repeat(600));
		expect(message.length).toBe(MAX_SIGNOZ_MESSAGE_CHARS);
		expect(message.endsWith("…")).toBe(true);
		expect(redactSignozMessage("short message")).toBe("short message");
	});
});
