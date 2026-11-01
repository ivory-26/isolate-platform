import { z } from "zod";

/**
 * Client-safe approval surface contracts.
 *
 * An approval authorizes exactly one bounded action against one payload hash.
 * These helpers classify impact and describe the target without ever exposing
 * a raw event payload: the only payload fields that may leave the server are
 * the closed set below (repository, branches, commit sha).
 */

export type ApprovalStatusValue =
	| "pending"
	| "approved"
	| "rejected"
	| "expired";

export type ApprovalRiskLevel = "high" | "medium" | "low" | "unknown";

export type ApprovalRisk = {
	level: ApprovalRiskLevel;
	label: string;
	/** Operator-facing consequence; never derived from a payload value. */
	consequence: string;
	/** Whether the UI must confirm before submitting the decision. */
	requiresConfirmation: boolean;
};

/** Actions whose follow-up job mutates a shared, externally visible target. */
export const HIGH_IMPACT_APPROVAL_ACTIONS = [
	"git.push_branch",
	"github.create_pull_request",
] as const;

const RISK: Record<string, ApprovalRisk> = {
	"git.push_branch": {
		level: "high",
		label: "Writes to a remote branch",
		consequence:
			"Approving pushes the task branch with its commits to the remote repository. Anyone with repository access can see the branch, and the push can trigger CI.",
		requiresConfirmation: true,
	},
	"github.create_pull_request": {
		level: "high",
		label: "Visible to collaborators",
		consequence:
			"Approving opens a pull request against the base branch. Repository collaborators can see it, and it can trigger CI and review notifications.",
		requiresConfirmation: true,
	},
};

/**
 * Unknown actions are never presented as low risk: without a documented
 * consequence the UI must still ask for an explicit confirmation.
 */
export function riskForAction(action: string): ApprovalRisk {
	return (
		RISK[action] ?? {
			level: "unknown",
			label: "Unverified impact",
			consequence:
				"This action has no documented consequence in the control plane. Review the task, scope and payload hash before approving.",
			requiresConfirmation: true,
		}
	);
}

const ACTION_LABELS: Record<string, string> = {
	"git.push_branch": "Push branch",
	"github.create_pull_request": "Create pull request",
};

export function approvalActionLabel(action: string): string {
	return (
		ACTION_LABELS[action] ??
		action
			.replaceAll(/[._-]+/g, " ")
			.replace(/\b\w/g, (letter) => letter.toUpperCase())
	);
}

/**
 * A pending row can pass its expiry before a sweep flips its stored status.
 * The UI treats that as expired so a stale approval is never actionable.
 */
export function effectiveApprovalStatus(
	status: ApprovalStatusValue,
	expiresAt: string,
	now: Date,
): ApprovalStatusValue {
	if (status !== "pending") return status;
	const expiry = Date.parse(expiresAt);
	if (!Number.isFinite(expiry)) return status;
	return expiry <= now.getTime() ? "expired" : "pending";
}

export function isActionableApproval(status: ApprovalStatusValue): boolean {
	return status === "pending";
}

const branchSchema = z.string().min(1).max(255);
const shaSchema = z.string().regex(/^[a-fA-F0-9]{7,64}$/);
const repositoryFullNameSchema = z
	.string()
	.min(3)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * The stored `approval.requested` event shape. Extra keys make the event
 * unreadable (strict), which only means the UI falls back to task context.
 */
export const approvalEventDataSchema = z
	.object({
		action: z.string().min(1).max(128),
		approvalId: z.uuid().optional(),
		payloadSha256: z
			.string()
			.regex(/^[a-fA-F0-9]{64}$/)
			.optional(),
		expiresAt: z.string().min(1).max(64).optional(),
		payload: z
			.object({
				repositoryFullName: repositoryFullNameSchema,
				headBranch: branchSchema,
				baseBranch: branchSchema,
				headSha: shaSchema,
			})
			.strict()
			.optional(),
	})
	.strict();

export type ApprovalEventData = z.infer<typeof approvalEventDataSchema>;

export type ApprovalTarget = {
	repositoryName: string;
	/** The branch the task may mutate. */
	branch: string;
	headBranch: string;
	baseBranch: string | null;
	headSha: string | null;
	summary: string;
};

/**
 * Describes where an approval would act. Only validated event payload fields
 * are used; everything else falls back to the tenant-scoped task/repository
 * join. No payload is returned as free text.
 */
export function buildApprovalTarget(input: {
	action: string;
	repositoryName: string;
	branch: string;
	eventData: unknown;
}): ApprovalTarget {
	const parsed = approvalEventDataSchema.safeParse(input.eventData);
	const payload = parsed.success ? parsed.data.payload : undefined;
	const repositoryName = payload?.repositoryFullName ?? input.repositoryName;
	const headBranch = payload?.headBranch ?? input.branch;
	const baseBranch = payload?.baseBranch ?? null;
	const headSha = payload?.headSha ?? null;

	if (input.action === "github.create_pull_request") {
		return {
			repositoryName,
			branch: input.branch,
			headBranch,
			baseBranch,
			headSha,
			summary: `Open pull request ${headBranch} → ${baseBranch ?? "the default branch"} in ${repositoryName}${headSha ? ` at ${headSha.slice(0, 7)}` : ""}.`,
		};
	}
	if (input.action === "git.push_branch") {
		return {
			repositoryName,
			branch: input.branch,
			headBranch,
			baseBranch,
			headSha,
			summary: `Push commits on ${headBranch} to ${repositoryName}.`,
		};
	}
	return {
		repositoryName,
		branch: input.branch,
		headBranch,
		baseBranch,
		headSha,
		summary: `${approvalActionLabel(input.action)} on ${repositoryName}.`,
	};
}

export type ApprovalItem = {
	id: string;
	taskId: string;
	action: string;
	actionLabel: string;
	/** Stored status, before expiry evaluation. */
	rawStatus: ApprovalStatusValue;
	/** Displayed status; pending rows past expiry become expired. */
	status: ApprovalStatusValue;
	payloadSha256: string;
	requestedBy: string;
	createdAt: string;
	expiresAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	taskStatus: string;
	repositoryName: string;
	branch: string;
	target: ApprovalTarget;
	risk: ApprovalRisk;
};

export type ApprovalsSnapshot = {
	pending: ApprovalItem[];
	/** Decided rows plus pending rows that expired without a decision. */
	decided: ApprovalItem[];
	generatedAt: string;
};

export const APPROVAL_LIMITS = {
	pending: 50,
	decided: 20,
} as const;
