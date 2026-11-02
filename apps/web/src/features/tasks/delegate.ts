import type { RepositoryOption, WorkflowOption } from "../overview/contracts";
import { type SubmitTaskInput, submitTaskSchema } from "./contracts";

/**
 * Pure delegate-composer model (wave 23).
 *
 * The composer asks for a repository, a goal and optional acceptance criteria.
 * Branch, workflow and budgets have safe defaults and live under "Advanced".
 * Nothing here invents a value: a missing repository or a workflow without a
 * published version yields `null`, and the form disables instead of guessing.
 */

export const MANUAL_BRANCH_PREFIX = "task/manual-";

/** The documented default budgets, matching the previous composer values. */
export const DELEGATE_DEFAULT_BUDGETS = {
	maxAgentTurns: 12,
	repairBudget: 2,
	jobTimeoutMs: 120_000,
} as const;

export const DELEGATE_MESSAGES = {
	missingFields:
		"Choose a repository, enter a goal, and check the pinned workflow version and bounded execution limits.",
	noRepository:
		"Connect a repository before delegating a task. Connected sources create tasks without this form.",
	noPublishedWorkflow:
		"The selected workflow has no published version. Publish a version in the workflow library first.",
} as const;

/**
 * `task/manual-<short id>`: lowercase alphanumerics from a random UUID, bounded
 * to eight characters. Always satisfies the branch schema (no slashes at the
 * end, no repeated slashes).
 */
export function defaultManualBranch(randomId: string): string {
	const compact = randomId.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
	const suffix = compact.slice(0, 8);
	return `${MANUAL_BRANCH_PREFIX}${suffix.length > 0 ? suffix : "task"}`;
}

export type WorkflowSelection = {
	workflowDefinitionId: string;
	workflowVersion: number;
};

/** First definition with a published version, newest version pinned. */
export function defaultWorkflowSelection(
	workflows: readonly WorkflowOption[],
): WorkflowSelection | null {
	for (const workflow of workflows) {
		const version = workflow.versions[0];
		if (version !== undefined) {
			return { workflowDefinitionId: workflow.id, workflowVersion: version };
		}
	}
	return null;
}

/** Version choices for one definition, newest first (already ordered). */
export function versionsFor(
	workflows: readonly WorkflowOption[],
	definitionId: string,
): number[] {
	return (
		workflows.find((workflow) => workflow.id === definitionId)?.versions ?? []
	);
}

/** Default selected repository: the first imported one, or an empty value. */
export function defaultRepositoryId(
	repositories: readonly RepositoryOption[],
): string {
	return repositories[0]?.id ?? "";
}

export type DelegateFieldValues = {
	repositoryId: string;
	goal: string;
	acceptanceCriteria: string[];
	fileOwnership: string[];
	branch: string;
	workflowDefinitionId: string;
	workflowVersion: number;
	maxAgentTurns: number;
	repairBudget: number;
	jobTimeoutMs: number;
};

export type DelegateParseResult =
	| { ok: true; value: SubmitTaskInput }
	| { ok: false; message: string };

/**
 * Validates the composer with the exact schema the server function uses. The
 * idempotency key is supplied by the caller and kept stable for a retry.
 */
export function parseDelegateSubmission(
	values: DelegateFieldValues,
	idempotencyKey: string,
): DelegateParseResult {
	const parsed = submitTaskSchema.safeParse({
		repositoryId: values.repositoryId,
		branch: values.branch,
		idempotencyKey,
		workflowDefinitionId: values.workflowDefinitionId,
		workflowVersion: values.workflowVersion,
		goal: values.goal,
		acceptanceCriteria: values.acceptanceCriteria,
		fileOwnership: values.fileOwnership,
		budget: {
			maxAgentTurns: values.maxAgentTurns,
			repairBudget: values.repairBudget,
			jobTimeoutMs: values.jobTimeoutMs,
		},
	});
	if (!parsed.success) {
		return { ok: false, message: DELEGATE_MESSAGES.missingFields };
	}
	return { ok: true, value: parsed.data };
}

/** One entry per non-empty trimmed line, bounded, as the composer promises. */
export function splitComposerLines(value: string, max = 32): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(0, max);
}

/**
 * The composer is blocked (not merely validated) when there is no imported
 * repository or no published workflow version: neither can be invented.
 */
export function delegateBlockReason(input: {
	repositories: readonly RepositoryOption[];
	workflow: WorkflowSelection | null;
}): string | null {
	if (input.repositories.length === 0) return DELEGATE_MESSAGES.noRepository;
	if (input.workflow === null) return DELEGATE_MESSAGES.noPublishedWorkflow;
	return null;
}
