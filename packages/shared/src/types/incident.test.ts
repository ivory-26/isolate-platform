import { describe, expect, test } from "bun:test";
import {
	contextBundleSchema,
	contextItemSchema,
	incidentSignalSchema,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	MAX_INCIDENT_LINKS,
} from "./incident";

const signal = (overrides: Record<string, unknown> = {}) => ({
	source: "github",
	kind: "workflow_failed",
	severity: "high",
	service: "checkout-api",
	fingerprint: "repo:owner/checkout:run:42",
	title: "CI failed on main",
	summary: "The integration job failed after the deploy step.",
	links: [
		{
			label: "Failed run",
			url: "https://github.com/owner/checkout/actions/runs/42",
		},
	],
	receivedAt: "2026-10-30T12:00:00.000Z",
	...overrides,
});

const contextItem = (overrides: Record<string, unknown> = {}) => ({
	source: "github",
	kind: "workflow_run",
	title: "Failed workflow run 42",
	url: "https://github.com/owner/checkout/actions/runs/42",
	excerpt: "Job integration failed at step deploy.",
	fetchedAt: "2026-10-30T12:00:01.000Z",
	trustLevel: "untrusted",
	sha256: "a".repeat(64),
	...overrides,
});

describe("incidentSignalSchema", () => {
	test("accepts a bounded signal", () => {
		const parsed = incidentSignalSchema.parse(signal());
		expect(parsed.source).toBe("github");
		expect(parsed.links).toHaveLength(1);
	});

	test("rejects unknown fields, including body-supplied tenancy", () => {
		for (const extra of [
			{ organizationId: "20000000-0000-4000-8000-000000000001" },
			{ repositoryId: "20000000-0000-4000-8000-000000000003" },
			{ payload: { arbitrary: true } },
			{ trustLevel: "trusted" },
		])
			expect(incidentSignalSchema.safeParse(signal(extra)).success).toBe(false);
	});

	test("rejects every field above its cap", () => {
		const rejected = [
			signal({ kind: "k".repeat(65) }),
			signal({ service: "s".repeat(129) }),
			signal({ fingerprint: "f".repeat(129) }),
			signal({ title: "t".repeat(201) }),
			signal({ summary: "s".repeat(2001) }),
			signal({ source: "webhook" }),
			signal({ severity: "unknown" }),
			signal({ receivedAt: "yesterday" }),
			signal({
				links: Array.from({ length: 11 }, () => ({
					label: "run",
					url: "https://example.com/run",
				})),
			}),
			signal({ links: [{ label: "run", url: "http://example.com/run" }] }),
			signal({ links: [{ label: "run", url: "https://u:p@example.com/run" }] }),
			signal({
				links: [
					{ label: "run", url: `https://example.com/${"x".repeat(520)}` },
				],
			}),
			signal({
				links: [{ label: "l".repeat(121), url: "https://example.com" }],
			}),
			signal({
				links: [{ label: "run", url: "https://example.com", extra: true }],
			}),
		];
		for (const candidate of rejected)
			expect(incidentSignalSchema.safeParse(candidate).success).toBe(false);
	});

	test("accepts an empty summary and empty link list", () => {
		expect(
			incidentSignalSchema.safeParse(signal({ summary: "", links: [] }))
				.success,
		).toBe(true);
		expect(
			incidentSignalSchema.safeParse(signal({ title: "t", summary: "" }))
				.success,
		).toBe(true);
	});

	test("link cap is exactly ten", () => {
		const links = Array.from({ length: MAX_INCIDENT_LINKS }, (_, index) => ({
			label: `run ${index}`,
			url: `https://example.com/run/${index}`,
		}));
		expect(incidentSignalSchema.safeParse(signal({ links })).success).toBe(
			true,
		);
	});
});

describe("contextItemSchema", () => {
	test("accepts a url item or a repo-relative path item", () => {
		expect(contextItemSchema.safeParse(contextItem()).success).toBe(true);
		expect(
			contextItemSchema.safeParse(
				contextItem({ url: undefined, path: "docs/runbook.md" }),
			).success,
		).toBe(true);
	});

	test("requires a url or a path", () => {
		expect(
			contextItemSchema.safeParse(
				contextItem({ url: undefined, path: undefined }),
			).success,
		).toBe(false);
	});

	test("rejects unsafe paths, unknown fields and unbounded excerpts", () => {
		const rejected = [
			contextItem({ url: undefined, path: "/etc/passwd" }),
			contextItem({ url: undefined, path: "../outside.md" }),
			contextItem({ url: undefined, path: "docs\\runbook.md" }),
			contextItem({ extra: true }),
			contextItem({ excerpt: "x".repeat(4001) }),
			contextItem({ title: "t".repeat(201) }),
			contextItem({ kind: "k".repeat(65) }),
			contextItem({ sha256: "not-a-hash" }),
			contextItem({ trustLevel: "provider_text" }),
			contextItem({ source: "slack" }),
			contextItem({ fetchedAt: "not-a-date" }),
			contextItem({ url: "https://user:secret@example.com/x" }),
		];
		for (const candidate of rejected)
			expect(contextItemSchema.safeParse(candidate).success).toBe(false);
	});
});

describe("contextBundleSchema", () => {
	const bundle = (
		items: unknown[],
		overrides: Record<string, unknown> = {},
	) => ({
		incidentFingerprint: "repo:owner/checkout:run:42",
		items,
		truncated: false,
		...overrides,
	});

	test("accepts the item cap and a 256 KiB excerpt budget", () => {
		const quarterMib = Array.from({ length: 64 }, () =>
			contextItem({ excerpt: "x".repeat(4000) }),
		);
		expect(MAX_CONTEXT_TOTAL_EXCERPT_BYTES).toBe(256 * 1024);
		expect(contextBundleSchema.safeParse(bundle(quarterMib)).success).toBe(
			true,
		);
		expect(
			contextBundleSchema.safeParse(
				bundle(Array.from({ length: MAX_CONTEXT_ITEMS }, () => contextItem())),
			).success,
		).toBe(true);
	});

	test("rejects one item over the cap, excerpt overflow and unknown fields", () => {
		expect(
			contextBundleSchema.safeParse(
				bundle(Array.from({ length: 101 }, () => contextItem())),
			).success,
		).toBe(false);
		expect(
			contextBundleSchema.safeParse(
				bundle(
					Array.from({ length: 80 }, () =>
						contextItem({ excerpt: "x".repeat(4000) }),
					),
				),
			).success,
		).toBe(false);
		expect(
			contextBundleSchema.safeParse(bundle([], { organizationId: "org" }))
				.success,
		).toBe(false);
		expect(
			contextBundleSchema.safeParse(bundle([], { truncated: "yes" })).success,
		).toBe(false);
		expect(
			contextBundleSchema.safeParse(
				bundle([], { incidentFingerprint: "f".repeat(129) }),
			).success,
		).toBe(false);
	});
});
