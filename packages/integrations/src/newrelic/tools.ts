import {
	type ErrorCode,
	isPlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";
import {
	fetchNewRelicAlertPolicyEvidence,
	fetchNewRelicEntityEvidence,
	fetchNewRelicNrqlEvidence,
	type NewRelicContextDependencies,
	type NewRelicContextItem,
	type NewRelicEvidenceResult,
} from "./context";
import { redactNewRelicMessage } from "./redact";
import {
	NEWRELIC_ENTITY_GUID_PATTERN,
	NEWRELIC_MAX_ALERT_POLICIES,
} from "./schemas";

/**
 * Read-only New Relic tools (`docs/connectors/newrelic.md` §5–§6).
 *
 * Risk band: every tool is **`read_only`**. The coordinator owns the `ToolName`
 * union and policy table; this module only declares the bands so registration
 * cannot silently widen them. Tools execute server-side in the worker, never in
 * the sandbox, and the user API key never enters an argument, prompt, log or
 * result.
 *
 * `newrelic.run_nrql` accepts model-authored NRQL, which the connector doc
 * otherwise avoids. The guard is deliberately narrow: a single `SELECT`
 * aggregate, no statement separator, comment, mutation keyword, `TIMESERIES`,
 * `SELECT *` or caller-supplied `SINCE`/`UNTIL`/`LIMIT`. The reader appends a
 * bounded window and `LIMIT 20` itself, so a query cannot widen time or rows.
 *
 * There is no ack/close/mutation tool; those would be `sensitive` and are out
 * of scope.
 */

export const NEWRELIC_TOOL_NAMES = [
	"newrelic.run_nrql",
	"newrelic.get_entity",
	"newrelic.list_alert_policies",
] as const;

export type NewRelicToolName = (typeof NEWRELIC_TOOL_NAMES)[number];
export type NewRelicToolRisk = "read_only";

export const NEWRELIC_TOOL_RISK_BANDS: Readonly<
	Record<NewRelicToolName, NewRelicToolRisk>
> = {
	"newrelic.run_nrql": "read_only",
	"newrelic.get_entity": "read_only",
	"newrelic.list_alert_policies": "read_only",
};

export const NEWRELIC_TOOL_MAX_NRQL_CHARS = 600;

export type NewRelicNrqlRejection =
	| "empty"
	| "too_long"
	| "not_select"
	| "multiple_statements"
	| "comment"
	| "forbidden_keyword"
	| "wildcard_rows"
	| "raw_logs"
	| "timeseries"
	| "caller_window"
	| "missing_aggregate";

export type NewRelicNrqlCheck =
	| { ok: true }
	| { ok: false; reason: NewRelicNrqlRejection };

const FORBIDDEN_NRQL_KEYWORDS =
	/\b(?:UPDATE|DELETE|INSERT|UPSERT|DROP|ALTER|CREATE|GRANT|REVOKE|MERGE|TRUNCATE)\b/i;
const CALLER_WINDOW_KEYWORDS = /\b(?:SINCE|UNTIL|LIMIT)\b/i;
const AGGREGATE_FUNCTION =
	/\b(?:count|average|sum|min|max|percentile|uniquecount|rate|apdex|latest|histogram)\s*\(/i;

/**
 * SELECT-only NRQL guard. A rejection is a fixed reason, never the query text,
 * so a malformed or hostile query cannot echo into a log, audit detail or
 * model-visible error.
 */
export function checkReadOnlyNewRelicNrql(query: unknown): NewRelicNrqlCheck {
	if (typeof query !== "string") return { ok: false, reason: "empty" };
	const trimmed = query.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty" };
	if (trimmed.length > NEWRELIC_TOOL_MAX_NRQL_CHARS) {
		return { ok: false, reason: "too_long" };
	}
	if (!/^SELECT\b/i.test(trimmed)) {
		return { ok: false, reason: "not_select" };
	}
	if (trimmed.includes(";")) {
		return { ok: false, reason: "multiple_statements" };
	}
	if (trimmed.includes("--") || trimmed.includes("/*")) {
		return { ok: false, reason: "comment" };
	}
	if (FORBIDDEN_NRQL_KEYWORDS.test(trimmed)) {
		return { ok: false, reason: "forbidden_keyword" };
	}
	if (CALLER_WINDOW_KEYWORDS.test(trimmed)) {
		return { ok: false, reason: "caller_window" };
	}
	if (/\bSELECT\s+\*/i.test(trimmed)) {
		return { ok: false, reason: "wildcard_rows" };
	}
	if (/\bFROM\s+(?:Log|Logging)\b/i.test(trimmed)) {
		return { ok: false, reason: "raw_logs" };
	}
	if (/\bTIMESERIES\b/i.test(trimmed)) {
		return { ok: false, reason: "timeseries" };
	}
	if (!AGGREGATE_FUNCTION.test(trimmed)) {
		return { ok: false, reason: "missing_aggregate" };
	}
	return { ok: true };
}

export function isReadOnlyNewRelicNrql(query: unknown): boolean {
	return checkReadOnlyNewRelicNrql(query).ok;
}

export const newRelicRunNrqlInputSchema = z
	.strictObject({
		query: z.string().trim().min(1).max(NEWRELIC_TOOL_MAX_NRQL_CHARS),
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
	})
	.strict();

export const newRelicGetEntityInputSchema = z
	.strictObject({
		guid: z.string().regex(NEWRELIC_ENTITY_GUID_PATTERN),
	})
	.strict();

export const newRelicListAlertPoliciesInputSchema = z
	.strictObject({
		limit: z.number().int().min(1).max(NEWRELIC_MAX_ALERT_POLICIES).optional(),
	})
	.strict();

export type NewRelicRunNrqlInput = z.output<typeof newRelicRunNrqlInputSchema>;
export type NewRelicGetEntityInput = z.output<
	typeof newRelicGetEntityInputSchema
>;
export type NewRelicListAlertPoliciesInput = z.output<
	typeof newRelicListAlertPoliciesInputSchema
>;

export type NewRelicToolSuccess = {
	ok: true;
	tool: NewRelicToolName;
	risk: NewRelicToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: NewRelicContextItem | null;
	truncated: boolean;
};

export type NewRelicToolFailure = {
	ok: false;
	tool: NewRelicToolName;
	risk: NewRelicToolRisk;
	code: ErrorCode;
	/** Bounded, redacted; no API key, endpoint or provider body. */
	message: string;
};

export type NewRelicToolResult = NewRelicToolSuccess | NewRelicToolFailure;

function success(
	tool: NewRelicToolName,
	evidence: NewRelicEvidenceResult,
): NewRelicToolSuccess {
	return {
		ok: true,
		tool,
		risk: "read_only",
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: NewRelicToolName,
	code: ErrorCode,
	message: string,
): NewRelicToolFailure {
	return {
		ok: false,
		tool,
		risk: "read_only",
		code,
		message: redactNewRelicMessage(message),
	};
}

function outcomeCode(
	outcome: NewRelicEvidenceResult["outcome"],
): ErrorCode | null {
	switch (outcome) {
		case "missing":
			return "NOT_FOUND";
		case "denied":
			return "POLICY_DENIED";
		case "failed":
			return "INTEGRATION_UNAVAILABLE";
		default:
			return null;
	}
}

function evidenceResult(
	tool: NewRelicToolName,
	evidence: NewRelicEvidenceResult,
): NewRelicToolResult {
	const code = outcomeCode(evidence.outcome);
	if (code === null) return success(tool, evidence);
	return failure(tool, code, `${tool} could not read newrelic evidence`);
}

async function executeRead<T>(
	tool: NewRelicToolName,
	schema: z.ZodType<T>,
	input: unknown,
	run: (parsed: T) => Promise<NewRelicEvidenceResult>,
): Promise<NewRelicToolResult> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		return failure(tool, "VALIDATION_FAILED", zodIssueSummary(parsed.error));
	}
	try {
		return evidenceResult(tool, await run(parsed.data));
	} catch (throwable) {
		return failure(
			tool,
			isPlatformError(throwable) ? throwable.code : "INTEGRATION_UNAVAILABLE",
			isPlatformError(throwable)
				? throwable.message
				: "newrelic tool call failed",
		);
	}
}

/**
 * `newrelic.run_nrql` — **risk band: `read_only`**.
 *
 * One guarded aggregate query over a bounded window. The reader appends
 * `SINCE`/`UNTIL` (15–60 minutes) and `LIMIT 20`; the model cannot widen
 * either. Results are redacted and capped at 20 rows / 2,000 chars.
 */
export async function runNewRelicNrql(
	dependencies: NewRelicContextDependencies,
	input: unknown,
): Promise<NewRelicToolResult> {
	const parsed = newRelicRunNrqlInputSchema.safeParse(input);
	if (!parsed.success) {
		return failure(
			"newrelic.run_nrql",
			"VALIDATION_FAILED",
			zodIssueSummary(parsed.error),
		);
	}
	const guard = checkReadOnlyNewRelicNrql(parsed.data.query);
	if (!guard.ok) {
		return failure(
			"newrelic.run_nrql",
			"POLICY_DENIED",
			`newrelic.run_nrql rejected NRQL (${guard.reason})`,
		);
	}
	return executeRead(
		"newrelic.run_nrql",
		newRelicRunNrqlInputSchema,
		parsed.data,
		(run) =>
			fetchNewRelicNrqlEvidence(dependencies, {
				nrql: run.query,
				startsAt: run.startsAt,
				windowMinutes: run.windowMinutes,
			}),
	);
}

/**
 * `newrelic.get_entity` — **risk band: `read_only`**.
 *
 * Selected entity attributes only: GUID, name, type, domain, alert severity,
 * reporting and an allowlisted tag subset. No tag-map dump, no account from
 * another tenant (`NOT_FOUND`), no entity URL from the arguments.
 */
export function getNewRelicEntity(
	dependencies: NewRelicContextDependencies,
	input: unknown,
): Promise<NewRelicToolResult> {
	return executeRead(
		"newrelic.get_entity",
		newRelicGetEntityInputSchema,
		input,
		(parsed) =>
			fetchNewRelicEntityEvidence(dependencies, { guid: parsed.guid }),
	);
}

/**
 * `newrelic.list_alert_policies` — **risk band: `read_only`**.
 *
 * Policy id and name only, at most the requested limit (≤25). Notification
 * destinations and rule definitions are never requested.
 */
export function listNewRelicAlertPolicies(
	dependencies: NewRelicContextDependencies,
	input: unknown,
): Promise<NewRelicToolResult> {
	return executeRead(
		"newrelic.list_alert_policies",
		newRelicListAlertPoliciesInputSchema,
		input,
		(parsed) =>
			fetchNewRelicAlertPolicyEvidence(dependencies, {
				limit: parsed.limit ?? 10,
			}),
	);
}

export type NewRelicReadToolDescriptor = {
	name: NewRelicToolName;
	risk: NewRelicToolRisk;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<NewRelicToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS` (`read_only`); this module does not edit policy.
 */
export function createNewRelicReadTools(
	dependencies: NewRelicContextDependencies,
): readonly NewRelicReadToolDescriptor[] {
	return [
		{
			name: "newrelic.run_nrql",
			risk: "read_only",
			description:
				"Guarded SELECT aggregate over a 15–60 minute window, ≤20 rows.",
			inputSchema: newRelicRunNrqlInputSchema,
			execute: (input) => runNewRelicNrql(dependencies, input),
		},
		{
			name: "newrelic.get_entity",
			risk: "read_only",
			description: "Selected attributes for one entity GUID in the account.",
			inputSchema: newRelicGetEntityInputSchema,
			execute: (input) => getNewRelicEntity(dependencies, input),
		},
		{
			name: "newrelic.list_alert_policies",
			risk: "read_only",
			description: "Alert policy ids and names (≤25), no destinations.",
			inputSchema: newRelicListAlertPoliciesInputSchema,
			execute: (input) => listNewRelicAlertPolicies(dependencies, input),
		},
	];
}
