import {
	type ContextItem,
	type ErrorCode,
	isPlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";
import {
	type DatadogContextDependencies,
	type DatadogEvidenceResult,
	fetchDatadogIncidentEvidence,
	fetchDatadogLogEvidence,
	fetchDatadogMetricEvidence,
	fetchDatadogMonitorEvidence,
} from "./context";
import { redactDatadogMessage } from "./redact";
import {
	DATADOG_INCIDENT_ID_PATTERN,
	DATADOG_MONITOR_ID_PATTERN,
	DATADOG_SERVICE_PATTERN,
	MAX_DATADOG_LOG_ENTRIES,
} from "./schemas";

/**
 * Read-only Datadog tools (`docs/connectors/datadog.md` §6).
 *
 * Risk band: every tool here is **`read_only`**. Reads are admitted by
 * `createRiskTablePolicy` and audited; policy is not changed by this module.
 * These tools execute server-side in the worker, never in the sandbox, and
 * neither the API key nor the application key ever enters a tool argument,
 * prompt, sandbox environment or log. Inputs are strict: a caller cannot
 * supply a query, a time range, a site URL or an arbitrary id shape — only a
 * service, a bounded window, or a validated Datadog id. Results are redacted
 * and capped before return.
 *
 * There are no write tools: mute, annotate and incident edits are out of
 * scope (`sensitive` in a later wave, never `read_only`).
 */

export const DATADOG_TOOL_NAMES = [
	"datadog.query_metrics",
	"datadog.search_logs",
	"datadog.get_incident",
	"datadog.get_monitor",
] as const;

export type DatadogToolName = (typeof DATADOG_TOOL_NAMES)[number];
export type DatadogToolRisk = "read_only";

export const DATADOG_TOOL_RISK_BANDS: Readonly<
	Record<DatadogToolName, DatadogToolRisk>
> = {
	"datadog.query_metrics": "read_only",
	"datadog.search_logs": "read_only",
	"datadog.get_incident": "read_only",
	"datadog.get_monitor": "read_only",
};

const serviceInputSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(DATADOG_SERVICE_PATTERN);

/** Strict: no `query`, `from`, `to`, `site` or arbitrary URL accepted. */
export const datadogQueryMetricsInputSchema = z
	.strictObject({
		service: serviceInputSchema,
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
	})
	.strict();

export const datadogSearchLogsInputSchema = z
	.strictObject({
		service: serviceInputSchema,
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
		/** Accepted for parity; the reader always caps at 20 entries. */
		maxEntries: z.number().int().min(1).max(MAX_DATADOG_LOG_ENTRIES).optional(),
	})
	.strict();

export const datadogGetIncidentInputSchema = z
	.strictObject({
		incidentId: z.string().regex(DATADOG_INCIDENT_ID_PATTERN),
	})
	.strict();

export const datadogGetMonitorInputSchema = z
	.strictObject({
		monitorId: z.union([
			z.string().regex(DATADOG_MONITOR_ID_PATTERN),
			z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		]),
	})
	.strict();

export type DatadogQueryMetricsInput = z.output<
	typeof datadogQueryMetricsInputSchema
>;
export type DatadogSearchLogsInput = z.output<
	typeof datadogSearchLogsInputSchema
>;
export type DatadogGetIncidentInput = z.output<
	typeof datadogGetIncidentInputSchema
>;
export type DatadogGetMonitorInput = z.output<
	typeof datadogGetMonitorInputSchema
>;

export type DatadogToolSuccess = {
	ok: true;
	tool: DatadogToolName;
	risk: DatadogToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: ContextItem | null;
	truncated: boolean;
};

export type DatadogToolFailure = {
	ok: false;
	tool: DatadogToolName;
	risk: DatadogToolRisk;
	code: ErrorCode;
	/** Bounded, redacted; no key, URL or provider body. */
	message: string;
};

export type DatadogToolResult = DatadogToolSuccess | DatadogToolFailure;

function success(
	tool: DatadogToolName,
	evidence: DatadogEvidenceResult,
): DatadogToolSuccess {
	return {
		ok: true,
		tool,
		risk: "read_only",
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: DatadogToolName,
	code: ErrorCode,
	message: string,
): DatadogToolFailure {
	return {
		ok: false,
		tool,
		risk: "read_only",
		code,
		message: redactDatadogMessage(message),
	};
}

async function executeRead<T>(
	tool: DatadogToolName,
	schema: z.ZodType<T>,
	input: unknown,
	run: (parsed: T) => Promise<DatadogEvidenceResult>,
): Promise<DatadogToolResult> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		return failure(tool, "VALIDATION_FAILED", zodIssueSummary(parsed.error));
	}
	try {
		return success(tool, await run(parsed.data));
	} catch (throwable) {
		return failure(
			tool,
			isPlatformError(throwable) ? throwable.code : "INTEGRATION_UNAVAILABLE",
			isPlatformError(throwable)
				? throwable.message
				: "datadog tool call failed",
		);
	}
}

/**
 * `datadog.query_metrics` — **risk band: `read_only`**.
 *
 * Two templated metric queries over the incident window (15–60 minutes, never
 * backfilled). At most three series and twenty points per series, rendered as
 * a ≤1,500-char summary. No query text or timestamp is accepted.
 */
export function queryDatadogMetrics(
	dependencies: DatadogContextDependencies,
	input: DatadogQueryMetricsInput | unknown,
): Promise<DatadogToolResult> {
	return executeRead(
		"datadog.query_metrics",
		datadogQueryMetricsInputSchema,
		input,
		(parsed) => fetchDatadogMetricEvidence(dependencies, parsed),
	);
}

/**
 * `datadog.search_logs` — **risk band: `read_only`**.
 *
 * One templated log search, at most 20 entries, reduced to status-class and
 * error-kind counts. Message bodies are never modelled, stored or rendered;
 * the aggregate is redacted and capped at 2,000 characters.
 */
export function searchDatadogLogs(
	dependencies: DatadogContextDependencies,
	input: DatadogSearchLogsInput | unknown,
): Promise<DatadogToolResult> {
	return executeRead(
		"datadog.search_logs",
		datadogSearchLogsInputSchema,
		input,
		(parsed) => fetchDatadogLogEvidence(dependencies, parsed),
	);
}

/**
 * `datadog.get_incident` — **risk band: `read_only`**.
 *
 * Incident metadata for a validated id: title, severity, state, timestamps, a
 * bounded impact flag/scope. Notes, responders and free-form fields are never
 * fetched into context.
 */
export function getDatadogIncident(
	dependencies: DatadogContextDependencies,
	input: DatadogGetIncidentInput | unknown,
): Promise<DatadogToolResult> {
	return executeRead(
		"datadog.get_incident",
		datadogGetIncidentInputSchema,
		input,
		(parsed) => fetchDatadogIncidentEvidence(dependencies, parsed),
	);
}

/**
 * `datadog.get_monitor` — **risk band: `read_only`**.
 *
 * Monitor state for a validated numeric id: name, type, overall state,
 * timestamps, priority and an allowlisted tag subset. The monitor `message`
 * and `options` (which can embed webhook URLs and secrets) are never modelled.
 */
export function getDatadogMonitor(
	dependencies: DatadogContextDependencies,
	input: DatadogGetMonitorInput | unknown,
): Promise<DatadogToolResult> {
	return executeRead(
		"datadog.get_monitor",
		datadogGetMonitorInputSchema,
		input,
		(parsed) => fetchDatadogMonitorEvidence(dependencies, parsed),
	);
}

export type DatadogReadToolDescriptor = {
	name: DatadogToolName;
	risk: DatadogToolRisk;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<DatadogToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS` (`read_only`); this module does not edit policy.
 */
export function createDatadogReadTools(
	dependencies: DatadogContextDependencies,
): readonly DatadogReadToolDescriptor[] {
	return [
		{
			name: "datadog.query_metrics",
			risk: "read_only",
			description:
				"Bounded metric queries for a service in the incident window.",
			inputSchema: datadogQueryMetricsInputSchema,
			execute: (input) => queryDatadogMetrics(dependencies, input),
		},
		{
			name: "datadog.search_logs",
			risk: "read_only",
			description:
				"Redacted log status/error-kind counts (20 entries / 2,000 chars).",
			inputSchema: datadogSearchLogsInputSchema,
			execute: (input) => searchDatadogLogs(dependencies, input),
		},
		{
			name: "datadog.get_incident",
			risk: "read_only",
			description: "Incident metadata for a validated incident id.",
			inputSchema: datadogGetIncidentInputSchema,
			execute: (input) => getDatadogIncident(dependencies, input),
		},
		{
			name: "datadog.get_monitor",
			risk: "read_only",
			description: "Monitor state for a validated monitor id.",
			inputSchema: datadogGetMonitorInputSchema,
			execute: (input) => getDatadogMonitor(dependencies, input),
		},
	];
}
