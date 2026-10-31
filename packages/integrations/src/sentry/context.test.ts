import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ContextBundle,
	contextBundleSchema,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	PlatformError,
} from "@isolate/shared";
import {
	fetchSentryContext,
	SENTRY_CONTEXT_MAX_EXCERPT_CHARS,
	SENTRY_CONTEXT_MAX_FETCH_CALLS,
	SENTRY_CONTEXT_MAX_ITEMS,
} from "./context";
import type { SentryContextDependencies } from "./types";

const TOKEN = "w16-sentry-org-token-0123456789abcdef";
const ORG = "acme";
const ISSUE_ID = "467";
const PERMALINK = `https://sentry.io/organizations/${ORG}/issues/${ISSUE_ID}/`;
const NOW = Date.parse("2026-10-31T00:00:00.000Z");

type FetchCall = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const ISSUE = {
	id: ISSUE_ID,
	shortId: "CHECKOUT-1",
	title: "TypeError: cannot read id",
	culprit: "app/checkout.js in submit",
	permalink: PERMALINK,
	level: "error",
	status: "unresolved",
	firstSeen: "2026-10-30T10:00:00Z",
	lastSeen: "2026-10-31T09:00:00Z",
	count: 12,
	metadata: {
		value: "Cannot read properties of undefined (reading 'id')",
		type: "TypeError",
		filename: "app/checkout.js",
	},
	project: { id: "450", slug: "checkout", name: "Checkout" },
};

function frames(count: number): unknown[] {
	return Array.from({ length: count }, (_, index) => ({
		filename: `/Users/alice/app/src/frame${index}.ts`,
		function: `frame${index}`,
		lineNo: index + 1,
		colNo: 1,
		inApp: index >= count - 6,
	}));
}

function eventBody(overrides: Record<string, unknown> = {}) {
	return {
		eventID: "abcdef0123456789abcdef0123456789",
		message: "TypeError for alice@example.com from 10.0.0.5",
		title: "TypeError: cannot read id",
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
							stacktrace: { frames: frames(12) },
						},
					],
				},
			},
		],
		...overrides,
	};
}

const RELEASE = {
	version: "1.2.3",
	dateCreated: "2026-10-29T10:00:00Z",
	dateReleased: "2026-10-29T11:00:00Z",
	lastEvent: "2026-10-31T09:00:00Z",
	projects: [{ slug: "checkout", name: "Checkout" }],
};

const DEPLOYS = [
	{
		environment: "production",
		name: "deploy-old",
		url: "https://deploys.example/build/1",
		dateStarted: "2026-10-28T10:00:00Z",
		dateFinished: "2026-10-28T10:05:00Z",
	},
	{
		environment: "production",
		name: "deploy-new",
		url: "https://deploys.example/build/2",
		dateStarted: "2026-10-30T10:00:00Z",
		dateFinished: "2026-10-30T10:05:00Z",
	},
];

type RouterOptions = {
	issueStatus?: number;
	eventStatus?: number;
	releaseStatus?: number;
	deployStatus?: number;
	eventOversize?: boolean;
	throwOn?: string;
	event?: unknown;
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
			if (options.eventOversize === true) {
				return new Response("x".repeat(300 * 1024), { status: 200 });
			}
			const status = options.eventStatus ?? 200;
			return status === 200
				? json(200, options.event ?? eventBody())
				: json(status, { detail: "nope" });
		}
		if (url.includes("/deploys/")) {
			const status = options.deployStatus ?? 200;
			return status === 200
				? json(200, DEPLOYS)
				: json(status, { detail: "nope" });
		}
		if (url.includes("/releases/")) {
			const status = options.releaseStatus ?? 200;
			return status === 200
				? json(200, RELEASE)
				: json(status, { detail: "nope" });
		}
		if (url.includes(`/issues/${ISSUE_ID}/`)) {
			const status = options.issueStatus ?? 200;
			return status === 200
				? json(200, ISSUE)
				: json(status, { detail: "nope" });
		}
		return json(404, { detail: "not found" });
	};
	return { impl: impl as unknown as typeof fetch, calls };
}

function dependencies(
	impl: typeof fetch,
	overrides: Partial<SentryContextDependencies> = {},
): SentryContextDependencies {
	return {
		token: TOKEN,
		fetchImpl: impl,
		now: () => NOW,
		...overrides,
	};
}

function totalBytes(bundle: ContextBundle): number {
	return new TextEncoder().encode(
		bundle.items.map((item) => item.excerpt).join(""),
	).byteLength;
}

async function failureOf(promise: Promise<unknown>): Promise<PlatformError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformError);
		return error as PlatformError;
	}
	throw new Error("expected a PlatformError");
}

describe("fetchSentryContext", () => {
	test("assembles a bounded, cited bundle from the fixed four-call plan", async () => {
		const { impl, calls } = router();
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
			incidentFingerprint: "sentry:acme:450:467",
		});

		expect(contextBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.incidentFingerprint).toBe("sentry:acme:450:467");
		expect(bundle.items.map((item) => item.kind)).toEqual([
			"issue",
			"event",
			"release",
			"deploy",
		]);
		expect(bundle.items.length).toBeLessThanOrEqual(SENTRY_CONTEXT_MAX_ITEMS);
		expect(totalBytes(bundle)).toBeLessThanOrEqual(
			MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		);
		for (const item of bundle.items) {
			expect(item.source).toBe("sentry");
			expect(item.trustLevel).toBe("untrusted");
			expect(item.fetchedAt).toBe("2026-10-31T00:00:00.000Z");
			expect(item.excerpt.length).toBeLessThanOrEqual(
				SENTRY_CONTEXT_MAX_EXCERPT_CHARS,
			);
			expect(item.url).toMatch(/^https:\/\//);
			expect(item.url).not.toContain("@");
			expect(item.sha256).toBe(
				createHash("sha256").update(item.excerpt).digest("hex"),
			);
		}

		const event = bundle.items.find((item) => item.kind === "event");
		expect(event?.excerpt).toContain("Exception: TypeError");
		expect(event?.excerpt).toContain("at frame11");
		expect(event?.excerpt).not.toContain("frame0");
		expect(event?.excerpt).not.toContain("alice@example.com");
		expect(event?.excerpt).not.toContain("10.0.0.5");
		expect(event?.excerpt).not.toContain("/Users/alice");
		expect(event?.excerpt).not.toContain("server_name");

		const deploy = bundle.items.find((item) => item.kind === "deploy");
		expect(deploy?.excerpt).toContain("deploy-new");
		expect(deploy?.excerpt).not.toContain("deploy-old");

		expect(bundle.truncated).toBe(false);
		expect(calls.length).toBe(SENTRY_CONTEXT_MAX_FETCH_CALLS);
		expect(calls.map((call) => call.url)).toEqual([
			`https://sentry.io/api/0/organizations/${ORG}/issues/${ISSUE_ID}/`,
			`https://sentry.io/api/0/organizations/${ORG}/issues/${ISSUE_ID}/events/latest/`,
			`https://sentry.io/api/0/organizations/${ORG}/releases/1.2.3/`,
			`https://sentry.io/api/0/organizations/${ORG}/releases/1.2.3/deploys/`,
		]);
		for (const call of calls) {
			expect(
				(call.init.headers as Record<string, string> | undefined)
					?.Authorization,
			).toBe(`Bearer ${TOKEN}`);
		}
		expect(JSON.stringify(bundle)).not.toContain(TOKEN);
	});

	test("honours an EU base url and the environment filter", async () => {
		const { impl, calls } = router();
		await fetchSentryContext(
			dependencies(impl, { baseUrl: "https://de.sentry.io" }),
			{ orgSlug: ORG, issueId: ISSUE_ID, environment: "production" },
		);
		expect(calls[0]?.url).toBe(
			`https://de.sentry.io/api/0/organizations/${ORG}/issues/${ISSUE_ID}/?environment=production`,
		);
	});

	test("caps items and marks the bundle truncated", async () => {
		const { impl } = router();
		const bundle = await fetchSentryContext(
			dependencies(impl, { maxItems: 1 }),
			{ orgSlug: ORG, issueId: ISSUE_ID },
		);
		expect(bundle.items).toHaveLength(1);
		expect(bundle.truncated).toBe(true);
	});

	test("caps an oversized stack trace and reports truncation", async () => {
		const huge = Array.from({ length: 200 }, (_, index) => ({
			filename: `app/src/${"x".repeat(200)}${index}.ts`,
			function: `${"f".repeat(190)}${index}`,
			lineNo: index + 1,
			inApp: true,
		}));
		const { impl } = router({
			event: eventBody({
				entries: [
					{
						type: "exception",
						data: {
							values: [
								{ type: "Error", value: "boom", stacktrace: { frames: huge } },
							],
						},
					},
				],
			}),
		});
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		const event = bundle.items.find((item) => item.kind === "event");
		expect(event?.excerpt.length).toBeLessThanOrEqual(
			SENTRY_CONTEXT_MAX_EXCERPT_CHARS,
		);
		expect(event?.excerpt).not.toContain("f192");
		expect(bundle.truncated).toBe(true);
	});

	test("keeps a partial bundle when the latest event is missing", async () => {
		const { impl, calls } = router({ eventStatus: 404 });
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual(["issue"]);
		expect(bundle.truncated).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("keeps the event when only the optional release is denied", async () => {
		const { impl, calls } = router({ releaseStatus: 403 });
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual(["issue", "event"]);
		expect(bundle.truncated).toBe(true);
		expect(calls).toHaveLength(3);
	});

	test("drops an oversized response and marks truncation", async () => {
		const { impl } = router({ eventOversize: true });
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(bundle.items.map((item) => item.kind)).toEqual(["issue"]);
		expect(bundle.truncated).toBe(true);
	});

	test("maps a missing foreign issue to NOT_FOUND", async () => {
		const { impl } = router({ issueStatus: 404 });
		const error = await failureOf(
			fetchSentryContext(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain(ISSUE_ID);
	});

	test("maps a denied issue to POLICY_DENIED", async () => {
		const { impl } = router({ issueStatus: 403 });
		const error = await failureOf(
			fetchSentryContext(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(error.code).toBe("POLICY_DENIED");
	});

	test("maps 401 to INTEGRATION_UNAVAILABLE", async () => {
		const { impl } = router({ issueStatus: 401 });
		const error = await failureOf(
			fetchSentryContext(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(error.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(error.message).not.toContain(TOKEN);
	});

	test("fails closed on 429 without echoing provider text", async () => {
		const { impl } = router({ issueStatus: 429 });
		const error = await failureOf(
			fetchSentryContext(dependencies(impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(error.code).toBe("RATE_LIMITED");
		expect(error.message).not.toContain("nope");
	});

	test("maps 5xx and transport failures to INTEGRATION_UNAVAILABLE", async () => {
		const server = await failureOf(
			fetchSentryContext(dependencies(router({ issueStatus: 500 }).impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(server.code).toBe("INTEGRATION_UNAVAILABLE");

		const transport = await failureOf(
			fetchSentryContext(dependencies(router({ throwOn: "/issues/" }).impl), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(transport.code).toBe("INTEGRATION_UNAVAILABLE");
	});

	test("rejects invalid inputs and an empty token before any call", async () => {
		const { impl, calls } = router();
		for (const input of [
			{ orgSlug: "bad org", issueId: ISSUE_ID },
			{ orgSlug: ORG, issueId: "../etc" },
			{ orgSlug: ORG, issueId: ISSUE_ID, environment: "prod\ninjected" },
			{ orgSlug: "", issueId: ISSUE_ID },
		]) {
			const error = await failureOf(
				fetchSentryContext(dependencies(impl), input),
			);
			expect(error.code).toBe("VALIDATION_FAILED");
		}
		const empty = await failureOf(
			fetchSentryContext(dependencies(impl, { token: "  " }), {
				orgSlug: ORG,
				issueId: ISSUE_ID,
			}),
		);
		expect(empty.code).toBe("INTEGRATION_UNAVAILABLE");
		expect(calls).toHaveLength(0);
	});

	test("derives the fingerprint from the issue project when omitted", async () => {
		const { impl } = router();
		const bundle = await fetchSentryContext(dependencies(impl), {
			orgSlug: ORG,
			issueId: ISSUE_ID,
		});
		expect(bundle.incidentFingerprint).toBe("sentry:acme:450:467");
	});
});
