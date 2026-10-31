import {
	type ErrorCode,
	isPlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";
import {
	fetchSignozQueryEvidence,
	fetchSignozRuleEvidence,
	fetchSignozRuleListEvidence,
	type SignozContextDependencies,
	type SignozContextItem,
	type SignozEvidenceResult,
} from "./context";
import { redactSignozMessage } from "./redact";
import {
	isBoundedSignozPromql,
	MAX_SIGNOZ_QUERY_CHARS,
	MAX_SIGNOZ_RULES,
	MAX_SIGNOZ_SERVICE_CHARS,
	SIGNOZ_RULE_ID_PATTERN,
} from "./schemas";

/**
 * Read-only SigNoz tools (`docs/connectors/signoz.md` §6).
 *
 * Risk band: every tool here is **`read_only`**. Reads are admitted by
 * `createRiskTablePolicy` and audited; policy is not changed by this module.
 * These tools execute server-side in the worker, never in the sandbox, and the
 * API key never enters a tool argument, prompt, sandbox environment or log.
 *
 * `signoz.query_range` accepts a caller-supplied PromQL string. That is a
 * deliberate, documented narrowing of the design's "no model-authored query"
 * rule: the query is length-bounded (≤500 chars), printable-ASCII only, and
 * rejects control characters, comments, semicolons, backticks, `$` and
 * template markers; the window (15–60 min), step (≥30 s, ≤20 points), series
 * (≤5) and summary (≤1,500 chars) caps bound the scan and the evidence. SigNoz
 * queries are read-only; no tool here mutates rules, channels or data.
 *
 * The coordinator must add the three names below to `ToolName` and to the
 * `read_only` band of `SANDBOX_TOOL_RISKS`; until then they cannot be
 * registered and stay unreachable.
 */

export const SIGNOZ_TOOL_NAMES = [
	"signoz.query_range",
	"signoz.get_rule",
	"signoz.list_rules",
] as const;

export type SignozToolName = (typeof SIGNOZ_TOOL_NAMES)[number];
export type SignozToolRisk = "read_only";

export const SIGNOZ_TOOL_RISK_BANDS: Readonly<
	Record<SignozToolName, SignozToolRisk>
> = {
	"signoz.query_range": "read_only",
	"signoz.get_rule": "read_only",
	"signoz.list_rules": "read_only",
};

const serviceInputSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SIGNOZ_SERVICE_CHARS);

/** Strict: no datasource, window override beyond 60 min or unlisted key. */
export const signozQueryRangeInputSchema = z
	.strictObject({
		service: serviceInputSchema,
		query: z
			.string()
			.min(1)
			.max(MAX_SIGNOZ_QUERY_CHARS)
			// No `.trim()` here: it would strip a trailing newline before the
			// bounded-query check could reject it.
			.refine(isBoundedSignozPromql, "bounded PromQL required"),
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(15).max(60).optional(),
		stepSeconds: z.number().int().min(30).max(300).optional(),
	})
	.strict();

export const signozGetRuleInputSchema = z
	.strictObject({
		ruleId: z.string().regex(SIGNOZ_RULE_ID_PATTERN),
	})
	.strict();

export const signozListRulesInputSchema = z
	.strictObject({
		limit: z.number().int().min(1).max(MAX_SIGNOZ_RULES).optional(),
		state: z.string().trim().min(1).max(64).optional(),
		ruleType: z.string().trim().min(1).max(64).optional(),
	})
	.strict();

export type SignozQueryRangeInput = z.output<
	typeof signozQueryRangeInputSchema
>;
export type SignozGetRuleInput = z.output<typeof signozGetRuleInputSchema>;
export type SignozListRulesInput = z.output<typeof signozListRulesInputSchema>;

export type SignozToolSuccess = {
	ok: true;
	tool: SignozToolName;
	risk: SignozToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: SignozContextItem | null;
	truncated: boolean;
};

export type SignozToolFailure = {
	ok: false;
	tool: SignozToolName;
	risk: SignozToolRisk;
	code: ErrorCode;
	/** Bounded, redacted; no key, URL or provider body. */
	message: string;
};

export type SignozToolResult = SignozToolSuccess | SignozToolFailure;

function success(
	tool: SignozToolName,
	evidence: SignozEvidenceResult,
): SignozToolSuccess {
	return {
		ok: true,
		tool,
		risk: "read_only",
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: SignozToolName,
	code: ErrorCode,
	message: string,
): SignozToolFailure {
	return {
		ok: false,
		tool,
		risk: "read_only",
		code,
		message: redactSignozMessage(message),
	};
}

async function executeRead<T>(
	tool: SignozToolName,
	schema: z.ZodType<T>,
	input: unknown,
	run: (parsed: T) => Promise<SignozEvidenceResult>,
): Promise<SignozToolResult> {
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
				: "signoz tool call failed",
		);
	}
}

/**
 * `signoz.query_range` — **risk band: `read_only`**.
 *
 * One PromQL window for a service, bounded to the incident window (15–60
 * minutes). At most five series and twenty points per series, rendered as a
 * ≤1,500-char summary that is redacted before truncation.
 */
export function querySignozRange(
	dependencies: SignozContextDependencies,
	input: SignozQueryRangeInput | unknown,
): Promise<SignozToolResult> {
	return executeRead(
		"signoz.query_range",
		signozQueryRangeInputSchema,
		input,
		(parsed) =>
			fetchSignozQueryEvidence(dependencies, {
				service: parsed.service,
				query: parsed.query,
				...(parsed.startsAt === undefined ? {} : { startsAt: parsed.startsAt }),
				...(parsed.windowMinutes === undefined
					? {}
					: { windowMinutes: parsed.windowMinutes }),
				...(parsed.stepSeconds === undefined
					? {}
					: { stepSeconds: parsed.stepSeconds }),
			}),
	);
}

/**
 * `signoz.get_rule` — **risk band: `read_only`**.
 *
 * Rule metadata for an id from the signal: name, type, state, evaluation
 * window, a bounded label subset and summary/description/runbook annotations.
 * No rule history, no channel destination, no webhook URL.
 */
export function getSignozRule(
	dependencies: SignozContextDependencies,
	input: SignozGetRuleInput | unknown,
): Promise<SignozToolResult> {
	return executeRead(
		"signoz.get_rule",
		signozGetRuleInputSchema,
		input,
		(parsed) =>
			fetchSignozRuleEvidence(dependencies, { ruleId: parsed.ruleId }),
	);
}

/**
 * `signoz.list_rules` — **risk band: `read_only`**.
 *
 * At most twenty rule summaries, filtered by exact state and a rule-type
 * substring. Definitions never include expressions or destinations.
 */
export function listSignozRules(
	dependencies: SignozContextDependencies,
	input: SignozListRulesInput | unknown,
): Promise<SignozToolResult> {
	return executeRead(
		"signoz.list_rules",
		signozListRulesInputSchema,
		input,
		(parsed) =>
			fetchSignozRuleListEvidence(dependencies, {
				...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
				...(parsed.state === undefined ? {} : { state: parsed.state }),
				...(parsed.ruleType === undefined ? {} : { ruleType: parsed.ruleType }),
			}),
	);
}

export type SignozReadToolDescriptor = {
	name: SignozToolName;
	risk: SignozToolRisk;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<SignozToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS` (`read_only`); this module does not edit policy.
 */
export function createSignozReadTools(
	dependencies: SignozContextDependencies,
): readonly SignozReadToolDescriptor[] {
	return [
		{
			name: "signoz.query_range",
			risk: "read_only",
			description:
				"Bounded PromQL window for a service in the incident window.",
			inputSchema: signozQueryRangeInputSchema,
			execute: (input) => querySignozRange(dependencies, input),
		},
		{
			name: "signoz.get_rule",
			risk: "read_only",
			description: "Alert-rule metadata for an id from the signal.",
			inputSchema: signozGetRuleInputSchema,
			execute: (input) => getSignozRule(dependencies, input),
		},
		{
			name: "signoz.list_rules",
			risk: "read_only",
			description: "Bounded alert-rule summary, filterable by state and type.",
			inputSchema: signozListRulesInputSchema,
			execute: (input) => listSignozRules(dependencies, input),
		},
	];
}
