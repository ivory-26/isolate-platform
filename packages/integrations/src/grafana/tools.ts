import {
	type ContextItem,
	type ErrorCode,
	isPlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";
import {
	fetchGrafanaAlertRuleEvidence,
	fetchGrafanaLogEvidence,
	fetchGrafanaMetricEvidence,
	type GrafanaContextDependencies,
	type GrafanaEvidenceResult,
} from "./context";
import { redactGrafanaMessage } from "./redact";
import {
	GRAFANA_UID_PATTERN,
	MAX_GRAFANA_LOG_LINES,
	MAX_GRAFANA_SERVICE_CHARS,
} from "./schemas";

/**
 * Read-only Grafana tools (`docs/connectors/grafana.md` §6).
 *
 * Risk band: every tool here is **`read_only`**. Reads are admitted by
 * `createRiskTablePolicy` and audited; policy is not changed by this module.
 * These tools execute server-side in the worker, never in the sandbox, and the
 * Grafana token never enters a tool argument, prompt, sandbox environment or
 * log. Inputs are strict: a caller cannot supply an expression, datasource
 * UID, time range or URL — only a service name, an incident start and a
 * bounded window. Results are redacted and capped before return.
 */

export const GRAFANA_TOOL_NAMES = [
	"grafana.query_metrics",
	"grafana.query_logs",
	"grafana.get_alert_rule",
] as const;

export type GrafanaToolName = (typeof GRAFANA_TOOL_NAMES)[number];
export type GrafanaToolRisk = "read_only";

export const GRAFANA_TOOL_RISK_BANDS: Readonly<
	Record<GrafanaToolName, GrafanaToolRisk>
> = {
	"grafana.query_metrics": "read_only",
	"grafana.query_logs": "read_only",
	"grafana.get_alert_rule": "read_only",
};

const serviceInputSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_GRAFANA_SERVICE_CHARS);

/** Strict: no `expr`, `datasource`, `from`, `to` or arbitrary URL accepted. */
export const grafanaQueryMetricsInputSchema = z
	.strictObject({
		service: serviceInputSchema,
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
	})
	.strict();

export const grafanaQueryLogsInputSchema = z
	.strictObject({
		service: serviceInputSchema,
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
		/** Accepted for parity; the reader always caps at 200 lines. */
		maxLines: z.number().int().min(1).max(MAX_GRAFANA_LOG_LINES).optional(),
	})
	.strict();

export const grafanaGetAlertRuleInputSchema = z
	.strictObject({
		ruleUid: z.string().regex(GRAFANA_UID_PATTERN),
	})
	.strict();

export type GrafanaQueryMetricsInput = z.output<
	typeof grafanaQueryMetricsInputSchema
>;
export type GrafanaQueryLogsInput = z.output<
	typeof grafanaQueryLogsInputSchema
>;
export type GrafanaGetAlertRuleInput = z.output<
	typeof grafanaGetAlertRuleInputSchema
>;

export type GrafanaToolSuccess = {
	ok: true;
	tool: GrafanaToolName;
	risk: GrafanaToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: ContextItem | null;
	truncated: boolean;
};

export type GrafanaToolFailure = {
	ok: false;
	tool: GrafanaToolName;
	risk: GrafanaToolRisk;
	code: ErrorCode;
	/** Bounded, redacted; no token, URL or provider body. */
	message: string;
};

export type GrafanaToolResult = GrafanaToolSuccess | GrafanaToolFailure;

function success(
	tool: GrafanaToolName,
	evidence: GrafanaEvidenceResult,
): GrafanaToolSuccess {
	return {
		ok: true,
		tool,
		risk: "read_only",
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: GrafanaToolName,
	code: ErrorCode,
	message: string,
): GrafanaToolFailure {
	return {
		ok: false,
		tool,
		risk: "read_only",
		code,
		message: redactGrafanaMessage(message),
	};
}

async function executeRead<T>(
	tool: GrafanaToolName,
	schema: z.ZodType<T>,
	input: unknown,
	run: (parsed: T) => Promise<GrafanaEvidenceResult>,
): Promise<GrafanaToolResult> {
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
				: "grafana tool call failed",
		);
	}
}

/**
 * `grafana.query_metrics` — **risk band: `read_only`**.
 *
 * One templated PromQL selector over the service's `job` label, bounded to the
 * incident window (15–60 minutes, never backfilled). At most five series and
 * twenty points per series, rendered as a ≤1,500-char summary.
 */
export function queryGrafanaMetrics(
	dependencies: GrafanaContextDependencies,
	input: GrafanaQueryMetricsInput | unknown,
): Promise<GrafanaToolResult> {
	return executeRead(
		"grafana.query_metrics",
		grafanaQueryMetricsInputSchema,
		input,
		(parsed) => fetchGrafanaMetricEvidence(dependencies, parsed),
	);
}

/**
 * `grafana.query_logs` — **risk band: `read_only`**.
 *
 * One templated LogQL selector; the last 200 lines, redacted, capped at 2,000
 * characters. There is no way to request a wider range or a raw log body.
 */
export function queryGrafanaLogs(
	dependencies: GrafanaContextDependencies,
	input: GrafanaQueryLogsInput | unknown,
): Promise<GrafanaToolResult> {
	return executeRead(
		"grafana.query_logs",
		grafanaQueryLogsInputSchema,
		input,
		(parsed) => fetchGrafanaLogEvidence(dependencies, parsed),
	);
}

/**
 * `grafana.get_alert_rule` — **risk band: `read_only`**.
 *
 * Rule metadata for a UID from the signal: title, expression condition,
 * for-duration, a bounded label subset and the summary/description/runbook
 * annotations. No rule history, no dashboard JSON.
 */
export function getGrafanaAlertRule(
	dependencies: GrafanaContextDependencies,
	input: GrafanaGetAlertRuleInput | unknown,
): Promise<GrafanaToolResult> {
	return executeRead(
		"grafana.get_alert_rule",
		grafanaGetAlertRuleInputSchema,
		input,
		(parsed) =>
			fetchGrafanaAlertRuleEvidence(dependencies, {
				ruleUid: parsed.ruleUid,
			}),
	);
}

export type GrafanaReadToolDescriptor = {
	name: GrafanaToolName;
	risk: GrafanaToolRisk;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<GrafanaToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS` (`read_only`); this module does not edit policy.
 */
export function createGrafanaReadTools(
	dependencies: GrafanaContextDependencies,
): readonly GrafanaReadToolDescriptor[] {
	return [
		{
			name: "grafana.query_metrics",
			risk: "read_only",
			description:
				"Bounded Prometheus window for a service in the incident window.",
			inputSchema: grafanaQueryMetricsInputSchema,
			execute: (input) => queryGrafanaMetrics(dependencies, input),
		},
		{
			name: "grafana.query_logs",
			risk: "read_only",
			description: "Redacted Loki tail (200 lines / 2,000 chars).",
			inputSchema: grafanaQueryLogsInputSchema,
			execute: (input) => queryGrafanaLogs(dependencies, input),
		},
		{
			name: "grafana.get_alert_rule",
			risk: "read_only",
			description: "Alert-rule metadata for a UID from the signal.",
			inputSchema: grafanaGetAlertRuleInputSchema,
			execute: (input) => getGrafanaAlertRule(dependencies, input),
		},
	];
}
