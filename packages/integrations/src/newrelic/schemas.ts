import { z } from "zod";

/**
 * Validation boundary for the New Relic connector
 * (`docs/connectors/newrelic.md` §4–§5).
 *
 * Two kinds of schema live here:
 *
 * - **Inbound webhook payloads** are `strictObject`s: the operator is required
 *   to pin a workflow notification template, so an unknown field is a
 *   template/operator defect and must be rejected before normalization.
 * - **NerdGraph responses** are bounded allowlists. New Relic adds fields over
 *   time, so every schema requests exactly the fields the reader consumes and
 *   rejects anything else; a drift is dropped evidence (`truncated`), never
 *   forwarded provider text.
 *
 * Nothing here accepts an endpoint, account id from the body, credential,
 * raw log row or arbitrary NRQL string. Those are trusted-code inputs.
 */

/** Platform default for a webhook body; the receiver refuses before JSON. */
export const NEWRELIC_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** At most this many impacted entities are carried from one issue. */
export const NEWRELIC_MAX_IMPACTED_ENTITIES = 10;
export const NEWRELIC_MAX_ENTITY_TAGS = 20;
export const NEWRELIC_MAX_TAG_VALUES = 8;
export const NEWRELIC_MAX_TAG_KEY_CHARS = 64;
export const NEWRELIC_MAX_TAG_VALUE_CHARS = 200;
export const NEWRELIC_MAX_TITLE_CHARS = 200;
export const NEWRELIC_MAX_NAME_CHARS = 200;
export const NEWRELIC_MAX_ISSUE_ID_CHARS = 160;
export const NEWRELIC_MAX_URL_CHARS = 512;
export const NEWRELIC_MAX_PRIORITY_CHARS = 16;
export const NEWRELIC_MAX_STATE_CHARS = 16;

/** Issue ids are opaque vendor text; keep them printable and bounded. */
export const NEWRELIC_ISSUE_ID_PATTERN = /^[A-Za-z0-9._:/=+-]{1,160}$/;
/** NerdGraph entity GUIDs are base64-ish and may contain `+`, `/` and `=`. */
export const NEWRELIC_ENTITY_GUID_PATTERN = /^[A-Za-z0-9+/=_-]{1,200}$/;
/** Account ids are configuration, never payload text. */
export const NEWRELIC_ACCOUNT_ID_PATTERN = /^[1-9][0-9]{0,11}$/;

/** New Relic issue priorities; case-insensitive on the wire. */
export const NEWRELIC_PRIORITIES = [
	"CRITICAL",
	"HIGH",
	"MEDIUM",
	"LOW",
	"INFO",
] as const;
export const newRelicPrioritySchema = z.enum(NEWRELIC_PRIORITIES);
export type NewRelicPriority = z.infer<typeof newRelicPrioritySchema>;

/** Issue lifecycle states; only `ACTIVATED` opens a task. */
export const NEWRELIC_ISSUE_STATES = [
	"ACTIVATED",
	"ACKNOWLEDGED",
	"CLOSED",
] as const;
export const newRelicIssueStateSchema = z.enum(NEWRELIC_ISSUE_STATES);
export type NewRelicIssueState = z.infer<typeof newRelicIssueStateSchema>;

/** Untrusted entity tags from the pinned workflow template. */
export const newRelicEntityTagSchema = z
	.strictObject({
		key: z.string().trim().min(1).max(NEWRELIC_MAX_TAG_KEY_CHARS),
		values: z
			.array(z.string().max(NEWRELIC_MAX_TAG_VALUE_CHARS))
			.max(NEWRELIC_MAX_TAG_VALUES),
	})
	.strict();

export const newRelicEntityTagListSchema = z
	.array(newRelicEntityTagSchema)
	.max(NEWRELIC_MAX_ENTITY_TAGS);

const entityIdSchema = z
	.union([
		z.string().trim().min(1).max(NEWRELIC_MAX_ISSUE_ID_CHARS),
		z.number().int().nonnegative().safe(),
	])
	.transform((value) => String(value));

/**
 * One entity as carried by the pinned workflow payload. `guid` is optional
 * because templates differ; `id`, `name` and `tags` are the fields the
 * normalizer may use. Unknown entity fields are rejected with the rest of the
 * payload.
 */
export const newRelicImpactedEntitySchema = z
	.strictObject({
		id: entityIdSchema.optional(),
		guid: z.string().regex(NEWRELIC_ENTITY_GUID_PATTERN).optional(),
		name: z.string().trim().min(1).max(NEWRELIC_MAX_NAME_CHARS),
		type: z.string().trim().min(1).max(64).optional(),
		tags: newRelicEntityTagListSchema.optional(),
	})
	.strict();

export type NewRelicImpactedEntity = z.output<
	typeof newRelicImpactedEntitySchema
>;

/**
 * Pinned workflow payload (`docs/connectors/newrelic.md` §4). Strict: an
 * unknown field, an extra account id, or a reshaped template is rejected
 * before any normalization. `accountId` is deliberately absent.
 */
export const newRelicAlertPayloadSchema = z
	.strictObject({
		id: z.string().trim().min(1).max(NEWRELIC_MAX_ISSUE_ID_CHARS),
		issueUrl: z.string().max(NEWRELIC_MAX_URL_CHARS),
		title: z.string().trim().min(1).max(NEWRELIC_MAX_TITLE_CHARS),
		priority: z
			.string()
			.trim()
			.min(1)
			.max(NEWRELIC_MAX_PRIORITY_CHARS)
			.transform((value) => value.toUpperCase())
			.pipe(newRelicPrioritySchema),
		state: z
			.string()
			.trim()
			.min(1)
			.max(NEWRELIC_MAX_STATE_CHARS)
			.transform((value) => value.toUpperCase())
			.pipe(newRelicIssueStateSchema),
		createdAt: z.iso.datetime({ offset: true }),
		impactedEntities: z
			.array(newRelicImpactedEntitySchema)
			.min(1)
			.max(NEWRELIC_MAX_IMPACTED_ENTITIES),
		policyName: z.string().trim().min(1).max(NEWRELIC_MAX_NAME_CHARS),
		conditionName: z.string().trim().min(1).max(NEWRELIC_MAX_NAME_CHARS),
	})
	.strict();

export type NewRelicAlertPayload = z.output<typeof newRelicAlertPayloadSchema>;

/** Bounded JSON helper for a bridge that forwards the raw body as text. */
export function parseNewRelicAlertPayload(
	input: unknown,
): NewRelicAlertPayload | null {
	let value = input;
	if (typeof value === "string") {
		if (
			new TextEncoder().encode(value).byteLength >
			NEWRELIC_WEBHOOK_MAX_BODY_BYTES
		) {
			return null;
		}
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const parsed = newRelicAlertPayloadSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * NerdGraph entity fields the reader consumes. `accountId` is requested so a
 * GUID from another account can be rejected (`NOT_FOUND`), never mixed in.
 */
export const newRelicEntitySchema = z
	.strictObject({
		guid: z.string().regex(NEWRELIC_ENTITY_GUID_PATTERN),
		accountId: z
			.union([
				z.number().int().nonnegative().safe(),
				z.string().regex(NEWRELIC_ACCOUNT_ID_PATTERN),
			])
			.optional(),
		name: z.string().trim().min(1).max(NEWRELIC_MAX_NAME_CHARS),
		type: z.string().max(64).nullable().optional(),
		domain: z.string().max(64).nullable().optional(),
		alertSeverity: z.string().max(32).nullable().optional(),
		reporting: z.boolean().nullable().optional(),
		tags: newRelicEntityTagListSchema.nullable().optional(),
	})
	.strict();

export type NewRelicEntity = z.output<typeof newRelicEntitySchema>;

/** `actor.entity(guid: …)`. */
export const newRelicEntityDataSchema = z
	.strictObject({
		actor: z
			.strictObject({
				entity: newRelicEntitySchema.nullable(),
			})
			.strict(),
	})
	.strict();

export const NEWRELIC_MAX_SEARCH_ENTITIES = 10;

/** `actor.entitySearch(query: …)`; the first page only, no cursor. */
export const newRelicEntitySearchDataSchema = z
	.strictObject({
		actor: z
			.strictObject({
				entitySearch: z
					.strictObject({
						count: z.number().int().nonnegative().optional(),
						results: z
							.strictObject({
								entities: z
									.array(newRelicEntitySchema)
									.max(NEWRELIC_MAX_SEARCH_ENTITIES),
							})
							.strict(),
					})
					.strict()
					.nullable(),
			})
			.strict(),
	})
	.strict();

/** One NRQL aggregate cell; no arrays, objects or raw event rows. */
const newRelicNrqlCellSchema = z.union([
	z.string().max(512),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);

export const NEWRELIC_MAX_NRQL_ROWS = 20;
export const NEWRELIC_MAX_NRQL_COLUMNS = 20;

export const newRelicNrqlRowSchema = z
	.record(z.string().min(1).max(120), newRelicNrqlCellSchema)
	.refine((value) => Object.keys(value).length <= NEWRELIC_MAX_NRQL_COLUMNS, {
		message: `at most ${NEWRELIC_MAX_NRQL_COLUMNS} columns`,
	});

export type NewRelicNrqlRow = z.output<typeof newRelicNrqlRowSchema>;

/** `actor.account(id: N) { nrql(query: …) { results } }`. */
export const newRelicNrqlDataSchema = z
	.strictObject({
		actor: z
			.strictObject({
				account: z
					.strictObject({
						nrql: z
							.strictObject({
								results: z
									.array(newRelicNrqlRowSchema)
									.max(NEWRELIC_MAX_NRQL_ROWS),
							})
							.strict()
							.nullable(),
					})
					.strict()
					.nullable(),
			})
			.strict(),
	})
	.strict();

export const NEWRELIC_MAX_ALERT_POLICIES = 25;

export const newRelicAlertPolicySchema = z
	.strictObject({
		id: z
			.union([z.string().trim().min(1).max(64), z.number().int().nonnegative()])
			.transform((value) => String(value)),
		name: z.string().trim().min(1).max(NEWRELIC_MAX_NAME_CHARS),
	})
	.strict();

export type NewRelicAlertPolicy = z.output<typeof newRelicAlertPolicySchema>;

export const newRelicAlertPoliciesDataSchema = z
	.strictObject({
		actor: z
			.strictObject({
				account: z
					.strictObject({
						alerts: z
							.strictObject({
								policies: z
									.array(newRelicAlertPolicySchema)
									.max(NEWRELIC_MAX_ALERT_POLICIES),
							})
							.strict(),
					})
					.strict()
					.nullable(),
			})
			.strict(),
	})
	.strict();

/**
 * NerdGraph envelope. New Relic returns `{ data }` on success and
 * `{ errors, data }` on a GraphQL failure; `extensions` is not accepted, so a
 * drifted error envelope degrades instead of leaking provider text.
 */
export const nerdGraphResponseSchema = z
	.strictObject({
		data: z.unknown().optional(),
		errors: z
			.array(
				z
					.strictObject({
						message: z.string().max(300).optional(),
					})
					.strict(),
			)
			.max(5)
			.optional(),
	})
	.strict();

export type NerdGraphResponse = z.output<typeof nerdGraphResponseSchema>;
