import { z } from "zod";

/**
 * PagerDuty v3 webhook and REST v2 response schemas.
 *
 * Provider payloads carry responder PII, alert payloads and free text. These
 * schemas are therefore allowlists: unknown provider fields are *stripped*, not
 * exposed, and no schema models assignments, responders, notes, channels,
 * contact methods, emails or phone numbers. Every string is length-capped and
 * every identifier is validated against a fixed template. Our own inputs are
 * strict objects with unknown keys rejected.
 */

/** PagerDuty resource ids (`PABC123`, `PT4KHLK`, ...). */
const resourceIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
/** Event, log-entry and delivery ids may contain hyphens (`UUID`-shaped). */
const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
/** Provider URLs are display-only; output code re-checks https/no-userinfo. */
const providerUrlSchema = z.string().max(512);
const displayNameSchema = z.string().min(1).max(200);

export const PAGERDUTY_RESOURCE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
export const PAGERDUTY_OPAQUE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const pagerDutyPrioritySchema = z.object({
	id: resourceIdSchema,
	name: z.string().min(1).max(64).optional(),
	order: z.number().int().min(1).max(5).optional(),
});

export const pagerDutyEscalationPolicyReferenceSchema = z.object({
	id: resourceIdSchema,
	name: displayNameSchema.optional(),
});

export const pagerDutyServiceReferenceSchema = z.object({
	id: resourceIdSchema,
	name: displayNameSchema.optional(),
	html_url: providerUrlSchema.optional(),
	escalation_policy: pagerDutyEscalationPolicyReferenceSchema.optional(),
});

export const PAGERDUTY_INCIDENT_STATUSES = [
	"triggered",
	"acknowledged",
	"resolved",
] as const;
export const pagerDutyIncidentStatusSchema = z.enum(
	PAGERDUTY_INCIDENT_STATUSES,
);

export const pagerDutyIncidentSchema = z.object({
	id: resourceIdSchema,
	number: z.number().int().positive().max(1_000_000_000).optional(),
	status: pagerDutyIncidentStatusSchema,
	title: z.string().min(1).max(512),
	urgency: z.enum(["high", "low"]).optional(),
	priority: pagerDutyPrioritySchema.nullable().optional(),
	service: pagerDutyServiceReferenceSchema,
	created_at: isoDateTimeSchema.optional(),
	updated_at: isoDateTimeSchema.optional(),
	resolved_at: isoDateTimeSchema.nullable().optional(),
	html_url: providerUrlSchema.optional(),
	incident_key: z.string().max(512).nullable().optional(),
});

export const PAGERDUTY_EVENT_TYPES = [
	"incident.triggered",
	"incident.acknowledged",
	"incident.resolved",
	"incident.escalated",
	"incident.reassigned",
	"incident.priority_updated",
	"service.updated",
] as const;
export const pagerDutyEventTypeSchema = z.enum(PAGERDUTY_EVENT_TYPES);
export type PagerDutyEventType = z.infer<typeof pagerDutyEventTypeSchema>;

/**
 * A single-event v3 envelope. The top level is strict because batching
 * (`events[]`) is not supported in this wave; the nested provider objects are
 * allowlists because a real delivery carries agent/client metadata we must not
 * model.
 */
export const pagerDutyWebhookEnvelopeSchema = z
	.object({
		event: z.object({
			id: opaqueIdSchema,
			event_type: pagerDutyEventTypeSchema,
			resource_type: z.string().max(64).optional(),
			occurred_at: isoDateTimeSchema,
			data: pagerDutyIncidentSchema,
		}),
	})
	.strict();

export type PagerDutyWebhookEnvelope = z.infer<
	typeof pagerDutyWebhookEnvelopeSchema
>;

export const pagerDutyIncidentResponseSchema = z.object({
	incident: pagerDutyIncidentSchema,
});

export const pagerDutyIncidentListResponseSchema = z.object({
	incidents: z.array(pagerDutyIncidentSchema).max(100),
	more: z.boolean().optional(),
});

export const pagerDutyLogEntrySchema = z.object({
	id: opaqueIdSchema,
	type: z.string().min(1).max(64),
	created_at: isoDateTimeSchema,
	/** Role only (`user`, `automation`, ...); never the actor summary/name. */
	agent: z
		.object({
			type: z.string().min(1).max(64).optional(),
		})
		.optional(),
	/** Channel kind only; contact methods and addresses are not modelled. */
	channel: z
		.object({
			type: z.string().min(1).max(64).optional(),
		})
		.optional(),
});

export const pagerDutyLogEntriesResponseSchema = z.object({
	log_entries: z.array(pagerDutyLogEntrySchema).max(100),
	more: z.boolean().optional(),
	limit: z.number().int().positive().optional(),
	offset: z.number().int().nonnegative().optional(),
});

export const pagerDutyServiceResponseSchema = z.object({
	service: z.object({
		id: resourceIdSchema,
		name: displayNameSchema,
		html_url: providerUrlSchema.optional(),
		escalation_policy: pagerDutyEscalationPolicyReferenceSchema.optional(),
	}),
});

export const pagerDutyEscalationPolicyResponseSchema = z.object({
	escalation_policy: z.object({
		id: resourceIdSchema,
		name: displayNameSchema.optional(),
	}),
});

/**
 * On-call responses are modelled for completeness only. The reader never calls
 * `/oncalls`: even identifiers are responder data. Names, emails, phone numbers
 * and contact methods are deliberately absent from this schema.
 */
export const pagerDutyOnCallResponseSchema = z.object({
	oncalls: z
		.array(
			z.object({
				escalation_policy: pagerDutyEscalationPolicyReferenceSchema.optional(),
				schedule: z.object({ id: resourceIdSchema }).optional(),
				user: z.object({ id: resourceIdSchema }).optional(),
			}),
		)
		.max(100),
	more: z.boolean().optional(),
});

export const pagerDutyIncidentWriteResponseSchema = z.object({
	incident: z
		.object({
			id: resourceIdSchema,
			status: pagerDutyIncidentStatusSchema,
		})
		.optional(),
	incidents: z
		.array(
			z.object({
				id: resourceIdSchema,
				status: pagerDutyIncidentStatusSchema,
			}),
		)
		.max(1)
		.optional(),
});

export type PagerDutyIncident = z.infer<typeof pagerDutyIncidentSchema>;
export type PagerDutyLogEntry = z.infer<typeof pagerDutyLogEntrySchema>;
export type PagerDutyServiceReference = z.infer<
	typeof pagerDutyServiceReferenceSchema
>;
