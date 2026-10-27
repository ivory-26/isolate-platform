import type { Result } from "@isolate/shared";
import { PlatformError } from "@isolate/shared";

/**
 * Tool policy contract (architecture §3/§8): a tool is never authorized merely
 * because an agent can call it. Every side-effecting tool resolves a
 * `PolicyDecision` through trusted code before execution.
 */
export type ToolName =
	| "repo.read_file"
	| "repo.list_files"
	| "repo.search"
	| "git.commit_local"
	| "git.push_branch"
	| "github.create_pull_request"
	| "github.merge_pull_request"
	| "db.migrate"
	| "deploy.request"
	| "sandbox.exec";

/**
 * Risk bands: low-risk actions proceed after audit; sensitive actions require
 * a persisted approval. `destructive` additionally requires human approval
 * even for admins.
 */
export type ToolRiskBand =
	| "read_only"
	| "scoped_write"
	| "sensitive"
	| "destructive";

export type ToolPolicyInput = {
	tool: ToolName;
	organizationId: string;
	taskId: string;
	// Arguments were validated against the tool's Zod schema before this point.
	arguments: Record<string, unknown>;
	scopes: string[];
};

export type PolicyDecision =
	| { allowed: true; risk: ToolRiskBand; audited: true }
	| {
			allowed: false;
			reason: "POLICY_DENIED" | "APPROVAL_REQUIRED" | "SCOPE_MISSING";
	  };

/**
 * Trusted policy interface. Implementations must be deterministic, server-only,
 * and must never delegate authorization to model output or instructions.
 */
export type ToolPolicy = (
	input: ToolPolicyInput,
) => Promise<Result<PolicyDecision>>;

/**
 * Deny-by-default reference policy helper for deny-first tool registries.
 * Sprint B-2 replaces per-registry denial reasons with scoped policy tables;
 * until then every non-read-only tool is denied.
 */
export function denyByDefault(
	riskFor: Partial<Record<ToolName, ToolRiskBand>>,
): ToolPolicy {
	return async (input): Promise<Result<PolicyDecision>> => {
		const risk = riskFor[input.tool];
		if (risk === undefined) {
			return {
				ok: false,
				error: new PlatformError(
					"POLICY_DENIED",
					`tool not allowlisted: ${input.tool}`,
				),
			};
		}
		if (risk !== "read_only") {
			return {
				ok: false,
				error: new PlatformError(
					"APPROVAL_REQUIRED",
					`${input.tool} requires approval`,
				),
			};
		}
		return { ok: true, value: { allowed: true, risk, audited: true } };
	};
}
