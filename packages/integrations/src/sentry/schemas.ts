import { z } from "zod";

/**
 * Validation boundary for every Sentry payload this connector reads.
 *
 * Provider envelopes carry many undocumented fields. These schemas use Zod's
 * default strip mode, so unknown keys are dropped at parse time and can never
 * be forwarded; nothing here uses `.passthrough()`. Tool inputs, which are
 * model-authored, are strict objects instead.
 */

export const SENTRY_LEVELS = [
	"fatal",
	"error",
	"warning",
	"info",
	"debug",
] as const;
export const sentryLevelSchema = z.enum(SENTRY_LEVELS);
export type SentryLevel = z.infer<typeof sentryLevelSchema>;

/** Issue webhook actions Sentry documents; only some are incidents. */
export const SENTRY_ISSUE_ACTIONS = [
	"created",
	"resolved",
	"assigned",
	"archived",
	"unresolved",
] as const;
export const sentryIssueActionSchema = z.enum(SENTRY_ISSUE_ACTIONS);

/** Sentry ids are numeric strings in webhooks and numbers in some APIs. */
export const sentryIdSchema = z
	.union([
		z.string().trim().min(1).max(64),
		z.number().int().nonnegative().safe(),
	])
	.transform((value) => String(value));

export const SENTRY_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const sentrySlugSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(SENTRY_SLUG_PATTERN, "invalid sentry slug");

export const SENTRY_ISSUE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const sentryIssueIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(SENTRY_ISSUE_ID_PATTERN, "invalid sentry issue id");

const providerDateSchema = z.string().max(64).nullable().optional();
const providerCountSchema = z
	.union([
		z.number().min(0).max(1_000_000_000_000),
		z.string().regex(/^\d{1,13}$/),
	])
	.transform((value) => Number(value))
	.optional();

export const sentryProjectSchema = z.object({
	id: sentryIdSchema.optional(),
	slug: sentrySlugSchema.optional(),
	name: z.string().max(128).nullable().optional(),
});

export const sentryMetadataSchema = z.object({
	value: z.string().max(2000).nullable().optional(),
	type: z.string().max(100).nullable().optional(),
	filename: z.string().max(300).nullable().optional(),
	function: z.string().max(200).nullable().optional(),
});

export const sentryIssueResourceSchema = z.object({
	id: sentryIdSchema,
	shortId: z.string().max(64).nullable().optional(),
	title: z.string().max(256).nullable().optional(),
	culprit: z.string().max(512).nullable().optional(),
	permalink: z.string().max(512).nullable().optional(),
	level: sentryLevelSchema.nullable().optional(),
	status: z.string().max(64).nullable().optional(),
	firstSeen: providerDateSchema,
	lastSeen: providerDateSchema,
	count: providerCountSchema,
	metadata: sentryMetadataSchema.nullable().optional(),
	project: sentryProjectSchema.nullable().optional(),
});

/** `POST` issue webhook: organization and project both appear at top level. */
export const sentryIssueWebhookSchema = z.object({
	action: z.string().trim().min(1).max(64),
	issue: sentryIssueResourceSchema,
	organization: z
		.object({
			id: sentryIdSchema.optional(),
			slug: sentrySlugSchema.optional(),
		})
		.optional(),
	project: sentryProjectSchema.optional(),
});

export const sentryIssueListSchema = z.array(sentryIssueResourceSchema).max(25);

/** Issue endpoints return the same bounded shape as the webhook resource. */
export const sentryIssueResponseSchema = sentryIssueResourceSchema;

export const sentryFrameSchema = z.object({
	filename: z.string().max(512).nullable().optional(),
	function: z.string().max(200).nullable().optional(),
	module: z.string().max(300).nullable().optional(),
	package: z.string().max(300).nullable().optional(),
	lineNo: z.number().int().nonnegative().nullable().optional(),
	colNo: z.number().int().nonnegative().nullable().optional(),
	inApp: z.boolean().nullable().optional(),
});

export const sentryExceptionValueSchema = z.object({
	type: z.string().max(200).nullable().optional(),
	value: z.string().max(4000).nullable().optional(),
	stacktrace: z
		.object({ frames: z.array(sentryFrameSchema).max(200).optional() })
		.nullable()
		.optional(),
});

const sentryTagSchema = z.object({
	key: z.string().max(100),
	value: z
		.union([z.string().max(500), z.number(), z.boolean()])
		.transform((value) => String(value)),
});

export const sentryEventResponseSchema = z.object({
	eventID: z.string().min(1).max(64),
	message: z.string().max(4000).nullable().optional(),
	title: z.string().max(512).nullable().optional(),
	culprit: z.string().max(512).nullable().optional(),
	level: sentryLevelSchema.nullable().optional(),
	release: z
		.object({ version: z.string().max(200).optional() })
		.nullable()
		.optional(),
	tags: z.array(sentryTagSchema).max(100).optional(),
	entries: z
		.array(
			z.object({
				type: z.string().max(64),
				data: z
					.object({
						values: z.array(sentryExceptionValueSchema).max(20).optional(),
					})
					.optional(),
			}),
		)
		.max(50)
		.optional(),
});

export const sentryReleaseResponseSchema = z.object({
	version: z.string().trim().min(1).max(200),
	dateCreated: providerDateSchema,
	dateReleased: providerDateSchema,
	lastEvent: providerDateSchema,
	projects: z
		.array(
			z.object({
				slug: sentrySlugSchema.optional(),
				name: z.string().max(128).nullable().optional(),
			}),
		)
		.max(50)
		.optional(),
});

export const sentryDeploySchema = z.object({
	environment: z.string().max(100).nullable().optional(),
	name: z.string().max(200).nullable().optional(),
	url: z.string().max(512).nullable().optional(),
	dateStarted: providerDateSchema,
	dateFinished: providerDateSchema,
});

export const sentryDeploysResponseSchema = z.array(sentryDeploySchema).max(20);

const SENTRY_QUERY_PATTERN = /^[A-Za-z0-9 .:_/-]{1,200}$/;

export const sentryListIssuesInputSchema = z.strictObject({
	orgSlug: sentrySlugSchema,
	projectSlug: sentrySlugSchema.optional(),
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(SENTRY_QUERY_PATTERN, "invalid sentry search query")
		.optional(),
	limit: z.number().int().min(1).max(25).optional(),
});

export const sentryGetIssueInputSchema = z.strictObject({
	orgSlug: sentrySlugSchema,
	issueId: sentryIssueIdSchema,
});

export const sentryLatestEventInputSchema = z.strictObject({
	orgSlug: sentrySlugSchema,
	issueId: sentryIssueIdSchema,
});

export type SentryIssueWebhookPayload = z.output<
	typeof sentryIssueWebhookSchema
>;
export type SentryIssueResource = z.output<typeof sentryIssueResourceSchema>;
export type SentryEventResponse = z.output<typeof sentryEventResponseSchema>;
export type SentryReleaseResponse = z.output<
	typeof sentryReleaseResponseSchema
>;
export type SentryDeploy = z.output<typeof sentryDeploySchema>;
export type SentryListIssuesInput = z.output<
	typeof sentryListIssuesInputSchema
>;
export type SentryGetIssueInput = z.output<typeof sentryGetIssueInputSchema>;
export type SentryLatestEventInput = z.output<
	typeof sentryLatestEventInputSchema
>;
