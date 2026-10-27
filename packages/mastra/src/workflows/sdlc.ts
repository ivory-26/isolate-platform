import type { Result } from "@isolate/shared";

/**
 * SDLC workflow contract (architecture §9): queued → planning → … → PR, with
 * a strictly bounded validating/repairing loop. Sprint B-2 wires this to real
 * `@mastra/core` workflows; for now the plan is a plain, serialisable template
 * so the compiler and worker can be built against a stable shape.
 */
export type SdlcStepDecision =
	| "continue"
	| "repair"
	| "await_approval"
	| "fail"
	| "block";

/** One compiled transition of the state machine; `guard` must be pure. */
export type SdlcStep = {
	state:
		| "planning"
		| "executing"
		| "validating"
		| "repairing"
		| "review_ready"
		| "pull_request_created";
	leafGuard: (budget: {
		repairAttemptsUsed: number;
		maxRepairAttempts: number;
	}) =>
		| { action: "proceed" }
		| { action: "repair" }
		| { action: "block"; reason: "REPAIR_BUDGET_EXHAUSTED" };
};

/** Default bounded template: validate, then at most N bounded repair passes. */
export function defaultSdlcPlan(maxRepairAttempts: number): SdlcStep[] {
	const plan: SdlcStep[] = [
		{
			state: "planning",
			leafGuard: () => ({ action: "proceed" }),
		},
		{
			state: "executing",
			leafGuard: () => ({ action: "proceed" }),
		},
	];
	for (let i = 0; i <= maxRepairAttempts; i++) {
		plan.push({
			state: "validating",
			leafGuard: (budget) =>
				budget.repairAttemptsUsed < budget.maxRepairAttempts
					? { action: "repair" }
					: { action: "block", reason: "REPAIR_BUDGET_EXHAUSTED" },
		});
		if (i < maxRepairAttempts) {
			plan.push({
				state: "repairing",
				leafGuard: () => ({ action: "proceed" }),
			});
		}
	}
	plan.push({
		state: "review_ready",
		leafGuard: () => ({ action: "proceed" }),
	});
	plan.push({
		state: "pull_request_created",
		leafGuard: () => ({ action: "proceed" }),
	});
	return plan;
}

export type SdlcWorkflowApi = {
	runOnce(input: {
		taskId: string;
		// summary of the agent output for this attempt (sanitised upstream)
		planSummary: string;
	}): Promise<Result<{ stop?: SdlcStepDecision; note?: string }>>;
};
