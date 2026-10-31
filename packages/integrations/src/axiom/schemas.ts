import { z } from "zod";

/**
 * Validation boundary for the Axiom connector
 * (`docs/connectors/axiom.md` §4–§5).
 *
 * The inbound webhook shape is **operator-pinned**: Axiom's custom notifier
 * renders a Go template, so trusted code fixes the JSON contract below and an
 * unknown field is rejected at the boundary. The template must emit:
 *
 * ```json
 * {
 *   "action": "{{.Action}}",
 *   "monitor_id": "{{.MonitorID}}",
 *   "monitor_name": "{{.MonitorName}}",
 *   "dataset": "<configured dataset>",
 *   "group": "{{.Group}}",
 *   "value": "{{.Value}}",
 *   "threshold": "{{.Threshold}}",
 *   "timestamp": "{{.Timestamp}}",
 *   "state": "<configured state>",
 *   "service": "<service label>",
 *   "environment": "<environment label>",
 *   "severity": "<monitor severity>",
 *   "url": "<monitor URL>",
 *   "fields": { "service": "...", "runbook_url": "..." }
 * }
 * ```
 *
 * Provider responses (APL query results, dataset list) are allowlists: Axiom
 * adds fields over time, so unknown response fields are stripped, every array
 * and string is bounded, and no cell is passed through verbatim.
 *
 * Signing is **not implemented**: the vendor page documents no HMAC, so no
 * signature schema exists here (see `webhook.ts`).
 */

/** Platform default for a webhook body; the receiver refuses before JSON. */
export const AXIOM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Dataset names per `docs/connectors/axiom.md` §3. */
export const AXIOM_DATASET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Monitor ids are opaque; bounded and URL-safe so they can key a registry. */
export const AXIOM_MONITOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
export const MAX_AXIOM_ACTION_CHARS = 32;
export const MAX_AXIOM_MONITOR_NAME_CHARS = 200;
export const MAX_AXIOM_GROUP_CHARS = 200;
export const MAX_AXIOM_STATE_CHARS = 64;
export const MAX_AXIOM_SERVICE_CHARS = 128;
export const MAX_AXIOM_ENVIRONMENT_CHARS = 64;
export const MAX_AXIOM_SEVERITY_CHARS = 32;
export const MAX_AXIOM_URL_CHARS = 512;
export const MAX_AXIOM_VALUE_CHARS = 200;
export const MAX_AXIOM_FIELD_KEYS = 32;
export const MAX_AXIOM_FIELD_KEY_CHARS = 128;
export const MAX_AXIOM_FIELD_VALUE_CHARS = 512;
/** APL is bounded: a model- or config-supplied query never exceeds this. */
export const MAX_AXIOM_APL_CHARS = 2000;
/** Provider rows parsed per table; context renders at most 20. */
export const MAX_AXIOM_APL_ROWS = 100;
export const MAX_AXIOM_APL_TABLES = 10;
export const MAX_AXIOM_APL_FIELDS = 32;
export const MAX_AXIOM_APL_FIELD_CHARS = 128;
export const MAX_AXIOM_APL_CELL_CHARS = 1024;
export const MAX_AXIOM_DATASETS = 200;

function keyCountAtMost(value: Record<string, unknown>, max: number): boolean {
	return Object.keys(value).length <= max;
}

/** Untrusted monitor fields; only a fixed subset is ever rendered. */
export const axiomWebhookFieldsSchema = z
	.record(
		z.string().min(1).max(MAX_AXIOM_FIELD_KEY_CHARS),
		z.string().max(MAX_AXIOM_FIELD_VALUE_CHARS),
	)
	.refine((value) => keyCountAtMost(value, MAX_AXIOM_FIELD_KEYS), {
		message: `at most ${MAX_AXIOM_FIELD_KEYS} fields`,
	});

/** Monitor value as rendered by the Go template: scalar, never a map. */
export const axiomMonitorValueSchema = z.union([
	z.number().finite(),
	z.string().max(MAX_AXIOM_VALUE_CHARS),
	z.boolean(),
]);

/**
 * One pinned Axiom webhook delivery. Unknown fields are rejected, every string
 * is capped, and `timestamp` is required: replay control compares it with a
 * trusted clock before any task is created.
 */
export const axiomWebhookPayloadSchema = z
	.strictObject({
		action: z.string().trim().min(1).max(MAX_AXIOM_ACTION_CHARS),
		monitor_id: z.string().regex(AXIOM_MONITOR_ID_PATTERN),
		monitor_name: z
			.string()
			.trim()
			.min(1)
			.max(MAX_AXIOM_MONITOR_NAME_CHARS)
			.optional(),
		dataset: z.string().regex(AXIOM_DATASET_PATTERN),
		group: z.string().max(MAX_AXIOM_GROUP_CHARS).optional(),
		state: z.string().trim().min(1).max(MAX_AXIOM_STATE_CHARS).optional(),
		value: axiomMonitorValueSchema.optional(),
		threshold: z.number().finite().optional(),
		/** Unsigned data, used only for the freshness window (±15 min). */
		timestamp: z.iso.datetime({ offset: true }),
		service: z.string().trim().min(1).max(MAX_AXIOM_SERVICE_CHARS).optional(),
		environment: z.string().max(MAX_AXIOM_ENVIRONMENT_CHARS).optional(),
		severity: z.string().max(MAX_AXIOM_SEVERITY_CHARS).optional(),
		url: z.string().max(MAX_AXIOM_URL_CHARS).optional(),
		fields: axiomWebhookFieldsSchema.optional(),
	})
	.strict();

export type AxiomWebhookPayload = z.output<typeof axiomWebhookPayloadSchema>;

/** One trusted-code APL query; the caller never supplies a URL or window. */
export const axiomAplRequestSchema = z
	.strictObject({
		apl: z.string().trim().min(1).max(MAX_AXIOM_APL_CHARS),
		startTime: z.iso.datetime({ offset: true }),
		endTime: z.iso.datetime({ offset: true }),
	})
	.strict();

export type AxiomAplRequest = z.output<typeof axiomAplRequestSchema>;

/** A tabular cell: text, finite number, boolean or null. Objects are dropped. */
export const axiomAplCellSchema = z.union([
	z.string().max(MAX_AXIOM_APL_CELL_CHARS),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);

/**
 * Axiom's `format=tabular` response carries one or more tables. Both the
 * `matches[].fields/data` and the `columns/rows` spellings are accepted so a
 * minor response-shape change does not drop every query.
 */
export const axiomAplTableSchema = z.object({
	fields: z
		.array(z.string().min(1).max(MAX_AXIOM_APL_FIELD_CHARS))
		.max(MAX_AXIOM_APL_FIELDS)
		.optional(),
	data: z
		.array(z.array(axiomAplCellSchema).max(MAX_AXIOM_APL_FIELDS))
		.max(MAX_AXIOM_APL_ROWS)
		.optional(),
	columns: z
		.array(z.string().min(1).max(MAX_AXIOM_APL_FIELD_CHARS))
		.max(MAX_AXIOM_APL_FIELDS)
		.optional(),
	rows: z
		.array(z.array(axiomAplCellSchema).max(MAX_AXIOM_APL_FIELDS))
		.max(MAX_AXIOM_APL_ROWS)
		.optional(),
});

export const axiomAplResponseSchema = z.object({
	format: z.string().max(32).optional(),
	matches: z.array(axiomAplTableSchema).max(MAX_AXIOM_APL_TABLES).optional(),
	columns: z
		.array(z.string().min(1).max(MAX_AXIOM_APL_FIELD_CHARS))
		.max(MAX_AXIOM_APL_FIELDS)
		.optional(),
	rows: z
		.array(z.array(axiomAplCellSchema).max(MAX_AXIOM_APL_FIELDS))
		.max(MAX_AXIOM_APL_ROWS)
		.optional(),
});

export type AxiomAplResponse = z.output<typeof axiomAplResponseSchema>;
export type AxiomAplTable = z.output<typeof axiomAplTableSchema>;
export type AxiomAplCell = z.output<typeof axiomAplCellSchema>;

/** `GET /v1/datasets` entry: names and ids only, per the connector page. */
export const axiomDatasetSchema = z.object({
	id: z.string().min(1).max(128).optional(),
	name: z.string().regex(AXIOM_DATASET_PATTERN),
});

export type AxiomDataset = z.output<typeof axiomDatasetSchema>;

/** The list endpoint returns either a bare array or `{ datasets: [...] }`. */
export const axiomDatasetListResponseSchema = z.union([
	z.array(axiomDatasetSchema).max(MAX_AXIOM_DATASETS),
	z
		.object({ datasets: z.array(axiomDatasetSchema).max(MAX_AXIOM_DATASETS) })
		.transform((value) => value.datasets),
]);

/**
 * Server-side monitor descriptor. The monitor read API path is UNVERIFIED, so
 * the connector never invents one: monitors are bound in trusted configuration
 * and looked up by id. Strict because this is trusted config, not provider data.
 */
export const axiomMonitorSchema = z
	.strictObject({
		id: z.string().regex(AXIOM_MONITOR_ID_PATTERN),
		name: z.string().trim().min(1).max(MAX_AXIOM_MONITOR_NAME_CHARS),
		dataset: z.string().regex(AXIOM_DATASET_PATTERN),
		state: z.string().trim().min(1).max(MAX_AXIOM_STATE_CHARS).optional(),
		threshold: z.number().finite().optional(),
		value: axiomMonitorValueSchema.optional(),
		url: z.string().max(MAX_AXIOM_URL_CHARS).optional(),
	})
	.strict();

export type AxiomMonitorDescriptor = z.output<typeof axiomMonitorSchema>;

/**
 * Parses a delivery body from raw text or bytes. The 64 KiB cap is checked on
 * the encoded bytes before JSON parsing; a string, array or invalid document
 * returns `null`, never a partially-trusted object.
 */
export function parseAxiomWebhookPayload(
	input: unknown,
	maxBodyBytes: number = AXIOM_WEBHOOK_MAX_BODY_BYTES,
): AxiomWebhookPayload | null {
	let value = input;
	if (input instanceof Uint8Array) {
		if (input.byteLength > maxBodyBytes) return null;
		try {
			value = new TextDecoder("utf-8", { fatal: true }).decode(input);
		} catch {
			return null;
		}
	}
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > maxBodyBytes) return null;
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	const parsed = axiomWebhookPayloadSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
