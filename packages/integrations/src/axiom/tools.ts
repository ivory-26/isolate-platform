import {
	type ErrorCode,
	isPlatformError,
	zodIssueSummary,
} from "@isolate/shared";
import { z } from "zod";
import {
	type AxiomContextDependencies,
	type AxiomContextItem,
	type AxiomEvidenceResult,
	fetchAxiomAplEvidence,
	fetchAxiomDatasetListEvidence,
	fetchAxiomMonitorEvidence,
} from "./context";
import { redactAxiomMessage } from "./redact";
import { AXIOM_MONITOR_ID_PATTERN, MAX_AXIOM_APL_CHARS } from "./schemas";

/**
 * Read-only Axiom tools (`docs/connectors/axiom.md` §6).
 *
 * Risk band: every tool here is **`read_only`**. Reads are admitted by
 * `createRiskTablePolicy` and audited; this module does not edit policy. Tools
 * execute server-side in the worker, never in the sandbox, and the Axiom token
 * never enters a tool argument, prompt, sandbox environment or log.
 *
 * `axiom.query_apl` is the only model-authored query surface. It is guarded by
 * the read-only APL allowlist in `context.ts`: one dataset-bound pipeline,
 * allowlisted operators/functions, no mutation keywords, no wildcard
 * projection, no cross-dataset join, no multiple statements. The result is
 * redacted, capped at 20 rows / 2,000 characters and never returns raw rows.
 *
 * `axiom.get_monitor` is a trusted-registry lookup, not an HTTP call: the
 * monitor read API path is UNVERIFIED, so no endpoint is invented.
 */

export const AXIOM_TOOL_NAMES = [
	"axiom.query_apl",
	"axiom.get_monitor",
	"axiom.list_datasets",
] as const;

export type AxiomToolName = (typeof AXIOM_TOOL_NAMES)[number];
export type AxiomToolRisk = "read_only";

export const AXIOM_TOOL_RISK_BANDS: Readonly<
	Record<AxiomToolName, AxiomToolRisk>
> = {
	"axiom.query_apl": "read_only",
	"axiom.get_monitor": "read_only",
	"axiom.list_datasets": "read_only",
};

/**
 * Strict: the dataset, token, API base and time range are trusted code. A
 * caller supplies only APL text and an optional incident start/window.
 */
export const axiomQueryAplInputSchema = z
	.strictObject({
		apl: z.string().trim().min(1).max(MAX_AXIOM_APL_CHARS),
		startsAt: z.iso.datetime({ offset: true }).optional(),
		windowMinutes: z.number().int().min(5).max(60).optional(),
	})
	.strict();

export const axiomGetMonitorInputSchema = z
	.strictObject({
		monitorId: z.string().regex(AXIOM_MONITOR_ID_PATTERN),
	})
	.strict();

/** The dataset list takes no arguments; strict empty object. */
export const axiomListDatasetsInputSchema = z.strictObject({}).strict();

export type AxiomQueryAplInput = z.output<typeof axiomQueryAplInputSchema>;
export type AxiomGetMonitorInput = z.output<typeof axiomGetMonitorInputSchema>;
export type AxiomListDatasetsInput = z.output<
	typeof axiomListDatasetsInputSchema
>;

export type AxiomToolSuccess = {
	ok: true;
	tool: AxiomToolName;
	risk: AxiomToolRisk;
	/** Absent evidence is `null`, never "no problem found". */
	item: AxiomContextItem | null;
	truncated: boolean;
};

export type AxiomToolFailure = {
	ok: false;
	tool: AxiomToolName;
	risk: AxiomToolRisk;
	code: ErrorCode;
	/** Bounded, redacted; no token, URL or provider body. */
	message: string;
};

export type AxiomToolResult = AxiomToolSuccess | AxiomToolFailure;

function success(
	tool: AxiomToolName,
	evidence: AxiomEvidenceResult,
): AxiomToolSuccess {
	return {
		ok: true,
		tool,
		risk: "read_only",
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: AxiomToolName,
	code: ErrorCode,
	message: string,
): AxiomToolFailure {
	return {
		ok: false,
		tool,
		risk: "read_only",
		code,
		message: redactAxiomMessage(message),
	};
}

async function executeRead<T>(
	tool: AxiomToolName,
	schema: z.ZodType<T>,
	input: unknown,
	run: (parsed: T) => Promise<AxiomEvidenceResult>,
): Promise<AxiomToolResult> {
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
			isPlatformError(throwable) ? throwable.message : "axiom tool call failed",
		);
	}
}

/**
 * `axiom.query_apl` — **risk band: `read_only`**.
 *
 * One guarded, dataset-bound APL pipeline over the incident window (5–60
 * minutes). Mutation-like operators, wildcard projections and cross-dataset
 * joins are rejected before a request is made. At most 20 rows and 2,000
 * characters are returned, after redaction of credentials and PII.
 */
export function queryAxiomApl(
	dependencies: AxiomContextDependencies,
	input: AxiomQueryAplInput | unknown,
): Promise<AxiomToolResult> {
	return executeRead(
		"axiom.query_apl",
		axiomQueryAplInputSchema,
		input,
		(parsed) =>
			fetchAxiomAplEvidence(dependencies, {
				apl: parsed.apl,
				...(parsed.startsAt === undefined ? {} : { startsAt: parsed.startsAt }),
				...(parsed.windowMinutes === undefined
					? {}
					: { windowMinutes: parsed.windowMinutes }),
			}),
	);
}

/**
 * `axiom.get_monitor` — **risk band: `read_only`**.
 *
 * Resolves a monitor id in trusted server-side configuration. There is no
 * request: the monitor read API path is UNVERIFIED, and the webhook payload
 * plus the APL aggregate are the connector's monitor evidence.
 */
export function getAxiomMonitor(
	dependencies: AxiomContextDependencies,
	input: AxiomGetMonitorInput | unknown,
): Promise<AxiomToolResult> {
	return executeRead(
		"axiom.get_monitor",
		axiomGetMonitorInputSchema,
		input,
		async (parsed) =>
			fetchAxiomMonitorEvidence(dependencies, {
				monitorId: parsed.monitorId,
			}),
	);
}

/**
 * `axiom.list_datasets` — **risk band: `read_only`**.
 *
 * One `GET /v1/datasets` call. Names and ids only, sorted, capped at 50
 * rendered entries and 2,000 redacted characters.
 */
export function listAxiomDatasets(
	dependencies: AxiomContextDependencies,
	input: AxiomListDatasetsInput | unknown = {},
): Promise<AxiomToolResult> {
	return executeRead(
		"axiom.list_datasets",
		axiomListDatasetsInputSchema,
		input,
		() => fetchAxiomDatasetListEvidence(dependencies),
	);
}

export type AxiomReadToolDescriptor = {
	name: AxiomToolName;
	risk: AxiomToolRisk;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<AxiomToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS` (`read_only`); this module does not edit policy.
 */
export function createAxiomReadTools(
	dependencies: AxiomContextDependencies,
): readonly AxiomReadToolDescriptor[] {
	return [
		{
			name: "axiom.query_apl",
			risk: "read_only",
			description:
				"Read-only, dataset-bound APL aggregate over the incident window (20 rows / 2,000 chars).",
			inputSchema: axiomQueryAplInputSchema,
			execute: (input) => queryAxiomApl(dependencies, input),
		},
		{
			name: "axiom.get_monitor",
			risk: "read_only",
			description: "Monitor metadata from the trusted server-side registry.",
			inputSchema: axiomGetMonitorInputSchema,
			execute: (input) => getAxiomMonitor(dependencies, input),
		},
		{
			name: "axiom.list_datasets",
			risk: "read_only",
			description: "Bounded list of dataset names and ids.",
			inputSchema: axiomListDatasetsInputSchema,
			execute: (input) => listAxiomDatasets(dependencies, input),
		},
	];
}
