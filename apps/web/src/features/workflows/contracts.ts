/** Fixed server cap for the workflow library read. */
export const MAX_WORKFLOW_ROWS = 100;

/**
 * Validation is derived from durable rows only:
 * - `validated`: a compiled plan exists for the latest authored version;
 * - `rejected`: the latest version has a compiler rejection and no plan;
 * - `not_compiled`: versions exist but the latest one has neither;
 * - `draft`: no versions exist yet.
 */
export type WorkflowValidationState =
	| "validated"
	| "rejected"
	| "not_compiled"
	| "draft";

export type WorkflowRejectionSummary = {
	version: number;
	issueCount: number;
	createdAt: string;
};

export type WorkflowSummary = {
	id: string;
	name: string;
	/** Author display name when the server could resolve it. */
	createdBy: string | null;
	createdAt: string;
	latestVersion: number | null;
	latestVersionAt: string | null;
	versionCount: number;
	compiledPlanCount: number;
	latestRejection: WorkflowRejectionSummary | null;
	validationState: WorkflowValidationState;
};

export type WorkflowsReadModel = {
	workflows: WorkflowSummary[];
	/** True when more definitions exist than the fixed server cap returned. */
	truncated: boolean;
};
