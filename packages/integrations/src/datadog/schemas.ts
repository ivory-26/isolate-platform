import { z } from "zod";

/**
 * Validation boundary for the Datadog connector
 * (`docs/connectors/datadog.md` §4–§5).
 *
 * Datadog signs nothing at the body level. The inbound webhook is an
 * operator-pinned JSON template; the platform accepts it only through the
 * strict schema below. A native Datadog event body (an alert re-fetched by the
 * bridge or forwarded raw) is parsed by a second, defensive schema that
 * **drops** unknown fields and never models `body`, `text`, `message`, notes or
 * responder data.
 *
 * Request bodies are strict objects built by trusted templates. Response
 * schemas are allowlists: unknown provider fields are stripped, every array
 * and string is bounded, and log/monitor/incident message bodies are not
 * modelled at all.
 */

/** Platform default for a webhook body; the receiver refuses before JSON. */
export const MAX_DATADOG_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_DATADOG_TAGS = 100;
export const MAX_DATADOG_TAG_CHARS = 200;
export const MAX_DATADOG_TAGS_TEXT_CHARS = 4000;
export const MAX_DATADOG_TITLE_CHARS = 2000;
export const MAX_DATADOG_URL_CHARS = 2048;
export const MAX_DATADOG_SERVICE_CHARS = 128;
export const MAX_DATADOG_ORG_CHARS = 128;
export const MAX_DATADOG_METRIC_SERIES = 3;
export const MAX_DATADOG_METRIC_RESPONSE_SERIES = 10;
export const MAX_DATADOG_METRIC_POINTS = 20;
export const MAX_DATADOG_METRIC_RESPONSE_POINTS = 1000;
export const MAX_DATADOG_LOG_ENTRIES = 20;
export const MAX_DATADOG_LOG_RESPONSE_ENTRIES = 100;
export const MAX_DATADOG_LOG_ATTRIBUTE_KEYS = 50;
export const MAX_DATADOG_LOG_ATTRIBUTE_VALUE_CHARS = 500;
export const MAX_DATADOG_QUERY_CHARS = 500;

/** Alert/monitor ids are numeric, UUID-shaped or opaque tokens. */
export const DATADOG_ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Datadog resource ids (incidents, monitors) never contain path syntax. */
export const DATADOG_INCIDENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
export const DATADOG_MONITOR_ID_PATTERN = /^[0-9]{1,20}$/;
/**
 * Service identifiers are interpolated into metric/log templates. A service
 * that does not match this pattern is rejected, so payload text cannot add a
 * query clause.
 */
export const DATADOG_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export const DATADOG_PRIORITIES = ["P1", "P2", "P3", "P4", "P5"] as const;
export type DatadogPriority = (typeof DATADOG_PRIORITIES)[number];

/** `P1`..`P5`, case-insensitive; anything else is rejected. */
export const datadogPrioritySchema = z
	.string()
	.regex(/^[Pp][1-5]$/)
	.transform((value) => value.toUpperCase())
	.pipe(z.enum(DATADOG_PRIORITIES));

const tagSchema = z.string().min(1).max(MAX_DATADOG_TAG_CHARS);
const tagListSchema = z.array(tagSchema).max(MAX_DATADOG_TAGS);
/**
 * The webhook template emits tags as one comma-separated string; monitor and
 * event responses emit an array. Both normalize to a bounded string array.
 */
const tagTextSchema = z
	.string()
	.max(MAX_DATADOG_TAGS_TEXT_CHARS)
	.transform((value) =>
		value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag.length > 0),
	)
	.pipe(tagListSchema);

export const datadogTagsSchema = z.union([tagListSchema, tagTextSchema]);
export type DatadogTags = z.output<typeof datadogTagsSchema>;

const alertIdSchema = z.union([
	z.string().regex(DATADOG_ALERT_ID_PATTERN),
	z
		.number()
		.int()
		.nonnegative()
		.max(Number.MAX_SAFE_INTEGER)
		.transform((value) => String(value)),
]);

const monitorIdSchema = z.union([
	z.string().regex(DATADOG_MONITOR_ID_PATTERN),
	z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.transform((value) => String(value)),
]);

/** Epoch seconds or an ISO instant, from a template value or a raw event. */
const epochSecondsSchema = z.union([
	z.number().int().nonnegative().max(4_102_444_800),
	z
		.string()
		.regex(/^[0-9]{13}$/)
		.transform((value) => Math.floor(Number(value) / 1000)),
	z
		.string()
		.regex(/^[0-9]{1,10}$/)
		.transform((value) => Number(value)),
	z.iso
		.datetime({ offset: true })
		.transform((value) => Math.floor(Date.parse(value) / 1000)),
]);

const orgValueSchema = z.union([
	z.string().min(1).max(MAX_DATADOG_ORG_CHARS),
	z
		.strictObject({
			id: z
				.union([
					z.string().max(64),
					z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
				])
				.optional(),
			name: z.string().min(1).max(MAX_DATADOG_ORG_CHARS).optional(),
		})
		.refine(
			(value) => value.id !== undefined || value.name !== undefined,
			"org requires an id or a name",
		),
]);

export type DatadogOrgValue = z.output<typeof orgValueSchema>;

/**
 * Operator-pinned webhook template (`docs/connectors/datadog.md` §4). Unknown
 * fields are rejected: a delivery that carries an extra free-form body, a
 * token, a dashboard blob or a responder list must not be accepted as this
 * template.
 */
export const datadogWebhookAlertSchema = z
	.strictObject({
		id: alertIdSchema,
		title: z.string().min(1).max(MAX_DATADOG_TITLE_CHARS),
		priority: datadogPrioritySchema.optional(),
		alert_type: z.string().min(1).max(64).optional(),
		alert_transition: z.string().min(1).max(64).optional(),
		date_happened: epochSecondsSchema,
		tags: datadogTagsSchema.optional(),
		url: z.string().max(MAX_DATADOG_URL_CHARS).optional(),
		dashboard_url: z.string().max(MAX_DATADOG_URL_CHARS).optional(),
		org: orgValueSchema,
		/** Optional aliases when the template pins `$MONITOR_ID`/`$INCIDENT_ID`. */
		monitor_id: monitorIdSchema.optional(),
		incident_id: z.string().regex(DATADOG_INCIDENT_ID_PATTERN).optional(),
	})
	.strict();

export type DatadogWebhookAlertPayload = z.output<
	typeof datadogWebhookAlertSchema
>;

/**
 * Native Datadog alert/event body. Allowlist, not strict: the provider grows
 * fields over time. `text`, `body`, `message`, notes and responder objects are
 * deliberately absent, so they are dropped before normalization can see them.
 */
export const datadogRawAlertSchema = z.object({
	id: alertIdSchema,
	title: z.string().min(1).max(MAX_DATADOG_TITLE_CHARS),
	priority: datadogPrioritySchema.optional(),
	alert_type: z.string().min(1).max(64).optional(),
	alert_transition: z.string().min(1).max(64).optional(),
	date_happened: epochSecondsSchema.optional(),
	tags: datadogTagsSchema.optional(),
	url: z.string().max(MAX_DATADOG_URL_CHARS).optional(),
	dashboard_url: z.string().max(MAX_DATADOG_URL_CHARS).optional(),
	org: orgValueSchema.optional(),
	monitor_id: monitorIdSchema.optional(),
	incident_id: z.string().regex(DATADOG_INCIDENT_ID_PATTERN).optional(),
	event_type: z.string().min(1).max(64).optional(),
	source_type_name: z.string().min(1).max(64).optional(),
});

export type DatadogRawAlertPayload = z.output<typeof datadogRawAlertSchema>;

/** Provider-neutral bounded view consumed by `normalize.ts`. */
export type DatadogWebhookAlert = {
	id: string;
	title: string;
	priority: DatadogPriority | null;
	alertType: string | null;
	alertTransition: string | null;
	dateHappenedMs: number | null;
	tags: string[];
	url: string | null;
	dashboardUrl: string | null;
	org: string | null;
	monitorId: string | null;
	incidentId: string | null;
};

function orgText(value: DatadogOrgValue | undefined): string | null {
	if (value === undefined) return null;
	if (typeof value === "string") return value;
	if (value.name !== undefined) return value.name;
	return value.id === undefined ? null : String(value.id);
}

function fromTemplate(value: DatadogWebhookAlertPayload): DatadogWebhookAlert {
	return {
		id: value.id,
		title: value.title,
		priority: value.priority ?? null,
		alertType: value.alert_type ?? null,
		alertTransition: value.alert_transition ?? null,
		dateHappenedMs:
			value.date_happened === undefined ? null : value.date_happened * 1000,
		tags: value.tags ?? [],
		url: value.url ?? null,
		dashboardUrl: value.dashboard_url ?? null,
		org: orgText(value.org),
		monitorId: value.monitor_id ?? null,
		incidentId: value.incident_id ?? null,
	};
}

function fromRaw(value: DatadogRawAlertPayload): DatadogWebhookAlert {
	return {
		id: value.id,
		title: value.title,
		priority: value.priority ?? null,
		alertType: value.alert_type ?? null,
		alertTransition: value.alert_transition ?? null,
		dateHappenedMs:
			value.date_happened === undefined ? null : value.date_happened * 1000,
		tags: value.tags ?? [],
		url: value.url ?? null,
		dashboardUrl: value.dashboard_url ?? null,
		org: orgText(value.org),
		monitorId: value.monitor_id ?? null,
		incidentId: value.incident_id ?? null,
	};
}

/**
 * Parses a webhook body or a raw alert body.
 *
 * A body carrying `org` is template-shaped: it must satisfy the strict schema
 * exactly, so an unknown field rejects the whole delivery. A body without
 * `org` is treated as a native event and parsed defensively. Both paths reject
 * an oversized string, a missing id/title, or a non-object.
 */
export function parseDatadogWebhookAlert(
	input: unknown,
): DatadogWebhookAlert | null {
	let value = input;
	if (typeof value === "string") {
		if (value.length > MAX_DATADOG_WEBHOOK_BODY_BYTES) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const templateShaped = record.org !== undefined && record.org !== null;
	if (templateShaped) {
		const parsed = datadogWebhookAlertSchema.safeParse(value);
		return parsed.success ? fromTemplate(parsed.data) : null;
	}
	const parsed = datadogRawAlertSchema.safeParse(value);
	return parsed.success ? fromRaw(parsed.data) : null;
}

/** One trusted-code metrics v2 query; `query` comes from a fixed template. */
export const datadogMetricQuerySchema = z
	.strictObject({
		name: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/),
		data_source: z.literal("metrics"),
		query: z.string().min(1).max(MAX_DATADOG_QUERY_CHARS),
	})
	.strict();

export const datadogMetricsQueryRequestSchema = z
	.strictObject({
		data: z
			.strictObject({
				type: z.literal("timeseries_request"),
				attributes: z
					.strictObject({
						from: z.number().int().nonnegative(),
						to: z.number().int().nonnegative(),
						queries: z
							.array(datadogMetricQuerySchema)
							.min(1)
							.max(MAX_DATADOG_METRIC_SERIES),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

export type DatadogMetricsQueryRequest = z.output<
	typeof datadogMetricsQueryRequestSchema
>;

const metricPointSchema = z.tuple([
	z.number().finite(),
	z.number().finite().nullable(),
]);

export const datadogMetricSeriesSchema = z.object({
	query_index: z.number().int().min(0).max(2).optional(),
	aggr: z.string().max(32).optional(),
	scope: z.string().max(512).optional(),
	tag_set: z.array(z.string().max(MAX_DATADOG_TAG_CHARS)).max(50).optional(),
	pointlist: z
		.array(metricPointSchema)
		.max(MAX_DATADOG_METRIC_RESPONSE_POINTS)
		.optional(),
	times: z
		.array(z.number().finite())
		.max(MAX_DATADOG_METRIC_RESPONSE_POINTS)
		.optional(),
	values: z
		.array(z.number().finite().nullable())
		.max(MAX_DATADOG_METRIC_RESPONSE_POINTS)
		.optional(),
	interval: z.number().int().nonnegative().max(86_400_000).optional(),
});

export type DatadogMetricSeries = z.output<typeof datadogMetricSeriesSchema>;

export const datadogMetricsQueryResponseSchema = z.object({
	data: z
		.object({
			id: z.string().max(64).optional(),
			type: z.string().max(64).optional(),
			attributes: z
				.object({
					series: z
						.array(datadogMetricSeriesSchema)
						.max(MAX_DATADOG_METRIC_RESPONSE_SERIES)
						.optional(),
					times: z
						.array(z.number().finite())
						.max(MAX_DATADOG_METRIC_RESPONSE_POINTS)
						.optional(),
					values: z
						.array(z.number().finite().nullable())
						.max(MAX_DATADOG_METRIC_RESPONSE_POINTS)
						.optional(),
					query: z.string().max(MAX_DATADOG_QUERY_CHARS).optional(),
				})
				.optional(),
		})
		.optional(),
	errors: z.array(z.string().max(500)).max(10).optional(),
});

export type DatadogMetricsQueryResponse = z.output<
	typeof datadogMetricsQueryResponseSchema
>;

/** Log search request. Message bodies are never requested or selected. */
export const datadogLogsSearchRequestSchema = z
	.strictObject({
		filter: z
			.strictObject({
				query: z.string().min(1).max(MAX_DATADOG_QUERY_CHARS),
				from: z.iso.datetime({ offset: true }),
				to: z.iso.datetime({ offset: true }),
			})
			.strict(),
		sort: z.literal("timestamp").optional(),
		page: z
			.strictObject({
				limit: z.number().int().min(1).max(MAX_DATADOG_LOG_ENTRIES),
			})
			.strict(),
	})
	.strict();

export type DatadogLogsSearchRequest = z.output<
	typeof datadogLogsSearchRequestSchema
>;

const logAttributeValueSchema = z.union([
	z.string().max(MAX_DATADOG_LOG_ATTRIBUTE_VALUE_CHARS),
	z.number().finite(),
	z.boolean(),
]);

/** Allowlisted log attributes; this is where an aggregate key may appear. */
export const datadogLogAttributesSchema = z
	.record(z.string().min(1).max(64), logAttributeValueSchema)
	.refine(
		(value) => Object.keys(value).length <= MAX_DATADOG_LOG_ATTRIBUTE_KEYS,
		`at most ${MAX_DATADOG_LOG_ATTRIBUTE_KEYS} log attributes`,
	);

export const datadogLogEntrySchema = z.object({
	id: z.string().max(128).optional(),
	type: z.string().max(32).optional(),
	attributes: z
		.object({
			timestamp: z.string().max(64).optional(),
			status: z.string().max(32).optional(),
			service: z.string().max(MAX_DATADOG_SERVICE_CHARS).optional(),
			attributes: datadogLogAttributesSchema.optional(),
			tags: z.array(z.string().max(MAX_DATADOG_TAG_CHARS)).max(50).optional(),
		})
		.optional(),
});

export type DatadogLogEntry = z.output<typeof datadogLogEntrySchema>;

/**
 * `POST /api/v2/logs/events/search` response. `message` is intentionally not
 * modelled: the aggregate reader counts status classes and error kinds only.
 */
export const datadogLogsSearchResponseSchema = z.object({
	data: z
		.array(datadogLogEntrySchema)
		.max(MAX_DATADOG_LOG_RESPONSE_ENTRIES)
		.optional(),
	meta: z
		.object({
			page: z
				.object({ after: z.string().max(256).nullable().optional() })
				.optional(),
			elapsed: z.number().nonnegative().optional(),
		})
		.optional(),
	errors: z.array(z.string().max(500)).max(10).optional(),
});

export type DatadogLogsSearchResponse = z.output<
	typeof datadogLogsSearchResponseSchema
>;

/** `GET /api/v2/incidents/{id}`. Notes, responders and fields are dropped. */
export const datadogIncidentSchema = z.object({
	data: z.object({
		id: z.string().regex(DATADOG_INCIDENT_ID_PATTERN),
		type: z.string().max(32).optional(),
		attributes: z.object({
			title: z.string().min(1).max(512),
			severity: z.string().max(32).optional(),
			state: z.string().max(32).optional(),
			created: z.iso.datetime({ offset: true }).optional(),
			modified: z.iso.datetime({ offset: true }).optional(),
			customer_impact_scope: z.string().max(4000).nullable().optional(),
			customer_impacted: z.boolean().optional(),
		}),
	}),
});

export type DatadogIncident = z.output<typeof datadogIncidentSchema>;

/** `GET /api/v1/monitor/{id}`. The full `message` and `options` are dropped. */
export const datadogMonitorSchema = z.object({
	id: z.union([
		z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		z.string().regex(DATADOG_MONITOR_ID_PATTERN),
	]),
	name: z.string().min(1).max(512),
	type: z.string().max(64).optional(),
	overall_state: z.string().max(32).optional(),
	created: z.string().max(64).optional(),
	modified: z.string().max(64).optional(),
	tags: z.array(z.string().max(MAX_DATADOG_TAG_CHARS)).max(100).optional(),
	priority: z.number().int().min(1).max(5).nullable().optional(),
});

export type DatadogMonitor = z.output<typeof datadogMonitorSchema>;
