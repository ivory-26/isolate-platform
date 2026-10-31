import { z } from "zod";

/**
 * Validation boundary for the Grafana connector
 * (`docs/connectors/grafana.md` §4–§5).
 *
 * Two kinds of schema live here:
 *
 * - **Requests** (datasource query bodies) are `strictObject`s. Trusted code
 *   builds them; a caller cannot smuggle an expression, range or datasource
 *   UID that the templates did not produce.
 * - **Provider payloads** (webhook alert groups, alert-rule and datasource
 *   responses) are allowlists: unknown top-level fields are dropped, every
 *   array and string is bounded, and nothing is passed through verbatim.
 *
 * The alert-group schema is additionally `.strict()` because the webhook body
 * is an untrusted request: unknown fields are rejected before normalization.
 */

/** Platform default for a webhook body; the receiver refuses before JSON. */
export const MAX_GRAFANA_WEBHOOK_BODY_BYTES = 64 * 1024;
/** A delivery that carries more alerts than this is truncated by contract. */
export const MAX_GRAFANA_ALERTS = 64;
export const MAX_GRAFANA_LABEL_KEYS = 64;
export const MAX_GRAFANA_LABEL_KEY_CHARS = 128;
export const MAX_GRAFANA_LABEL_VALUE_CHARS = 512;
export const MAX_GRAFANA_ANNOTATION_KEYS = 32;
export const MAX_GRAFANA_ANNOTATION_VALUE_CHARS = 2048;
export const MAX_GRAFANA_VALUES_KEYS = 32;
export const MAX_GRAFANA_URL_CHARS = 2048;
export const MAX_GRAFANA_DATASOURCE_UID_CHARS = 64;
export const MAX_GRAFANA_RULE_UID_CHARS = 64;
export const MAX_GRAFANA_SERVICE_CHARS = 128;
export const MAX_GRAFANA_EXPR_CHARS = 1000;
export const MAX_GRAFANA_DATAPOINTS = 20;
export const MAX_GRAFANA_LOG_LINES = 200;

/** Grafana/Prometheus UID shape; provisioned rules and datasources. */
export const GRAFANA_UID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** `X-Grafana-Org-Id` accepts a positive integer only. */
export const GRAFANA_ORG_ID_PATTERN = /^[1-9][0-9]{0,9}$/;

function keyCountAtMost(value: Record<string, unknown>, max: number): boolean {
	return Object.keys(value).length <= max;
}

/** Alert labels are untrusted text; they are bounded, never echoed raw. */
export const grafanaLabelsSchema = z
	.record(
		z.string().min(1).max(MAX_GRAFANA_LABEL_KEY_CHARS),
		z.string().max(MAX_GRAFANA_LABEL_VALUE_CHARS),
	)
	.refine((value) => keyCountAtMost(value, MAX_GRAFANA_LABEL_KEYS), {
		message: `at most ${MAX_GRAFANA_LABEL_KEYS} labels`,
	});

export const grafanaAnnotationsSchema = z
	.record(
		z.string().min(1).max(MAX_GRAFANA_LABEL_KEY_CHARS),
		z.string().max(MAX_GRAFANA_ANNOTATION_VALUE_CHARS),
	)
	.refine((value) => keyCountAtMost(value, MAX_GRAFANA_ANNOTATION_KEYS), {
		message: `at most ${MAX_GRAFANA_ANNOTATION_KEYS} annotations`,
	});

/**
 * Alertmanager `values` is a label→number map in Grafana; strings and booleans
 * are tolerated so a provider drift does not reject the whole group.
 */
export const grafanaAlertValuesSchema = z
	.record(
		z.string().min(1).max(MAX_GRAFANA_LABEL_KEY_CHARS),
		z.union([
			z.number().finite(),
			z.string().max(MAX_GRAFANA_LABEL_VALUE_CHARS),
			z.boolean(),
		]),
	)
	.refine((value) => keyCountAtMost(value, MAX_GRAFANA_VALUES_KEYS), {
		message: `at most ${MAX_GRAFANA_VALUES_KEYS} values`,
	});

/** Keys that normalize.ts may use; a strict subset of the label set. */
const ALERT_STATUSES = ["firing", "resolved", "pending", "inactive"] as const;

export const grafanaAlertSchema = z
	.strictObject({
		status: z.enum(ALERT_STATUSES).optional(),
		labels: grafanaLabelsSchema,
		annotations: grafanaAnnotationsSchema.optional(),
		startsAt: z.iso.datetime({ offset: true }).optional(),
		endsAt: z.iso.datetime({ offset: true }).optional(),
		/** Display-only; never fetched and never used as a request target. */
		generatorURL: z.string().max(MAX_GRAFANA_URL_CHARS).optional(),
		fingerprint: z.string().max(64).optional(),
		silenceURL: z.string().max(MAX_GRAFANA_URL_CHARS).optional(),
		dashboardURL: z.string().max(MAX_GRAFANA_URL_CHARS).optional(),
		panelURL: z.string().max(MAX_GRAFANA_URL_CHARS).optional(),
		values: grafanaAlertValuesSchema.optional(),
	})
	.strict();

/**
 * Alertmanager-compatible alert group (`version: "1"`) as sent by Grafana
 * Alerting. Unknown fields are rejected; every array is capped at 64 alerts.
 */
export const grafanaAlertGroupSchema = z
	.strictObject({
		receiver: z.string().max(200).optional(),
		status: z.enum(ALERT_STATUSES).optional(),
		orgId: z.number().int().nonnegative().optional(),
		alerts: z.array(grafanaAlertSchema).min(1).max(MAX_GRAFANA_ALERTS),
		groupLabels: grafanaLabelsSchema.optional(),
		commonLabels: grafanaLabelsSchema.optional(),
		commonAnnotations: grafanaAnnotationsSchema.optional(),
		externalURL: z.string().max(MAX_GRAFANA_URL_CHARS).optional(),
		version: z.literal("1").optional(),
		groupKey: z.string().max(512).optional(),
		truncatedAlerts: z.number().int().nonnegative().optional(),
		state: z.string().max(64).optional(),
		title: z.string().max(2000).optional(),
		message: z.string().max(4000).optional(),
	})
	.strict();

export type GrafanaAlertGroup = z.output<typeof grafanaAlertGroupSchema>;
export type GrafanaAlert = z.output<typeof grafanaAlertSchema>;

/**
 * `GET /api/v1/provisioning/alert-rules/{uid}`. This is a response allowlist:
 * Grafana adds fields over time, so unknown fields are stripped, not rejected.
 */
export const grafanaAlertRuleSchema = z.object({
	id: z.number().int().optional(),
	uid: z.string().min(1).max(MAX_GRAFANA_RULE_UID_CHARS),
	orgID: z.number().int().optional(),
	folderUID: z.string().max(MAX_GRAFANA_RULE_UID_CHARS).optional(),
	ruleGroup: z.string().max(128).optional(),
	title: z.string().max(200).optional(),
	condition: z.string().max(200).optional(),
	data: z.array(z.unknown()).max(50).optional(),
	noDataState: z.string().max(64).optional(),
	execErrState: z.string().max(64).optional(),
	for: z.string().max(64).optional(),
	annotations: grafanaAnnotationsSchema.optional(),
	labels: grafanaLabelsSchema.optional(),
	isPaused: z.boolean().optional(),
	updated: z.string().max(64).optional(),
});

export type GrafanaAlertRule = z.output<typeof grafanaAlertRuleSchema>;

/** One trusted-code query. `expr` is produced by a template, never a model. */
export const grafanaDatasourceQuerySchema = z
	.strictObject({
		refId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,15}$/),
		datasource: z
			.strictObject({
				type: z.enum(["prometheus", "loki"]),
				uid: z.string().regex(GRAFANA_UID_PATTERN),
			})
			.strict(),
		expr: z.string().min(1).max(MAX_GRAFANA_EXPR_CHARS),
		maxDataPoints: z.number().int().min(1).max(MAX_GRAFANA_DATAPOINTS),
		intervalMs: z.number().int().min(1000).max(60_000),
		format: z.enum(["time_series", "table"]),
		instant: z.boolean().optional(),
		range: z.boolean().optional(),
		queryType: z.literal("range").optional(),
		/** Loki tail bound; never above the connector's 200-line cap. */
		maxLines: z.number().int().min(1).max(MAX_GRAFANA_LOG_LINES).optional(),
	})
	.strict();

export type GrafanaDatasourceQuery = z.output<
	typeof grafanaDatasourceQuerySchema
>;

/** `POST /api/ds/query` request. `from`/`to` are epoch milliseconds as text. */
export const grafanaDsQueryRequestSchema = z
	.strictObject({
		from: z.string().regex(/^[0-9]{1,15}$/),
		to: z.string().regex(/^[0-9]{1,15}$/),
		queries: z.array(grafanaDatasourceQuerySchema).min(1).max(4),
	})
	.strict();

export type GrafanaDsQueryRequest = z.output<
	typeof grafanaDsQueryRequestSchema
>;

const grafanaDataFrameFieldSchema = z.object({
	name: z.string().max(128).optional(),
	type: z.string().max(32).optional(),
	labels: z
		.record(
			z.string().max(MAX_GRAFANA_LABEL_KEY_CHARS),
			z.string().max(MAX_GRAFANA_LABEL_VALUE_CHARS),
		)
		.optional(),
});

/**
 * Grafana data frame: `schema.fields` describes columns, `data.values` is
 * column-major. Cell contents stay `unknown` and are filtered by the
 * summarizers (numbers for metrics, strings for the log tail).
 */
export const grafanaDataFrameSchema = z.object({
	schema: z
		.object({
			refId: z.string().max(16).optional(),
			fields: z.array(grafanaDataFrameFieldSchema).max(50).optional(),
		})
		.optional(),
	data: z
		.object({
			values: z.array(z.array(z.unknown())).max(50).optional(),
		})
		.optional(),
});

export const grafanaDsQueryResponseSchema = z.object({
	results: z
		.record(
			z.string().max(16),
			z.object({
				status: z.number().int().optional(),
				error: z.string().max(500).optional(),
				frames: z.array(grafanaDataFrameSchema).max(20).optional(),
			}),
		)
		.optional(),
	message: z.string().max(500).optional(),
});

export type GrafanaDsQueryResponse = z.output<
	typeof grafanaDsQueryResponseSchema
>;
export type GrafanaDataFrame = z.output<typeof grafanaDataFrameSchema>;

/** Bounded JSON helper for a bridge that forwards the raw body as text. */
export function parseGrafanaAlertGroup(
	input: unknown,
): GrafanaAlertGroup | null {
	let value = input;
	if (typeof value === "string") {
		if (value.length > MAX_GRAFANA_WEBHOOK_BODY_BYTES) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const parsed = grafanaAlertGroupSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
