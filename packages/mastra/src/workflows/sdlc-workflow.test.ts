import { describe, expect, test } from "bun:test";
import { err, ok, PlatformError } from "@isolate/shared";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import {
	createFakeAgentRuntime,
	type FakeAgentRuntime,
} from "../agents/runtime";
import {
	createSdlcWorkflow,
	initialSdlcState,
	REVIEW_RESUME_LABEL,
	SDLC_WORKFLOW_ID,
	type SdlcOutcome,
	SdlcOutcomeSchema,
	type SdlcRunInput,
	type SdlcValidator,
	type SdlcWorkflowDeps,
	sdlcTurnBudgetFor,
	type ValidationOutcome,
} from "./sdlc-workflow";

const INPUT: SdlcRunInput = {
	taskId: "task-42",
	organizationId: "org-7",
	goal: "Add input validation module",
	repoUrl: "https://fake.invalid/repo.git",
	baseBranch: "main",
	isolatedBranch: "task/task-42",
	fileOwnership: ["src/a.ts"],
	acceptanceCriteria: ["validation runs on submit"],
};

const alwaysPassed: SdlcValidator = async () =>
	ok({ passed: true, summary: "clean", recoverable: false });

function passingPullRequest(
	prUrl: string,
): SdlcWorkflowDeps["createPullRequest"] {
	return async () => ok({ prUrl });
}

/** Fake agent runtime whose script routes on the prompt family. */
function scriptedRuntime(
	turnBehaviour: (kind: "planning" | "executing" | "repair") => string,
): FakeAgentRuntime {
	return createFakeAgentRuntime({
		id: "fake-agent",
		script: ({ prompt }: { prompt: string }) => {
			if (prompt.includes("ONE bounded repair turn")) {
				return turnBehaviour("repair");
			}
			if (prompt.includes("implementation plan")) {
				return turnBehaviour("planning");
			}
			return turnBehaviour("executing");
		},
	});
}

function buildDeps(options: {
	runtime: FakeAgentRuntime;
	validate?: SdlcValidator;
	prUrl?: string;
}): SdlcWorkflowDeps {
	return {
		agent: options.runtime,
		validate: options.validate ?? alwaysPassed,
		createPullRequest: passingPullRequest(
			options.prUrl ?? "https://fake.invalid/pr/1",
		),
	};
}

/** Workflow harness: real Mastra workflows over an in-memory store. */
function harness(
	deps: SdlcWorkflowDeps,
	runId: string,
	maxRepairAttempts: number,
) {
	const mastra = new Mastra({
		logger: false,
		storage: new InMemoryStore({ id: "test-storage" }),
	});
	const workflow = createSdlcWorkflow(deps, { mastra });
	expect(workflow.id).toBe(SDLC_WORKFLOW_ID);
	const run = workflow.createRun({ runId });
	return run.then((handle) =>
		handle
			.start({
				inputData: INPUT,
				initialState: initialSdlcState(maxRepairAttempts),
				outputOptions: { includeState: true },
			})
			.then((result) => ({ handle, result })),
	);
}

function requireSuccess<T extends { status: string }>(
	result: T,
): Extract<T, { status: "success" }> {
	if (result.status !== "success") {
		throw new Error(`expected success, got ${String(result.status)}`);
	}
	return result as Extract<T, { status: "success" }>;
}

function requireSuspended<T extends { status: string }>(
	result: T,
): Extract<T, { status: "suspended" }> {
	if (result.status !== "suspended") {
		throw new Error(`expected suspension, got ${String(result.status)}`);
	}
	return result as Extract<T, { status: "suspended" }>;
}

function outcomeOf(result: unknown): SdlcOutcome {
	return SdlcOutcomeSchema.parse(result);
}

describe("createSdlcWorkflow (real Mastra workflows, fake runtime)", () => {
	test("validate passes once, review suspends, approval resumes into PR creation", async () => {
		const runtime = scriptedRuntime((kind) =>
			kind === "planning" ? "the plan" : "the work",
		);
		let validateCalls = 0;
		const validate: SdlcValidator = async () => {
			validateCalls += 1;
			return ok({
				passed: true,
				summary: "clean",
				recoverable: false,
			} satisfies ValidationOutcome);
		};
		const deps = buildDeps({
			runtime,
			validate,
			prUrl: "https://fake.invalid/pr/1",
		});

		const { handle, result } = await harness(deps, "run-happy", 2);
		const suspended = requireSuspended(result);
		// Budget counter is persisted through the workflow state round-trip.
		expect(suspended.state).toEqual({
			repairAttemptsUsed: 0,
			maxRepairAttempts: 2,
		});
		expect(suspended.suspendPayload).toMatchObject({
			"sdlc-review-ready": {
				taskId: "task-42",
				organizationId: "org-7",
			},
		});

		const finished = await handle.resume({
			label: REVIEW_RESUME_LABEL,
			resumeData: { approved: true },
		});
		const outcome = outcomeOf(requireSuccess(finished).result);
		expect(outcome).toEqual({
			status: "pr_created",
			prUrl: "https://fake.invalid/pr/1",
		});
		// Planning + executing turns only; repair stays untouched.
		expect(runtime.turns).toHaveLength(2);
		expect(runtime.turns.map((turn) => turn.summary)).toEqual([
			"the plan",
			"the work",
		]);
		expect(validateCalls).toBe(1);
	});

	test("bounded repair: loop body runs validation then exactly one repair turn", async () => {
		const repairPrompts: string[] = [];
		const runtime = createFakeAgentRuntime({
			script: ({ prompt }: { prompt: string }) => {
				if (prompt.includes("ONE bounded repair turn")) {
					repairPrompts.push(prompt);
					return "repaired work";
				}
				if (prompt.includes("implementation plan")) {
					return "the plan";
				}
				return "the work";
			},
		});
		let validateCall = 0;
		const validate: SdlcValidator = async () => {
			validateCall += 1;
			return validateCall === 1
				? ok({ passed: false, summary: "lint error", recoverable: true })
				: ok({ passed: true, summary: "clean", recoverable: false });
		};
		const deps = buildDeps({ runtime, validate });

		const { handle, result } = await harness(deps, "run-repair-once", 2);
		requireSuspended(result);
		const finished = await handle.resume({
			label: REVIEW_RESUME_LABEL,
			resumeData: { approved: true },
		});
		const outcome = outcomeOf(requireSuccess(finished).result);
		expect(outcome).toEqual({
			status: "pr_created",
			prUrl: "https://fake.invalid/pr/1",
		});
		expect(runtime.turns).toHaveLength(3); // planning + executing + 1 repair
		expect(repairPrompts).toHaveLength(1);
		expect(repairPrompts[0]).toContain("lint error");
		// Validation re-ran after the repaired turn (loop body revalidates).
		expect(validateCall).toBe(2);
	});

	test("repair budget exhausts and terminal failure short-circuits (bail)", async () => {
		const runtime = createFakeAgentRuntime({
			script: () => "still broken",
		});
		let validateCalls = 0;
		const validate: SdlcValidator = async () => {
			validateCalls += 1;
			return ok({
				passed: false,
				summary: "still failing",
				recoverable: true,
			});
		};
		const deps = buildDeps({ runtime, validate });

		const { result } = await harness(deps, "run-exhausted", 1);

		const outcome = outcomeOf(requireSuccess(result).result);
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" ? outcome.reason : null).toBe(
			"REPAIR_BUDGET_EXHAUSTED",
		);
		// planning + executing + exactly one repair turn for max=1: budget held.
		expect(runtime.turns).toHaveLength(3);
		expect(runtime.turns.length).toBeLessThanOrEqual(sdlcTurnBudgetFor(1));
		// Validated once for the initial work, once post-repair — never a third
		// time, because the persisted budget bailed the loop.
		expect(validateCalls).toBe(2);
	});

	test("terminal validation failure never spends a repair turn", async () => {
		const runtime = scriptedRuntime(() => "the work");
		const validate: SdlcValidator = async () =>
			ok({
				passed: false,
				summary: "broken contract",
				recoverable: false,
			});
		const deps = buildDeps({ runtime, validate });

		const { result } = await harness(deps, "run-terminal", 5);

		const outcome = outcomeOf(requireSuccess(result).result);
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" ? outcome.reason : null).toBe(
			"VALIDATION_FAILED",
		);
		expect(runtime.turns).toHaveLength(2); // no repair turn attempted
	});

	test("validator crash collapses to a bounded VALIDATION_FAILED outcome", async () => {
		const runtime = scriptedRuntime(() => "the work");
		const validate: SdlcValidator = async () =>
			err(new PlatformError("INTERNAL", "validator exploded"));
		const deps = buildDeps({ runtime, validate });

		const { result } = await harness(deps, "run-validator-crash", 3);

		const outcome = outcomeOf(requireSuccess(result).result);
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" ? outcome.reason : null).toBe(
			"VALIDATION_FAILED",
		);
		// No repair turn was attempted and no extra turn was consumed.
		expect(runtime.turns).toHaveLength(2);
	});

	test("approval rejection short-circuits to a failed outcome", async () => {
		const runtime = scriptedRuntime(() => "the work");
		const deps = buildDeps({ runtime, prUrl: "https://fake.invalid/pr/5" });

		const { handle, result } = await harness(deps, "run-rejected", 2);
		requireSuspended(result);
		const finished = await handle.resume({
			label: REVIEW_RESUME_LABEL,
			resumeData: { approved: false, rejectionReason: "rfc rejected" },
		});
		const outcome = outcomeOf(requireSuccess(finished).result);
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" ? outcome.reason : null).toBe(
			"APPROVAL_REJECTED",
		);
	});

	test("turn recording: onRecord fires once per finished turn", async () => {
		const recorded: { status: string; summary: string | null }[] = [];
		const runtime = createFakeAgentRuntime({
			script: () => "turn output",
			onRecord: (record) => {
				recorded.push({ status: record.status, summary: record.summary });
				return Promise.resolve();
			},
		});
		const deps = buildDeps({ runtime });

		const { result } = await harness(deps, "run-record", 0);
		requireSuspended(result);
		expect(recorded.map((record) => record.status)).toEqual([
			"finished",
			"finished",
		]);
		expect(recorded.every((record) => record.summary === "turn output")).toBe(
			true,
		);
	});
});
