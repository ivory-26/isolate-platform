import {
	contextBundleSchema,
	contextItemSchema,
	incidentSignalSchema,
	MAX_CONTEXT_ITEMS,
	MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
	MAX_INCIDENT_FINGERPRINT_CHARS,
} from "@isolate/shared";
import { z } from "zod";

/**
 * Validation boundary for the Honeycomb connector
 * (`docs/connectors/honeycomb.md` §4–§6).
 *
 * Three schema families live here.
 *
 * - **Request schemas** (query specification, tool inputs) are strict: trusted
 *   code builds them from fixed templates, and a caller cannot smuggle a
 *   calculation, filter, column, time range or URL the templates did not
 *   produce.
 * - **The trigger webhook** is strict too. Honeycomb documents the delivery
 *   envelope only loosely (the page marks field names UNVERIFIED); this module
 *   pins a provisional contract that must be replaced by one captured test
 *   fixture before the live acceptance run. Unknown fields are rejected.
 * - **Provider responses** (query result, SLO list) are allowlists: unknown
 *   fields are stripped, arrays and strings are bounded, and nothing is passed
 *   through verbatim.
 *
 * `honeycomb` is not yet a member of `INCIDENT_SOURCES`
 * (`packages/shared/src/types/incident.ts`). The two local schemas below
 * extend the shared contracts with `source: "honeycomb"` so this adapter can
 * be typechecked before the contract commit ships. Once the enum gains the
 * value, the coordinator can replace them with the shared schemas; there is no
 * cast anywhere in this module.
 */

export const HONEYCOMB_SOURCE = "honeycomb" as const;

/** Dataset slugs and trigger ids share Honeycomb's documented shape. */
export const HONEYCOMB_DATASET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const honeycombDatasetSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(HONEYCOMB_DATASET_PATTERN, "invalid honeycomb dataset slug");

export const HONEYCOMB_TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const honeycombTriggerIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(HONEYCOMB_TRIGGER_ID_PATTERN, "invalid honeycomb trigger id");

/** OTel-style service names; spaces and separators outside the set are rejected. */
export const HONEYCOMB_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const honeycombServiceSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(HONEYCOMB_SERVICE_PATTERN, "invalid honeycomb service name");

export const honeycombEnvironmentSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9._-]+$/, "invalid honeycomb environment");

/**
 * States Honeycomb uses in trigger/SLO notifications. `resolved`, `recovered`
 * and `ok` are lifecycle updates, not incidents.
 */
export const HONEYCOMB_ALERT_STATES = [
	"triggered",
	"firing",
	"critical",
	"warning",
	"ok",
	"resolved",
	"recovered",
] as const;
export const honeycombAlertStateSchema = z.enum(HONEYCOMB_ALERT_STATES);
export type HoneycombAlertState = z.infer<typeof honeycombAlertStateSchema>;

export const HONEYCOMB_TRIGGERING_STATES: ReadonlySet<HoneycombAlertState> =
	new Set(["triggered", "firing", "critical", "warning"]);

export const HONEYCOMB_THRESHOLD_OPS = [">", ">=", "<", "<="] as const;
export const honeycombThresholdSchema = z.strictObject({
	op: z.enum(HONEYCOMB_THRESHOLD_OPS),
	value: z.number().finite(),
});
export type HoneycombThreshold = z.output<typeof honeycombThresholdSchema>;

/**
 * Provisional trigger webhook envelope.
 *
 * A delivery is an incident when `trigger.state` (or `alert.state`) is one of
 * `triggered`, `firing`, `critical` or `warning`. The timestamp used for the
 * 15-minute freshness rule is `alert.timestamp`, falling back to the
 * top-level `timestamp`.
 */
export const honeycombTriggerWebhookSchema = z
	.strictObject({
		dataset: honeycombDatasetSchema,
		service: z.strictObject({ name: honeycombServiceSchema }),
		environment: honeycombEnvironmentSchema.optional(),
		trigger: z.strictObject({
			id: honeycombTriggerIdSchema,
			name: z.string().trim().min(1).max(200),
			description: z.string().max(2000).optional(),
			url: z.string().max(512).optional(),
			threshold: honeycombThresholdSchema.optional(),
			state: honeycombAlertStateSchema,
		}),
		alert: z
			.strictObject({
				id: z.string().trim().min(1).max(128).optional(),
				state: honeycombAlertStateSchema.optional(),
				timestamp: z.iso.datetime({ offset: true }).optional(),
				url: z.string().max(512).optional(),
			})
			.optional(),
		timestamp: z.iso.datetime({ offset: true }).optional(),
		result: z
			.strictObject({ value: z.number().finite().optional() })
			.optional(),
	})
	.superRefine((value, context) => {
		if ((value.alert?.timestamp ?? value.timestamp) === undefined) {
			context.addIssue({
				code: "custom",
				message: "honeycomb alert timestamp is required",
				path: ["timestamp"],
			});
		}
	});
export type HoneycombTriggerWebhookPayload = z.output<
	typeof honeycombTriggerWebhookSchema
>;

/** Trigger metadata re-read from an incident; never fetched from the API. */
export const honeycombTriggerSnapshotSchema = z.strictObject({
	id: honeycombTriggerIdSchema,
	name: z.string().trim().min(1).max(200),
	state: honeycombAlertStateSchema,
	threshold: honeycombThresholdSchema.optional(),
	observed: z.number().finite().optional(),
	url: z.string().max(512).optional(),
});
export type HoneycombTriggerSnapshot = z.output<
	typeof honeycombTriggerSnapshotSchema
>;

export const HONEYCOMB_QUERY_KINDS = [
	"latency",
	"error_rate",
	"saturation",
] as const;
export const honeycombQueryKindSchema = z.enum(HONEYCOMB_QUERY_KINDS);
export type HoneycombQueryKind = z.infer<typeof honeycombQueryKindSchema>;

export const HONEYCOMB_QUERY_MIN_WINDOW_SECONDS = 60;
export const HONEYCOMB_QUERY_MAX_WINDOW_SECONDS = 60 * 60;
export const HONEYCOMB_QUERY_MAX_ROWS = 20;
export const HONEYCOMB_QUERY_SUMMARY_MAX_CHARS = 2000;

const queryCalculationSchema = z
	.strictObject({
		op: z.enum(["P95", "COUNT", "AVG"]),
		column: z.enum(["duration_ms", "system.cpu.utilization"]).optional(),
	})
	.refine(
		(value) =>
			value.op === "COUNT"
				? value.column === undefined
				: value.column !== undefined,
		{ message: "calculation column does not match its operator" },
	);

const queryFilterSchema = z.strictObject({
	column: z.enum(["service.name", "error"]),
	op: z.enum(["=", "!="]),
	value: z.union([z.string().max(128), z.boolean()]),
});

const queryBreakdownSchema = z.enum(["http.route", "service.name"]);

/** Fixed query specification; the model never authors one of these. */
export const honeycombQueryRequestSchema = z.strictObject({
	calculations: z.array(queryCalculationSchema).min(1).max(3),
	breakdowns: z.array(queryBreakdownSchema).max(2),
	filters: z.array(queryFilterSchema).max(3),
	time_range: z
		.number()
		.int()
		.min(HONEYCOMB_QUERY_MIN_WINDOW_SECONDS)
		.max(HONEYCOMB_QUERY_MAX_WINDOW_SECONDS),
	limit: z.number().int().min(1).max(HONEYCOMB_QUERY_MAX_ROWS),
});
export type HoneycombQueryRequest = z.output<
	typeof honeycombQueryRequestSchema
>;

/** `POST /1/queries/{dataset}` returns the stored query id. */
export const honeycombQuerySpecResponseSchema = z.object({
	id: z.string().trim().min(1).max(128),
});

const boundedRecord = <T extends z.ZodType>(value: T) =>
	z
		.record(z.string().min(1).max(64), value)
		.refine((record) => Object.keys(record).length <= 20, {
			message: "at most 20 group fields",
		});

const groupValueSchema = z.union([
	z.string().max(256),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);

const querySeriesSchema = z.object({
	name: boundedRecord(groupValueSchema).optional(),
	data: z
		.array(
			boundedRecord(
				z.union([
					z.string().max(256),
					z.number().finite(),
					z.boolean(),
					z.null(),
				]),
			),
		)
		.max(100)
		.optional(),
});

/**
 * `POST/GET /1/query_results/{dataset}` response. Provider payload: unknown
 * fields are stripped, series and points are bounded, and the reader never
 * follows `links` or fetches raw spans/events.
 */
export const honeycombQueryResultSchema = z.object({
	id: z.string().trim().min(1).max(128).optional(),
	complete: z.boolean().optional(),
	data: z
		.object({
			series: z.array(querySeriesSchema).max(100).optional(),
		})
		.nullable()
		.optional(),
});
export type HoneycombQueryResult = z.output<typeof honeycombQueryResultSchema>;

/** `GET /1/slos/{dataset}`. Empty on Free; read through, not failed. */
export const honeycombSloSchema = z.object({
	id: z
		.union([
			z.string().trim().min(1).max(128),
			z.number().int().nonnegative().safe(),
		])
		.transform((value) => String(value)),
	name: z.string().trim().min(1).max(200).optional(),
	target: z.number().finite().optional(),
	/** Some API versions express the target in millionths. */
	target_per_million: z.number().finite().optional(),
	current: z.number().finite().optional(),
	status: z.string().trim().min(1).max(64).optional(),
	time_window_days: z.number().int().min(1).max(366).optional(),
});
export type HoneycombSlo = z.output<typeof honeycombSloSchema>;

export const honeycombSloListSchema = z.array(honeycombSloSchema).max(100);

export const honeycombContextInputSchema = z.strictObject({
	incidentFingerprint: z
		.string()
		.trim()
		.min(1)
		.max(MAX_INCIDENT_FINGERPRINT_CHARS),
	service: honeycombServiceSchema,
	kind: honeycombQueryKindSchema.optional(),
	windowMinutes: z.number().int().min(1).max(60).optional(),
});
export type HoneycombContextInput = z.output<
	typeof honeycombContextInputSchema
>;

/**
 * Local contract extensions until `honeycomb` joins `INCIDENT_SOURCES`.
 * Once it does, these are type-identical to the shared schemas.
 */
export const honeycombIncidentSignalSchema = incidentSignalSchema.extend({
	source: z.literal(HONEYCOMB_SOURCE),
});
export type HoneycombIncidentSignal = z.output<
	typeof honeycombIncidentSignalSchema
>;

export const honeycombContextItemSchema = z
	.strictObject({
		...contextItemSchema.shape,
		source: z.literal(HONEYCOMB_SOURCE),
	})
	.refine((item) => item.url !== undefined || item.path !== undefined, {
		message: "context item requires a url or a path",
	});
export type HoneycombContextItem = z.output<typeof honeycombContextItemSchema>;

export const honeycombContextBundleSchema = z
	.strictObject({
		...contextBundleSchema.shape,
		items: z.array(honeycombContextItemSchema).max(MAX_CONTEXT_ITEMS),
	})
	.refine(
		(bundle) =>
			new TextEncoder().encode(
				bundle.items.map((item) => item.excerpt).join(""),
			).byteLength <= MAX_CONTEXT_TOTAL_EXCERPT_BYTES,
		{ message: "total context excerpt exceeds 256 KiB" },
	);
export type HoneycombContextBundle = z.output<
	typeof honeycombContextBundleSchema
>;
