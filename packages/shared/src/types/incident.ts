import { z } from "zod";

/**
 * Incident intake contracts (wave 12, H12-4).
 *
 * A webhook is a *task source*, not an execution path. An `IncidentSignal` is
 * the normalized, bounded view of one inbound delivery; a `ContextBundle` is
 * the bounded, cited view of the evidence later fetched for it. Both are
 * strict: unknown fields are rejected at the boundary, every string has a cap,
 * and no contract carries a credential or an unbounded provider payload.
 *
 * Trust is about provenance and handling, never authority: no context item can
 * grant a permission, change a policy or select a tool.
 */

/** Sources a generic receiver may normalize today; vendor readers reuse them. */
export const INCIDENT_SOURCES = [
	"github",
	"sentry",
	"pagerduty",
	"datadog",
	"grafana",
	"generic",
] as const;
export const incidentSourceSchema = z.enum(INCIDENT_SOURCES);
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const INCIDENT_SEVERITIES = [
	"critical",
	"high",
	"medium",
	"low",
	"info",
] as const;
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Per-field caps from the connector survey (§2.1, §4.2), tightened for H12-4. */
export const MAX_INCIDENT_KIND_CHARS = 64;
export const MAX_INCIDENT_SERVICE_CHARS = 128;
export const MAX_INCIDENT_FINGERPRINT_CHARS = 128;
export const MAX_INCIDENT_TITLE_CHARS = 200;
export const MAX_INCIDENT_SUMMARY_CHARS = 2000;
export const MAX_INCIDENT_LINKS = 10;
export const MAX_INCIDENT_LINK_LABEL_CHARS = 120;
export const MAX_INCIDENT_LINK_URL_CHARS = 512;

/**
 * Display-only URL rule: https, bounded, and no embedded credentials. A link is
 * evidence for a human; it is never passed to a generic fetcher.
 */
export function isBoundedHttpsUrl(value: string): boolean {
	if (value.length === 0 || value.length > MAX_INCIDENT_LINK_URL_CHARS)
		return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.username === "" && url.password === ""
		);
	} catch {
		return false;
	}
}

export const incidentUrlSchema = z
	.string()
	.max(MAX_INCIDENT_LINK_URL_CHARS)
	.refine(isBoundedHttpsUrl, "https URL required without credentials");

export const incidentLinkSchema = z
	.strictObject({
		label: z.string().trim().min(1).max(MAX_INCIDENT_LINK_LABEL_CHARS),
		url: incidentUrlSchema,
	})
	.strict();
export type IncidentLink = z.infer<typeof incidentLinkSchema>;

export const incidentSignalSchema = z
	.strictObject({
		source: incidentSourceSchema,
		kind: z.string().trim().min(1).max(MAX_INCIDENT_KIND_CHARS),
		severity: incidentSeveritySchema,
		service: z.string().trim().min(1).max(MAX_INCIDENT_SERVICE_CHARS),
		/** Source-stable dedupe key; never a delivery id. */
		fingerprint: z.string().trim().min(1).max(MAX_INCIDENT_FINGERPRINT_CHARS),
		title: z.string().trim().min(1).max(MAX_INCIDENT_TITLE_CHARS),
		summary: z.string().max(MAX_INCIDENT_SUMMARY_CHARS),
		links: z.array(incidentLinkSchema).max(MAX_INCIDENT_LINKS),
		receivedAt: z.iso.datetime({ offset: true }),
	})
	.strict();
export type IncidentSignal = z.infer<typeof incidentSignalSchema>;

/** Context bundle caps (§4.2), enforced as characters/bytes, not estimates. */
export const MAX_CONTEXT_ITEMS = 20;
export const MAX_CONTEXT_TITLE_CHARS = 200;
export const MAX_CONTEXT_KIND_CHARS = 64;
export const MAX_CONTEXT_EXCERPT_CHARS = 2000;
export const MAX_CONTEXT_PATH_CHARS = 300;
export const MAX_CONTEXT_TOTAL_EXCERPT_BYTES = 16 * 1024;
export const CONTEXT_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Provenance and handling, never authority. */
export const CONTEXT_TRUST_LEVELS = ["trusted", "untrusted"] as const;
export const contextTrustLevelSchema = z.enum(CONTEXT_TRUST_LEVELS);
export type ContextTrustLevel = (typeof CONTEXT_TRUST_LEVELS)[number];

/** Repo-relative only: no absolute paths, no traversal, no separators outside `/`. */
export function isRepoRelativePath(value: string): boolean {
	if (value.length === 0 || value.length > MAX_CONTEXT_PATH_CHARS) return false;
	if (value.startsWith("/") || value.includes("\\")) return false;
	return value
		.split("/")
		.every((segment) => segment !== ".." && segment !== ".");
}

export const contextItemSchema = z
	.strictObject({
		source: incidentSourceSchema,
		kind: z.string().trim().min(1).max(MAX_CONTEXT_KIND_CHARS),
		title: z.string().trim().min(1).max(MAX_CONTEXT_TITLE_CHARS),
		url: incidentUrlSchema.optional(),
		path: z
			.string()
			.refine(isRepoRelativePath, "repo-relative path required")
			.optional(),
		excerpt: z.string().max(MAX_CONTEXT_EXCERPT_CHARS),
		fetchedAt: z.iso.datetime({ offset: true }),
		trustLevel: contextTrustLevelSchema,
		sha256: z.string().regex(CONTEXT_SHA256_PATTERN),
	})
	.strict()
	.refine((item) => item.url !== undefined || item.path !== undefined, {
		message: "context item requires a url or a path",
	});
export type ContextItem = z.infer<typeof contextItemSchema>;

export const contextBundleSchema = z
	.strictObject({
		incidentFingerprint: z
			.string()
			.trim()
			.min(1)
			.max(MAX_INCIDENT_FINGERPRINT_CHARS),
		items: z.array(contextItemSchema).max(MAX_CONTEXT_ITEMS),
		/** True when assembly dropped or capped evidence under the caps. */
		truncated: z.boolean(),
	})
	.strict()
	.refine(
		(bundle) =>
			new TextEncoder().encode(
				bundle.items.map((item) => item.excerpt).join(""),
			).byteLength <= MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		{ message: "total context excerpt exceeds 16 KiB" },
	);
export type ContextBundle = z.infer<typeof contextBundleSchema>;
