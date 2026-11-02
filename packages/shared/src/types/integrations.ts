import { z } from "zod";
import { connectorDisplayNameSchema } from "./connector";
import { incidentSeveritySchema } from "./incident";

/**
 * Event-first integration contracts (wave 23).
 *
 * An integration is a tenant-scoped event source plus a trigger policy. The
 * contracts here are deliberately strict and bounded:
 *
 * - the connector id is a closed union of the ten connectors the product
 *   supports, never free text;
 * - event kinds and environment allowlists are capped at 16 entries each;
 * - a trigger may name at most one repository and one base branch;
 * - autonomy is limited to A0-A3 (A4 production mutation is out of scope);
 * - `config` is a plain JSON object capped by keys, depth, string length and
 *   serialized bytes, so an unbounded provider payload cannot ride along.
 *
 * SECURITY: no field carries a credential, token or provider body. The relay
 * keeps provider secrets; these records are metadata only.
 */

/** The ten connectors the product supports (mirrors the wave-17 catalog). */
export const INTEGRATION_CONNECTOR_IDS = [
	"github",
	"sentry",
	"grafana",
	"pagerduty",
	"kubernetes",
	"datadog",
	"newrelic",
	"honeycomb",
	"axiom",
	"signoz",
] as const;
export const integrationConnectorIdSchema = z.enum(INTEGRATION_CONNECTOR_IDS);
export type IntegrationConnectorId = (typeof INTEGRATION_CONNECTOR_IDS)[number];

/** A0 observe, A1 investigate, A2 prepare fix, A3 propose PR. */
export const AUTONOMY_LEVELS = ["A0", "A1", "A2", "A3"] as const;
export const autonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const MAX_INTEGRATION_EVENT_KINDS = 16;
export const MAX_INTEGRATION_ENVIRONMENTS = 16;
export const MAX_INTEGRATION_EVENT_KIND_CHARS = 64;
export const MAX_INTEGRATION_ENVIRONMENT_CHARS = 64;
export const MAX_INTEGRATION_BASE_BRANCH_CHARS = 255;
export const MAX_INTEGRATION_CONFIG_KEYS = 32;
export const MAX_INTEGRATION_CONFIG_DEPTH = 3;
export const MAX_INTEGRATION_CONFIG_STRING_CHARS = 1024;
export const MAX_INTEGRATION_CONFIG_ARRAY_ITEMS = 32;
export const MAX_INTEGRATION_CONFIG_BYTES = 4096;

/** Lowercase event-kind token, e.g. `workflow_run.failed`. */
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const integrationEventKindSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_INTEGRATION_EVENT_KIND_CHARS)
	.regex(EVENT_KIND_PATTERN, "lowercase event kind token required");

/** Environment token, e.g. `production` or `staging-eu`. */
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const integrationEnvironmentSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_INTEGRATION_ENVIRONMENT_CHARS)
	.regex(ENVIRONMENT_PATTERN, "environment token required");

/** A git branch name; the platform never rewrites an authored identifier. */
export const integrationBaseBranchSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_INTEGRATION_BASE_BRANCH_CHARS)
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
		"base branch must not start with punctuation or contain spaces",
	)
	.refine(
		(value) => !value.includes("//") && !value.endsWith("/"),
		"base branch must not contain repeated or trailing slashes",
	);

function isBoundedConfigValue(
	value: unknown,
	depth: number,
	state: { keys: number },
	seen: WeakSet<object>,
): boolean {
	if (depth > MAX_INTEGRATION_CONFIG_DEPTH) return false;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") {
		return (
			value.length <= MAX_INTEGRATION_CONFIG_STRING_CHARS &&
			!value.includes("\u0000")
		);
	}
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		return (
			value.length <= MAX_INTEGRATION_CONFIG_ARRAY_ITEMS &&
			value.every((entry) =>
				isBoundedConfigValue(entry, depth + 1, state, seen),
			)
		);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const entries = Object.entries(value);
	state.keys += entries.length;
	if (state.keys > MAX_INTEGRATION_CONFIG_KEYS) return false;
	return entries.every(
		([key, entry]) =>
			key.length > 0 &&
			key.length <= MAX_INTEGRATION_EVENT_KIND_CHARS &&
			isBoundedConfigValue(entry, depth + 1, state, seen),
	);
}

/** Config is a bounded JSON object; no arrays, class instances or cycles. */
export const integrationConfigSchema = z
	.record(z.string(), z.unknown())
	.superRefine((value, context) => {
		if (Array.isArray(value)) {
			context.addIssue({ code: "custom", message: "config must be an object" });
			return;
		}
		const state = { keys: 0 };
		if (!isBoundedConfigValue(value, 0, state, new WeakSet<object>())) {
			context.addIssue({
				code: "custom",
				message: "config exceeds the bounded JSON limits",
			});
			return;
		}
		if (JSON.stringify(value).length > MAX_INTEGRATION_CONFIG_BYTES) {
			context.addIssue({
				code: "custom",
				message: "config exceeds the serialized size limit",
			});
		}
	});
export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

function uniqueEntries(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

/**
 * The create/update payload for one trigger rule. `eventKinds: []` means "the
 * connector's default event set"; `environmentAllowlist` defaults to
 * production. Unknown keys are rejected, so a client cannot introduce a field
 * the persistence layer does not bound.
 */
export const integrationSubscriptionInputSchema = z
	.strictObject({
		connectorId: integrationConnectorIdSchema,
		displayName: connectorDisplayNameSchema,
		eventKinds: z
			.array(integrationEventKindSchema)
			.max(MAX_INTEGRATION_EVENT_KINDS)
			.default([])
			.refine(uniqueEntries, "event kinds must be unique"),
		environmentAllowlist: z
			.array(integrationEnvironmentSchema)
			.max(MAX_INTEGRATION_ENVIRONMENTS)
			.default(["production"])
			.refine(uniqueEntries, "environments must be unique"),
		minSeverity: incidentSeveritySchema.default("high"),
		repositoryId: z.uuid().nullable().default(null),
		baseBranch: integrationBaseBranchSchema.nullable().default(null),
		autonomyLevel: autonomyLevelSchema.default("A2"),
		enabled: z.boolean().default(true),
		config: integrationConfigSchema.default({}),
	})
	.strict();
export type IntegrationSubscriptionInput = z.infer<
	typeof integrationSubscriptionInputSchema
>;

/** Delivery receipt states, mirroring the `event_deliveries.status` CHECK. */
export const EVENT_DELIVERY_STATUSES = [
	"received",
	"verified",
	"rejected",
	"deduplicated",
	"task_created",
	"task_updated",
	"ignored",
] as const;
export const eventDeliveryStatusSchema = z.enum(EVENT_DELIVERY_STATUSES);
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

/** How a delivery's authenticity was established. */
export const EVENT_VERIFICATION_METHODS = [
	"provider_signature",
	"shared_hmac",
	"bridge_identity",
	"canonical_refetch",
] as const;
export const eventVerificationSchema = z.enum(EVENT_VERIFICATION_METHODS);
export type EventVerificationMethod =
	(typeof EVENT_VERIFICATION_METHODS)[number];

export const GITHUB_ACCOUNT_TYPES = ["User", "Organization"] as const;
export const githubAccountTypeSchema = z.enum(GITHUB_ACCOUNT_TYPES);
export type GitHubAccountType = (typeof GITHUB_ACCOUNT_TYPES)[number];

export const GITHUB_REPOSITORY_SELECTIONS = ["all", "selected"] as const;
export const githubRepositorySelectionSchema = z.enum(
	GITHUB_REPOSITORY_SELECTIONS,
);
export type GitHubRepositorySelection =
	(typeof GITHUB_REPOSITORY_SELECTIONS)[number];

export const GITHUB_INSTALLATION_STATUSES = [
	"active",
	"suspended",
	"revoked",
] as const;
export const githubInstallationStatusSchema = z.enum(
	GITHUB_INSTALLATION_STATUSES,
);
export type GitHubInstallationStatus =
	(typeof GITHUB_INSTALLATION_STATUSES)[number];

const INSTALLATION_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

/**
 * Client-safe summary of one GitHub App installation. The numeric installation
 * id stays a string so a bigint never loses precision; no token, JWT or
 * private key field exists here.
 */
export const githubInstallationSummarySchema = z
	.strictObject({
		id: z.uuid(),
		organizationId: z.uuid(),
		installationId: z
			.string()
			.regex(INSTALLATION_ID_PATTERN, "numeric installation id required"),
		accountLogin: z.string().trim().min(1).max(100),
		accountType: githubAccountTypeSchema,
		repositorySelection: githubRepositorySelectionSchema,
		status: githubInstallationStatusSchema,
		createdBy: z.uuid().nullable(),
		createdAt: z.iso.datetime({ offset: true }),
		updatedAt: z.iso.datetime({ offset: true }),
	})
	.strict();
export type GitHubInstallationSummary = z.infer<
	typeof githubInstallationSummarySchema
>;
