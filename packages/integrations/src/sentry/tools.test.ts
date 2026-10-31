import { describe, expect, test } from "bun:test";
import {
	getSentryIssue,
	getSentryLatestEvent,
	listSentryIssues,
} from "./tools";
import type { SentryToolDependencies } from "./types";

const TOKEN = "w16-sentry-tool-token-0123456789abcdef";
const ORG = "acme";
const ISSUE_ID = "467";
const PERMALINK = `https://sentry.io/organizations/${ORG}/issues/${ISSUE_ID}/`;

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function issue(overrides: Record<string, unknown> = {}) {
	return {
		id: ISSUE_ID,
		shortId: "CHECKOUT-1",
		title: "TypeError: cannot read id for alice@example.com",
		culprit: "app/checkout.js in submit",
		permalink: PERMALINK,
		level: "error",
		status: "unresolved",
		lastSeen: "2026-10-31T09:00:00Z",
		count: 12,
		project: { id: "450", slug: "checkout", name: "Checkout" },
		...overrides,
	};
}

const EVENT = {
	eventID: "abcdef0123456789abcdef0123456789",
	message: "TypeError for alice@example.com from 10.0.0.5",
	culprit: "app/checkout.js in submit",
	level: "error",
	release: { version: "1.2.3" },
	tags: [
		{ key: "environment", value: "production" },
		{ key: "release", value: "1.2.3" },
		{ key: "user", value: "alice@example.com" },
		{ key: "server_name", value: "10.0.0.5" },
	],
	entries: [
		{
			type: "exception",
			data: {
				values: [
					{
						type: "TypeError",
						value: "Cannot read id for alice@example.com",
						stacktrace: {
							frames: Array.from({ length: 6 }, (_, index) => ({
								filename: `app/src/frame${index}.ts`,
								function: `frame${index}`,
								lineNo: index + 1,
								inApp: true,
							})),
						},
					},
				],
			},
		},
	],
};

type RouterOptions = {
	issueStatus?: number;
	listStatus?: number;
	eventStatus?: number;
	issueBody?: unknown;
	listBody?: unknown;
	eventBody?: unknown;
	throwOn?: string;
};

function router(options: RouterOptions = {}): {
	impl: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const impl = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString();
		calls.push({ url, init: init ?? {} });
		if (options.throwOn !== undefined && url.includes(options.throwOn)) {
			throw new TypeError("fetch failed");
		}
		if (url.includes("/events/latest/")) {
			const status = options.eventStatus ?? 200;
			return status === 200
				? json(200, options.eventBody ?? EVENT)
				: json(status, { detail: "nope" });
		}
		if (url.includes("/issues/?limit=")) {
			const status = options.listStatus ?? 200;
			return status === 200
				? json(200, options.listBody ?? [issue()])
				: json(status, { detail: "nope" });
		}
		if (url.includes(`/issues/${ISSUE_ID}/`)) {
			const status = options.issueStatus ?? 200;
			return status === 200
				? json(200, options.issueBody ?? issue())
				: json(status, { detail: "nope" });
		}
		return json(404, { detail: "not found" });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function dependencies(
	impl: typeof fetch,
	overrides: Partial<SentryToolDependencies> = {},
): SentryToolDependencies {
	return { token: TOKEN, fetchImpl: impl, ...overrides };
}

describe("sentry.list_issues", () => {
	test("returns a bounded summary per issue", async () => {
		const { impl, calls } = router({
			listBody: [
				issue(),
				issue({
					id: "468",
					title: `Boom ${"x".repeat(251)}`,
					permalink: "http://insecure.example/issue/468",
				}),
			],
		});
		const result = await listSentryIssues(dependencies(impl), {
			orgSlug: ORG,
			limit: 2,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(2);
		expect(result.data[0]).toMatchObject({
			id: ISSUE_ID,
			shortId: "CHECKOUT-1",
			level: "error",
			projectSlug: "checkout",
			permalink: PERMALINK,
		});
		expect(result.data[0]?.title).not.toContain("alice@example.com");
		expect(result.data[1]?.title.length).toBeLessThanOrEqual(200);
		expect(result.data[1]?.permalink).toBeNull();
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(calls[0]?.url).toBe(
			`https://sentry.io/api/0/organizations/${ORG}/issues/?limit=2`,
		);
		expect(
			(calls[0]?.init.headers as Record<string, string> | undefined)
				?.Authorization,
		).toBe(`Bearer ${TOKEN}`);
	});

	test("uses the project-scoped endpoint and encodes the query", async () => {
		const { impl, calls } = router();
		const result = await listSentryIssues(dependencies(impl), {
			orgSlug: ORG,
			projectSlug: "checkout",
			query: "is:unresolved checkout",
			limit: 5,
		});
		expect(result.ok).toBe(true);
		expect(calls[0]?.url).toBe(
			`https://sentry.io/api/0/projects/${ORG}/checkout/issues/?limit=5&query=is%3Aunresolved%20checkout`,
		);
	});

	test("rejects non-strict or out-of-bounds input before any call", async () => {
		const { impl, calls } = router();
		for (const input of [
			null,
			"acme",
			{ orgSlug: ORG, extra: true },
			{ orgSlug: "bad org" },
			{ orgSlug: ORG, limit: 0 },
			{ orgSlug: ORG, limit: 26 },
			{ orgSlug: ORG, limit: 1.5 },
			{ orgSlug: ORG, query: "bad\nquery" },
			{ orgSlug: ORG, projectSlug: "../etc" },
		]) {
			const result = await listSentryIssues(dependencies(impl), input);
			expect(result).toEqual({ ok: false, code: "VALIDATION_FAILED" });
		}
		expect(calls).toHaveLength(0);
	});

	test("maps provider failures to fixed codes", async () => {
		for (const [status, code] of [
			[404, "NOT_FOUND"],
			[403, "POLICY_DENIED"],
			[401, "INTEGRATION_UNAVAILABLE"],
			[429, "RATE_LIMITED"],
			[500, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ listStatus: status });
			const result = await listSentryIssues(dependencies(impl), {
				orgSlug: ORG,
			});
			expect(result).toEqual({ ok: false, code });
		}
		const transport = await listSentryIssues(
			dependencies(router({ throwOn: "/issues/" }).impl),
			{ orgSlug: ORG },
		);
		expect(transport).toEqual({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});
	});
});

describe("sentry.get_issue", () => {
	test("returns one bounded summary without the token", async () => {
		const { impl, calls } = router();
		const result = await getSentryIssue(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.title).toBe(
			"TypeError: cannot read id for [email-redacted]",
		);
		expect(result.data.permalink).toBe(PERMALINK);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(calls[0]?.url).toBe(
			`https://sentry.io/api/0/organizations/${ORG}/issues/${ISSUE_ID}/`,
		);
	});

	test("rejects unknown arguments and invalid ids", async () => {
		const { impl, calls } = router();
		for (const input of [
			{ orgSlug: ORG, issueId: ISSUE_ID, extra: 1 },
			{ orgSlug: ORG, issueId: "../etc" },
			{ issueId: ISSUE_ID },
			undefined,
		]) {
			const result = await getSentryIssue(dependencies(impl), input);
			expect(result).toEqual({ ok: false, code: "VALIDATION_FAILED" });
		}
		expect(calls).toHaveLength(0);
	});

	test("maps missing, denied and rate-limited issues", async () => {
		for (const [status, code] of [
			[404, "NOT_FOUND"],
			[403, "POLICY_DENIED"],
			[429, "RATE_LIMITED"],
			[502, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ issueStatus: status });
			const result = await getSentryIssue(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			});
			expect(result).toEqual({ ok: false, code });
		}
	});

	test("drops a schema-invalid provider response", async () => {
		const { impl } = router({
			issueBody: { id: "467", title: "x".repeat(500) },
		});
		const result = await getSentryIssue(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(result).toEqual({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});
	});

	test("maps an invalid base url to VALIDATION_FAILED", async () => {
		const { impl, calls } = router();
		const result = await getSentryIssue(
			dependencies(impl, { baseUrl: "http://sentry.io" }),
			{ orgSlug: ORG, issueId: ISSUE_ID },
		);
		expect(result).toEqual({ ok: false, code: "VALIDATION_FAILED" });
		expect(calls).toHaveLength(0);
	});

	test("treats an empty token as unavailable without a call", async () => {
		const { impl, calls } = router();
		const result = await getSentryIssue(dependencies(impl, { token: "" }), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(result).toEqual({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("sentry.latest_event", () => {
	test("returns a bounded, redacted event summary", async () => {
		const { impl, calls } = router();
		const result = await getSentryLatestEvent(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.eventId).toBe(EVENT.eventID);
		expect(result.data.releaseVersion).toBe("1.2.3");
		expect(result.data.message).not.toContain("alice@example.com");
		expect(result.data.message).not.toContain("10.0.0.5");
		expect(result.data.tags).toEqual({
			environment: "production",
			release: "1.2.3",
		});
		expect(result.data.frames.length).toBeLessThanOrEqual(8);
		for (const frame of result.data.frames) {
			expect(frame.length).toBeLessThanOrEqual(400);
			expect(frame.startsWith("at ")).toBe(true);
		}
		expect(result.data.frames[0]).toContain("frame5");
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(calls[0]?.url).toBe(
			`https://sentry.io/api/0/organizations/${ORG}/issues/${ISSUE_ID}/events/latest/`,
		);
	});

	test("rejects malformed input", async () => {
		const { impl, calls } = router();
		for (const input of [
			{ orgSlug: ORG },
			{ orgSlug: "ACME!", issueId: ISSUE_ID },
			{ orgSlug: ORG, issueId: ISSUE_ID, environment: "production" },
		]) {
			const result = await getSentryLatestEvent(dependencies(impl), input);
			expect(result).toEqual({ ok: false, code: "VALIDATION_FAILED" });
		}
		expect(calls).toHaveLength(0);
	});

	test("maps failures and drops schema drift", async () => {
		for (const [status, code] of [
			[404, "NOT_FOUND"],
			[403, "POLICY_DENIED"],
			[429, "RATE_LIMITED"],
			[503, "INTEGRATION_UNAVAILABLE"],
		] as const) {
			const { impl } = router({ eventStatus: status });
			const result = await getSentryLatestEvent(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			});
			expect(result).toEqual({ ok: false, code });
		}

		const { impl } = router({ eventBody: { message: "no event id" } });
		const drift = await getSentryLatestEvent(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(drift).toEqual({
			ok: false,
			code: "INTEGRATION_UNAVAILABLE",
		});
	});
});
