import { isPlatformError } from "@isolate/shared";
import { z } from "zod";
import {
	fetchHoneycombQueryEvidence,
	fetchHoneycombSloEvidence,
	fetchHoneycombTriggerEvidence,
} from "./context";
import {
	honeycombQueryKindSchema,
	honeycombServiceSchema,
	honeycombTriggerIdSchema,
} from "./schemas";
import type {
	HoneycombEvidence,
	HoneycombToolDependencies,
	HoneycombToolErrorCode,
	HoneycombToolFailure,
	HoneycombToolName,
	HoneycombToolResult,
	HoneycombToolSuccess,
} from "./types";

/**
 * Honeycomb read-only agent tools (`docs/connectors/honeycomb.md` §6).
 *
 * Every tool is risk band `read_only`: it executes server-side in the worker,
 * never in the sandbox, and the configuration key never enters a tool
 * argument, prompt, sandbox environment or log. Inputs are strict; a caller
 * cannot supply a calculation, filter, dataset, URL or time range. Results are
 * redacted and capped before return.
 *
 * `honeycomb.get_trigger` deliberately performs **no** provider call: trigger
 * detail comes from the snapshot captured at intake, because fetching the full
 * definition may expose recipient lists and webhook URLs. Writes and trigger
 * create/update are out of scope.
 */

export const HONEYCOMB_READ_TOOL_RISK = "read_only" as const;

export const honeycombRunQueryInputSchema = z.strictObject({
	kind: honeycombQueryKindSchema,
	service: honeycombServiceSchema,
	windowMinutes: z.number().int().min(1).max(60).optional(),
});
export type HoneycombRunQueryInput = z.output<
	typeof honeycombRunQueryInputSchema
>;

export const honeycombGetTriggerInputSchema = z.strictObject({
	triggerId: honeycombTriggerIdSchema,
});
export type HoneycombGetTriggerInput = z.output<
	typeof honeycombGetTriggerInputSchema
>;

export const honeycombListSlosInputSchema = z.strictObject({});
export type HoneycombListSlosInput = z.output<
	typeof honeycombListSlosInputSchema
>;

function success(
	tool: HoneycombToolName,
	evidence: HoneycombEvidence,
): HoneycombToolSuccess {
	return {
		ok: true,
		tool,
		risk: HONEYCOMB_READ_TOOL_RISK,
		item: evidence.item,
		truncated: evidence.truncated,
	};
}

function failure(
	tool: HoneycombToolName,
	code: HoneycombToolErrorCode,
): HoneycombToolFailure {
	return {
		ok: false,
		tool,
		risk: HONEYCOMB_READ_TOOL_RISK,
		code,
		message: "honeycomb tool call failed",
	};
}

function mapFailure(error: unknown): HoneycombToolErrorCode {
	if (!isPlatformError(error)) return "INTEGRATION_UNAVAILABLE";
	switch (error.code) {
		case "VALIDATION_FAILED":
		case "NOT_FOUND":
		case "POLICY_DENIED":
		case "RATE_LIMITED":
		case "INTEGRATION_UNAVAILABLE":
			return error.code;
		default:
			return "INTEGRATION_UNAVAILABLE";
	}
}

function queryFailureCode(failure: HoneycombEvidence["failure"]) {
	switch (failure) {
		case "denied":
			return "POLICY_DENIED" as const;
		case "missing":
			return "NOT_FOUND" as const;
		case "failed":
		case "malformed":
			return "INTEGRATION_UNAVAILABLE" as const;
		case "none":
			return null;
	}
}

/**
 * `honeycomb.run_query` — **risk band: `read_only`**.
 *
 * One fixed template (latency, error rate or saturation) over the service from
 * the signal. Exactly create → run → fetch, ≤20 rows, ≤2,000-char summary.
 */
export async function runHoneycombQuery(
	dependencies: HoneycombToolDependencies,
	input: HoneycombRunQueryInput | unknown,
): Promise<HoneycombToolResult> {
	const parsed = honeycombRunQueryInputSchema.safeParse(input);
	if (!parsed.success) {
		return failure("honeycomb.run_query", "VALIDATION_FAILED");
	}
	try {
		const evidence = await fetchHoneycombQueryEvidence(
			dependencies,
			parsed.data,
		);
		const code = queryFailureCode(evidence.failure);
		if (code !== null) return failure("honeycomb.run_query", code);
		return success("honeycomb.run_query", evidence);
	} catch (error) {
		return failure("honeycomb.run_query", mapFailure(error));
	}
}

/**
 * `honeycomb.get_trigger` — **risk band: `read_only`**.
 *
 * Re-reads the bounded trigger snapshot from the incident. No provider call is
 * made, so recipients and webhook URLs never leave the intake path.
 */
export async function getHoneycombTrigger(
	dependencies: HoneycombToolDependencies,
	input: HoneycombGetTriggerInput | unknown,
): Promise<HoneycombToolResult> {
	const parsed = honeycombGetTriggerInputSchema.safeParse(input);
	if (!parsed.success) {
		return failure("honeycomb.get_trigger", "VALIDATION_FAILED");
	}
	try {
		const evidence = await fetchHoneycombTriggerEvidence(
			dependencies,
			parsed.data.triggerId,
		);
		if (evidence.item === null) {
			return failure(
				"honeycomb.get_trigger",
				evidence.failure === "malformed"
					? "INTEGRATION_UNAVAILABLE"
					: "NOT_FOUND",
			);
		}
		return success("honeycomb.get_trigger", evidence);
	} catch (error) {
		return failure("honeycomb.get_trigger", mapFailure(error));
	}
}

/**
 * `honeycomb.list_slos` — **risk band: `read_only`**.
 *
 * The dataset's SLO state. The Free plan has no SLOs: an empty list, 403 or 404
 * is a successful call with `item: null` and `truncated: true`, never an error.
 * Only 5xx, malformed JSON, 401, 429 and transport failures are failures.
 */
export async function listHoneycombSlos(
	dependencies: HoneycombToolDependencies,
	input: HoneycombListSlosInput | unknown,
): Promise<HoneycombToolResult> {
	const parsed = honeycombListSlosInputSchema.safeParse(input ?? {});
	if (!parsed.success) {
		return failure("honeycomb.list_slos", "VALIDATION_FAILED");
	}
	try {
		const evidence = await fetchHoneycombSloEvidence(dependencies, {});
		if (evidence.failure === "failed" || evidence.failure === "malformed") {
			return failure("honeycomb.list_slos", "INTEGRATION_UNAVAILABLE");
		}
		return success("honeycomb.list_slos", evidence);
	} catch (error) {
		return failure("honeycomb.list_slos", mapFailure(error));
	}
}

export type HoneycombReadToolDescriptor = {
	name: HoneycombToolName;
	risk: typeof HONEYCOMB_READ_TOOL_RISK;
	description: string;
	inputSchema: z.ZodType<unknown>;
	execute(input: unknown): Promise<HoneycombToolResult>;
};

/**
 * Registry-ready descriptors. The coordinator adds these names to `ToolName`
 * and `SANDBOX_TOOL_RISKS`; this module does not edit policy or barrels.
 */
export function createHoneycombReadTools(
	dependencies: HoneycombToolDependencies,
): readonly HoneycombReadToolDescriptor[] {
	return [
		{
			name: "honeycomb.run_query",
			risk: HONEYCOMB_READ_TOOL_RISK,
			description:
				"Fixed latency/error-rate/saturation query for one service (≤20 rows).",
			inputSchema: honeycombRunQueryInputSchema,
			execute: (input) => runHoneycombQuery(dependencies, input),
		},
		{
			name: "honeycomb.get_trigger",
			risk: HONEYCOMB_READ_TOOL_RISK,
			description: "Bounded trigger metadata captured with the incident.",
			inputSchema: honeycombGetTriggerInputSchema,
			execute: (input) => getHoneycombTrigger(dependencies, input),
		},
		{
			name: "honeycomb.list_slos",
			risk: HONEYCOMB_READ_TOOL_RISK,
			description: "Dataset SLO state; empty on the Free plan.",
			inputSchema: honeycombListSlosInputSchema,
			execute: (input) => listHoneycombSlos(dependencies, input),
		},
	];
}
