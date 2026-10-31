import { z } from "zod";

/**
 * Validation boundary for the SigNoz connector
 * (`docs/connectors/signoz.md` §4–§5).
 *
 * Three kinds of schema live here:
 *
 * - **The webhook payload** is `.strict()`: it is an untrusted request, so an
 *   unknown field is rejected before normalization (`docs §8` acceptance:
 *   "unknown payload fields rejected").
 * - **Provider responses** (`POST /api/v5/query_range`, the rule list and rule
 *   detail endpoints) are allowlists: SigNoz adds fields between releases, so
 *   unknown keys are stripped, never passed through.
 * - **The query_range request** is a strict template built by trusted code; a
 *   caller cannot add a second query, a datasource, a wider window or an
 *   unlisted key.
 *
 * Every string, array and label map is bounded. No schema carries a
 * credential, a datasource DSN or a raw log body.
 */

/** Platform default for a webhook body; the receiver refuses before JSON. */
export const MAX_SIGNOZ_WEBHOOK_BODY_BYTES = 64 * 1024;
/** A delivery that carries more alerts than this is rejected by contract. */
export const MAX_SIGNOZ_ALERTS = 64;
export const MAX_SIGNOZ_LABEL_KEYS = 64;
export const MAX_SIGNOZ_LABEL_KEY_CHARS = 128;
export const MAX_SIGNOZ_LABEL_VALUE_CHARS = 512;
export const MAX_SIGNOZ_ANNOTATION_KEYS = 32;
export const MAX_SIGNOZ_ANNOTATION_VALUE_CHARS = 2048;
export const MAX_SIGNOZ_URL_CHARS = 2048;
export const MAX_SIGNOZ_RULE_ID_CHARS = 64;
export const MAX_SIGNOZ_SERVICE_CHARS = 128;
export const MAX_SIGNOZ_QUERY_CHARS = 500;
export const MAX_SIGNOZ_POINTS = 20;
export const MAX_SIGNOZ_SERIES = 5;
export const MAX_SIGNOZ_METRIC_SUMMARY_CHARS = 1500;
export const MAX_SIGNOZ_RULES = 20;
export const MAX_SIGNOZ_RULE_LIST_ROWS = 100;
export const MAX_SIGNOZ_QUERY_SERIES = 100;
export const MAX_SIGNOZ_QUERY_VALUES = 500;
export const MAX_SIGNOZ_QUERY_RESULTS = 10;

/** SigNoz rule ids are UUIDs; provisioned ids may use `_` and `-`. */
export const SIGNOZ_RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Alert states SigNoz emits for a threshold/PromQL rule. */
export const SIGNOZ_ALERT_STATES = ["firing", "resolved"] as const;
export type SignozAlertState = (typeof SIGNOZ_ALERT_STATES)[number];

const FORBIDDEN_QUERY_FRAGMENTS = [
	"\n",
	"\r",
	"\u0000",
	";",
	"#",
	"/*",
	"*/",
	"`",
	"$",
	"{{",
	"}}",
] as const;

/**
 * Bounds a caller-supplied PromQL expression (`signoz.query_range` only).
 *
 * This is not a PromQL parser. It rejects the shapes that make an expression
 * unbounded, multi-statement or capable of smuggling template markers
 * (control characters, comments, semicolons, backticks, `$`, `{{ }}`). SigNoz
 * queries are read-only; the remaining risk is scan cost, which the window,
 * step and series caps bound.
 */
export function isBoundedSignozPromql(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (trimmed.length === 0 || value.length > MAX_SIGNOZ_QUERY_CHARS) {
		return false;
	}
	// Printable ASCII only. The check runs on the raw value, not the trimmed
	// one, so a leading or trailing newline is rejected rather than stripped.
	if (!/^[\x20-\x7E]+$/.test(value)) return false;
	return !FORBIDDEN_QUERY_FRAGMENTS.some((fragment) =>
		value.includes(fragment),
	);
}

function keyCountAtMost(value: Record<string, unknown>, max: number): boolean {
	return Object.keys(value).length <= max;
}

/** Alert labels are untrusted text: bounded keys, bounded values, capped count. */
export const signozLabelsSchema = z
	.record(
		z.string().min(1).max(MAX_SIGNOZ_LABEL_KEY_CHARS),
		z.string().max(MAX_SIGNOZ_LABEL_VALUE_CHARS),
	)
	.refine((value) => keyCountAtMost(value, MAX_SIGNOZ_LABEL_KEYS), {
		message: `at most ${MAX_SIGNOZ_LABEL_KEYS} labels`,
	});

export const signozAnnotationsSchema = z
	.record(
		z.string().min(1).max(MAX_SIGNOZ_LABEL_KEY_CHARS),
		z.string().max(MAX_SIGNOZ_ANNOTATION_VALUE_CHARS),
	)
	.refine((value) => keyCountAtMost(value, MAX_SIGNOZ_ANNOTATION_KEYS), {
		message: `at most ${MAX_SIGNOZ_ANNOTATION_KEYS} annotations`,
	});

/**
 * One alert inside the webhook body. Unknown fields are rejected: the payload
 * is a request, not a response allowlist.
 */
export const signozAlertSchema = z
	.strictObject({
		status: z.enum(SIGNOZ_ALERT_STATES).optional(),
		labels: signozLabelsSchema,
		annotations: signozAnnotationsSchema.optional(),
		/** Data only: never a signed timestamp, never trusted for freshness. */
		startsAt: z.iso.datetime({ offset: true }).optional(),
		endsAt: z.iso.datetime({ offset: true }).optional(),
		/** Display-only; parsed for a rule id, never fetched. */
		generatorURL: z.string().max(MAX_SIGNOZ_URL_CHARS).optional(),
		fingerprint: z.string().max(128).optional(),
		value: z
			.union([
				z.string().max(MAX_SIGNOZ_LABEL_VALUE_CHARS),
				z.number().finite(),
			])
			.optional(),
	})
	.strict();

export type SignozAlert = z.output<typeof signozAlertSchema>;

/**
 * Alertmanager-shaped notification payload SigNoz posts to a webhook channel:
 * `alerts`, `status` and `fingerprint`, plus the optional group fields. There is
 * no signature field; authentication is Basic auth or an operator token header
 * (`webhook.ts`).
 */
export const signozWebhookPayloadSchema = z
	.strictObject({
		alerts: z.array(signozAlertSchema).min(1).max(MAX_SIGNOZ_ALERTS),
		status: z.enum(SIGNOZ_ALERT_STATES).optional(),
		fingerprint: z.string().max(128).optional(),
		receiver: z.string().max(200).optional(),
		version: z.union([z.string().max(32), z.number().finite()]).optional(),
		groupKey: z.string().max(512).optional(),
		groupLabels: signozLabelsSchema.optional(),
		commonLabels: signozLabelsSchema.optional(),
		commonAnnotations: signozAnnotationsSchema.optional(),
		externalURL: z.string().max(MAX_SIGNOZ_URL_CHARS).optional(),
		truncatedAlerts: z.number().int().nonnegative().optional(),
		alerts_count: z.number().int().nonnegative().optional(),
		alertsCount: z.number().int().nonnegative().optional(),
		title: z.string().max(2000).optional(),
		message: z.string().max(4000).optional(),
	})
	.strict();

export type SignozWebhookPayload = z.output<typeof signozWebhookPayloadSchema>;

/**
 * Parses a raw body (string) or an already-parsed value. Returns `null` for an
 * oversize, unknown-field, malformed or non-JSON payload; the caller maps that
 * to a fixed failure reason without echoing anything.
 */
export function parseSignozWebhookPayload(
	input: unknown,
): SignozWebhookPayload | null {
	let value = input;
	if (typeof value === "string") {
		if (value.length > MAX_SIGNOZ_WEBHOOK_BODY_BYTES * 4) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const parsed = signozWebhookPayloadSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * `GET /api/v1/rules/{id}` and the `data.rules[]` rows of `GET /api/v1/rules`.
 * This is an allowlist: unknown provider keys are stripped. `alert` is the
 * rule's query/expression; it is only used when `ruleType` names PromQL.
 */
export const signozRuleSchema = z.object({
	id: z.string().min(1).max(MAX_SIGNOZ_RULE_ID_CHARS),
	alert: z.string().max(2000).nullable().optional(),
	alertName: z.string().max(200).nullable().optional(),
	ruleType: z.string().max(64).nullable().optional(),
	evalWindow: z.string().max(32).nullable().optional(),
	frequency: z.string().max(32).nullable().optional(),
	state: z.string().max(64).nullable().optional(),
	disabled: z.boolean().optional(),
	description: z.string().max(1000).nullable().optional(),
	labels: signozLabelsSchema.optional(),
	annotations: signozAnnotationsSchema.optional(),
	createdAt: z.string().max(64).optional(),
	updatedAt: z.string().max(64).optional(),
});

export type SignozRule = z.output<typeof signozRuleSchema>;

export const signozRuleResponseSchema = z.object({
	status: z.string().max(32).optional(),
	data: signozRuleSchema.nullable().optional(),
});

export type SignozRuleResponse = z.output<typeof signozRuleResponseSchema>;

export const signozRuleListResponseSchema = z.object({
	status: z.string().max(32).optional(),
	data: z
		.object({
			rules: z
				.array(signozRuleSchema.nullable())
				.max(MAX_SIGNOZ_RULE_LIST_ROWS)
				.optional(),
			total: z.number().int().nonnegative().optional(),
		})
		.nullable()
		.optional(),
});

export type SignozRuleListResponse = z.output<
	typeof signozRuleListResponseSchema
>;

/** One point of a time series; `value` is a string in the v5 response. */
export const signozQueryPointSchema = z.object({
	timestamp: z.number().int().nonnegative(),
	value: z.union([z.number().finite(), z.string().max(64), z.null()]),
});

export const signozQuerySeriesSchema = z.object({
	labels: signozLabelsSchema.optional(),
	values: z
		.array(signozQueryPointSchema)
		.max(MAX_SIGNOZ_QUERY_VALUES)
		.optional(),
});

export const signozQueryResultSchema = z.object({
	queryName: z.string().max(16).optional(),
	series: z
		.array(signozQuerySeriesSchema)
		.max(MAX_SIGNOZ_QUERY_SERIES)
		.optional(),
});

/**
 * `POST /api/v5/query_range` — time-series envelope. Scalar/table payloads are
 * outside this connector's plan (no log bodies, no trace payloads): their
 * `results[]` simply carry no `series` and are dropped.
 */
export const signozQueryRangeResponseSchema = z.object({
	status: z.string().max(32).optional(),
	error: z.string().max(500).optional(),
	data: z
		.object({
			type: z.string().max(32).optional(),
			data: z
				.object({
					results: z
						.array(signozQueryResultSchema)
						.max(MAX_SIGNOZ_QUERY_RESULTS)
						.optional(),
				})
				.optional(),
		})
		.nullable()
		.optional(),
});

export type SignozQueryRangeResponse = z.output<
	typeof signozQueryRangeResponseSchema
>;

/**
 * The exact body trusted code posts. `compositeQuery` carries one PromQL query
 * named `A`; there is no datasource, no ClickHouse SQL and no second query.
 */
export const signozQueryRangeRequestSchema = z
	.strictObject({
		start: z.number().int().nonnegative(),
		end: z.number().int().nonnegative(),
		/** Seconds per point; bounded so a series never exceeds 20 points. */
		stepInterval: z.number().int().min(30).max(300),
		compositeQuery: z
			.strictObject({
				queryType: z.literal("promql"),
				panelType: z.literal("graph"),
				promQueries: z
					.strictObject({
						A: z
							.strictObject({
								queryName: z.literal("A"),
								promql: z
									.string()
									.min(1)
									.max(MAX_SIGNOZ_QUERY_CHARS)
									.refine(isBoundedSignozPromql, "bounded PromQL required"),
							})
							.strict(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.refine((value) => value.start < value.end, "start must precede end");

export type SignozQueryRangeRequest = z.output<
	typeof signozQueryRangeRequestSchema
>;
