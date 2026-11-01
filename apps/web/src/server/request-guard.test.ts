import { describe, expect, test } from "bun:test";
import {
	assertJsonRequest,
	assertSameOrigin,
	clientIp,
	REQUEST_GUARD_MAX_JSON_BYTES,
	RequestGuardError,
	UNTRUSTED_CLIENT_IP,
} from "./request-guard.server";

const APP_ORIGIN = "https://app.isolate.dev";
const URL_UNDER_TEST = `${APP_ORIGIN}/api/tasks`;

type RequestInitFixture = {
	method?: string;
	headers?: Record<string, string>;
	url?: string;
};

function request(init: RequestInitFixture = {}): Request {
	return new Request(init.url ?? URL_UNDER_TEST, {
		method: init.method ?? "POST",
		headers: init.headers ?? {},
	});
}

function guardFailure(run: () => void): RequestGuardError {
	try {
		run();
	} catch (error) {
		if (error instanceof RequestGuardError) return error;
		throw error;
	}
	throw new Error("expected the guard to reject the request");
}

describe("assertSameOrigin", () => {
	test("accepts a same-origin POST that carries Origin and Host", () => {
		expect(() =>
			assertSameOrigin(
				request({
					headers: {
						host: "app.isolate.dev",
						origin: APP_ORIGIN,
						"sec-fetch-site": "same-origin",
					},
				}),
			),
		).not.toThrow();
	});

	test("uses the Host header rather than the internal request URL", () => {
		expect(() =>
			assertSameOrigin(
				request({
					url: "http://internal-worker:3000/api/tasks",
					headers: { host: "app.isolate.dev", origin: APP_ORIGIN },
				}),
			),
		).not.toThrow();
	});

	test("a POST without Origin is a fixed 403", () => {
		const error = guardFailure(() =>
			assertSameOrigin(request({ headers: { host: "app.isolate.dev" } })),
		);
		expect(error.status).toBe(403);
		expect(error.code).toBe("ORIGIN_REJECTED");
		expect(error.message).toBe("request rejected");
	});

	test("a cross-site Origin is a fixed 403 and is never echoed", () => {
		const error = guardFailure(() =>
			assertSameOrigin(
				request({
					headers: { host: "app.isolate.dev", origin: "https://evil.example" },
				}),
			),
		);
		expect(error.status).toBe(403);
		expect(error.message).toBe("request rejected");
		expect(error.message).not.toContain("evil.example");
	});

	test("scheme, host and port must all match", () => {
		for (const origin of [
			"http://app.isolate.dev",
			"https://app.isolate.dev:8443",
			"https://api.isolate.dev",
			"https://app.isolate.dev.evil.example",
			"chrome-extension://abcdefghijklmnop",
		]) {
			expect({
				origin,
				status: guardFailure(() =>
					assertSameOrigin(
						request({ headers: { host: "app.isolate.dev", origin } }),
					),
				).status,
			}).toEqual({ origin, status: 403 });
		}
	});

	test("an opaque Origin, list or path is refused", () => {
		for (const origin of [
			"null",
			`${APP_ORIGIN}, https://evil.example`,
			`${APP_ORIGIN}/api/tasks`,
			"",
		]) {
			expect({
				origin,
				status: guardFailure(() =>
					assertSameOrigin(
						request({ headers: { host: "app.isolate.dev", origin } }),
					),
				).status,
			}).toEqual({ origin, status: 403 });
		}
	});

	test("Sec-Fetch-Site cross-site, same-site or unknown values are refused", () => {
		for (const site of ["cross-site", "same-site", "opaque", "cross-origin"]) {
			expect({
				site,
				status: guardFailure(() =>
					assertSameOrigin(
						request({
							headers: {
								host: "app.isolate.dev",
								origin: APP_ORIGIN,
								"sec-fetch-site": site,
							},
						}),
					),
				).status,
			}).toEqual({ site, status: 403 });
		}
	});

	test("Sec-Fetch-Site none is only valid without an Origin", () => {
		expect(() =>
			assertSameOrigin(
				request({
					method: "GET",
					headers: { "sec-fetch-site": "none" },
				}),
			),
		).not.toThrow();
		expect(
			guardFailure(() =>
				assertSameOrigin(
					request({
						method: "GET",
						headers: { "sec-fetch-site": "none", origin: APP_ORIGIN },
					}),
				),
			).status,
		).toBe(403);
	});

	test("safe methods may omit Origin, but a supplied one is checked", () => {
		expect(() => assertSameOrigin(request({ method: "GET" }))).not.toThrow();
		expect(() =>
			assertSameOrigin(
				request({ method: "GET", headers: { origin: APP_ORIGIN } }),
			),
		).not.toThrow();
		expect(
			guardFailure(() =>
				assertSameOrigin(
					request({
						method: "GET",
						headers: { origin: "https://evil.example" },
					}),
				),
			).status,
		).toBe(403);
	});

	test("an allowlist is authoritative when provided", () => {
		expect(() =>
			assertSameOrigin(
				request({
					url: "https://preview.isolate.dev/api/tasks",
					headers: { origin: "https://preview.isolate.dev" },
				}),
				{ allowedOrigins: ["https://preview.isolate.dev"] },
			),
		).not.toThrow();
		expect(
			guardFailure(() =>
				assertSameOrigin(
					request({
						url: "https://other.isolate.dev/api/tasks",
						headers: { origin: "https://other.isolate.dev" },
					}),
					{ allowedOrigins: ["https://preview.isolate.dev"] },
				),
			).status,
		).toBe(403);
		expect(
			guardFailure(() =>
				assertSameOrigin(request({ headers: { origin: APP_ORIGIN } }), {
					allowedOrigins: [],
				}),
			).status,
		).toBe(403);
	});
});

describe("assertJsonRequest", () => {
	test("accepts application/json with parameters", () => {
		for (const contentType of [
			"application/json",
			"application/json; charset=utf-8",
			"Application/JSON;charset=UTF-8",
		]) {
			expect({
				contentType,
				threw: throws(() => assertJsonRequest(json(contentType))),
			}).toEqual({
				contentType,
				threw: false,
			});
		}
	});

	test("refuses a missing or non-JSON media type with 415", () => {
		const cases: Record<string, string>[] = [
			{},
			{ "content-type": "text/plain" },
			{ "content-type": "application/x-www-form-urlencoded" },
			{ "content-type": "application/json-patch+json" },
			{ "content-type": "application/jsonish" },
		];
		for (const headers of cases) {
			const error = guardFailure(() => assertJsonRequest(request({ headers })));
			expect(error.status).toBe(415);
			expect(error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
		}
	});

	test("bounds a declared Content-Length", () => {
		const accepted = [0, 1, REQUEST_GUARD_MAX_JSON_BYTES];
		for (const length of accepted) {
			expect(() =>
				assertJsonRequest(json("application/json", String(length))),
			).not.toThrow();
		}
		const error = guardFailure(() =>
			assertJsonRequest(
				json("application/json", String(REQUEST_GUARD_MAX_JSON_BYTES + 1)),
			),
		);
		expect(error.status).toBe(413);
		expect(error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	test("honours a custom maxBytes", () => {
		expect(() =>
			assertJsonRequest(json("application/json", "11"), { maxBytes: 10 }),
		).toThrow(RequestGuardError);
		expect(() =>
			assertJsonRequest(json("application/json", "10"), { maxBytes: 10 }),
		).not.toThrow();
	});

	test("a malformed or duplicated Content-Length is a 400", () => {
		for (const length of ["-1", "1.5", "12, 12", "10kb", ""]) {
			const error = guardFailure(() =>
				assertJsonRequest(json("application/json", length)),
			);
			expect(error.status).toBe(400);
			expect(error.code).toBe("INVALID_CONTENT_LENGTH");
		}
	});

	test("a missing Content-Length is allowed; the reader must still cap", () => {
		expect(() => assertJsonRequest(json("application/json"))).not.toThrow();
	});

	test("body rules do not apply to bodyless methods", () => {
		expect(() =>
			assertJsonRequest(
				request({ method: "GET", headers: { "content-type": "text/plain" } }),
			),
		).not.toThrow();
	});
});

describe("clientIp", () => {
	test("is a constant unless proxy headers are trusted", () => {
		const spoofed = request({ headers: { "x-forwarded-for": "203.0.113.7" } });
		expect(clientIp(spoofed)).toBe(UNTRUSTED_CLIENT_IP);
		expect(clientIp(spoofed, { trustProxy: false })).toBe(UNTRUSTED_CLIENT_IP);
		expect(clientIp(request())).toBe(UNTRUSTED_CLIENT_IP);
	});

	test("uses the first hop only when trustProxy is enabled", () => {
		const proxied = request({
			headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" },
		});
		expect(clientIp(proxied, { trustProxy: true })).toBe("203.0.113.7");
		expect(
			clientIp(request({ headers: { "x-forwarded-for": "[2001:db8::1]" } }), {
				trustProxy: true,
			}),
		).toBe("2001:db8::1");
	});

	test("a malformed header falls back to the constant bucket", () => {
		for (const value of [
			"",
			"not-an-ip",
			"1.2.3.4:8080",
			"999.1.1.1",
			"a".repeat(100),
		]) {
			expect({
				value,
				ip: clientIp(request({ headers: { "x-forwarded-for": value } }), {
					trustProxy: true,
				}),
			}).toEqual({ value, ip: UNTRUSTED_CLIENT_IP });
		}
	});
});

function throws(run: () => void): boolean {
	try {
		run();
		return false;
	} catch {
		return true;
	}
}

function json(contentType?: string, contentLength?: string): Request {
	const headers: Record<string, string> = {};
	if (contentType !== undefined) headers["content-type"] = contentType;
	if (contentLength !== undefined) headers["content-length"] = contentLength;
	return request({ headers });
}
