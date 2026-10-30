import { describe, expect, test } from "bun:test";
import type { JobRow } from "@isolate/db";
import type {
	CreatePullRequestInput,
	PullRequestCreationResult,
} from "@isolate/integrations";
import { pullRequestApprovalPayloadSha256 } from "@isolate/integrations";
import type {
	ExecutionLifecycle,
	JobId,
	LifecycleApprovalState,
	LifecycleArtifactInput,
	LifecycleEventInput,
	LifecycleTransitionInput,
	LogFields,
	Logger,
	OrganizationId,
	PullRequestRecord,
	RunEventType,
	TaskId,
	TaskStatus,
} from "@isolate/shared";
import type { HandlerContext, HandlerVerdict } from "./contracts";
import {
	buildPullRequestBody,
	buildPullRequestTitle,
	createPullRequestHandler,
	type PullRequestTaskState,
	type PullRequestWorkflowDeps,
} from "./create-pull-request-handler";
import type { PullRequestTarget } from "./pull-request-approval";

const TASK_UUID = "3f0a2c7e-8b1d-4c2a-9e5f-6a7b8c9d0e1f";
const TASK_ID = TASK_UUID as TaskId;
const ORG_ID = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const APPROVAL_ID = "approval_pr_1";
const HEAD_SHA = "c".repeat(40);

const TARGET: PullRequestTarget = {
	repositoryFullName: "acme/widget",
	headBranch: `task/${TASK_UUID}`,
	baseBranch: "main",
	headSha: HEAD_SHA,
};

const RECORD: PullRequestRecord = {
	number: 17,
	url: "https://github.com/acme/widget/pull/17",
	headBranch: TARGET.headBranch,
	baseBranch: "main",
	headSha: HEAD_SHA,
};

type LogRecord = { severity: string; message: string; fields: LogFields };

function makeFakeLogger(sink: LogRecord[]): Logger {
	const make = (base: LogFields): Logger => ({
		debug: (m, f) =>
			sink.push({ severity: "debug", message: m, fields: { ...base, ...f } }),
		info: (m, f) =>
			sink.push({ severity: "info", message: m, fields: { ...base, ...f } }),
		warn: (m, f) =>
			sink.push({ severity: "warn", message: m, fields: { ...base, ...f } }),
		error: (m, f) =>
			sink.push({ severity: "error", message: m, fields: { ...base, ...f } }),
		child: (f) => make({ ...base, ...f }),
	});
	return make({});
}

type LifecycleCall =
	| { kind: "transition"; from: TaskStatus; to: TaskStatus }
	| {
			kind: "event";
			type: RunEventType;
			data: Readonly<Record<string, unknown>> | undefined;
	  }
	| { kind: "approvalStatus"; approvalId: string };

class FakeLifecycle implements ExecutionLifecycle {
	calls: LifecycleCall[] = [];
	approval: LifecycleApprovalState | null = null;

	async transition(input: LifecycleTransitionInput): Promise<void> {
		this.calls.push({ kind: "transition", from: input.from, to: input.to });
	}

	async event(input: LifecycleEventInput): Promise<void> {
		this.calls.push({ kind: "event", type: input.type, data: input.data });
	}

	async artifact(
		_input: LifecycleArtifactInput,
	): Promise<{ artifactId: string }> {
		return { artifactId: "artifact_1" };
	}

	async attemptStarted(): Promise<{
		attemptId: string;
		attemptIndex: number;
	}> {
		return { attemptId: "attempt_1", attemptIndex: 1 };
	}

	async attemptFinished(): Promise<void> {}

	async approvalRequested(): Promise<{ approvalId: string }> {
		return { approvalId: APPROVAL_ID };
	}

	async approvalStatus(input: {
		organizationId: OrganizationId;
		taskId: TaskId;
		approvalId: string;
	}): Promise<LifecycleApprovalState | null> {
		this.calls.push({ kind: "approvalStatus", approvalId: input.approvalId });
		return this.approval;
	}

	async isCancelled(): Promise<boolean> {
		return false;
	}
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
	return {
		id: "job_pr" as JobId,
		organizationId: ORG_ID,
		taskId: TASK_ID,
		type: "create_pull_request",
		payload: { taskId: TASK_UUID, approvalId: APPROVAL_ID },
		status: "claimed",
		attempts: 1,
		maxAttempts: 3,
		lease: null,
		notBefore: "2026-10-30T00:00:00.000Z",
		enqueueUuidKey: "enqueue_pr",
		lastError: null,
		createdAt: "2026-10-30T00:00:00.000Z",
		...overrides,
	};
}

type HarnessOptions = {
	taskState?: PullRequestTaskState | null;
	target?: PullRequestTarget | null;
	approval?: LifecycleApprovalState | null;
	connectorResult?: PullRequestCreationResult;
	lifecycle?: FakeLifecycle;
	job?: JobRow;
};

type MutableTaskState = {
	status: TaskStatus;
	pullRequestNumber: number | null;
	pullRequestUrl: string | null;
};

function makeHarness(options: HarnessOptions = {}) {
	const logs: LogRecord[] = [];
	const lifecycle = options.lifecycle ?? new FakeLifecycle();
	lifecycle.approval =
		options.approval === undefined
			? { status: "approved", payloadSha256: "" }
			: options.approval;
	const taskState: MutableTaskState | null =
		options.taskState === undefined
			? {
					status: "awaiting_approval",
					pullRequestNumber: null,
					pullRequestUrl: null,
				}
			: options.taskState === null
				? null
				: { ...options.taskState };
	const target = options.target === undefined ? TARGET : options.target;
	const createCalls: Array<
		CreatePullRequestInput & { organizationId: OrganizationId }
	> = [];
	const recordCalls: Array<{
		organizationId: OrganizationId;
		taskId: TaskId;
		pullRequestNumber: number;
		pullRequestUrl: string;
	}> = [];
	const connectorResult = options.connectorResult;

	const deps: PullRequestWorkflowDeps = {
		lifecycle,
		loadTaskState: async () => taskState,
		loadPullRequestTarget: async () => target,
		recordPullRequest: async (input) => {
			recordCalls.push(input);
			if (taskState !== null) {
				taskState.pullRequestNumber = input.pullRequestNumber;
				taskState.pullRequestUrl = input.pullRequestUrl;
			}
			return { ok: true };
		},
		createPullRequest: async (input) => {
			createCalls.push(structuredClone(input));
			return (
				connectorResult ??
				({ ok: true, pullRequest: RECORD, created: true } as const)
			);
		},
	};

	let controller = new AbortController();
	const ctx: HandlerContext = {
		logger: makeFakeLogger(logs),
		get signal() {
			return controller.signal;
		},
		heartbeat: async () => true,
	};

	return {
		handler: createPullRequestHandler(deps),
		lifecycle,
		ctx,
		logs,
		taskState,
		target,
		createCalls,
		recordCalls,
		job: options.job ?? makeJob(),
		abort: () => {
			controller.abort();
			controller = new AbortController();
		},
	};
}

function transitionPairs(
	lifecycle: FakeLifecycle,
): Array<[TaskStatus, TaskStatus]> {
	const pairs: Array<[TaskStatus, TaskStatus]> = [];
	for (const call of lifecycle.calls) {
		if (call.kind === "transition") pairs.push([call.from, call.to]);
	}
	return pairs;
}

async function approvedSha(): Promise<string> {
	return pullRequestApprovalPayloadSha256(TARGET);
}

describe("create_pull_request handler — approval verification", () => {
	test("an approved matching payload records the PR, transitions and emits pr.created", async () => {
		const harness = makeHarness();
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};

		const verdict: HandlerVerdict = await harness.handler.handle(
			harness.job,
			harness.ctx,
		);

		expect(verdict).toEqual({
			outcome: "complete",
			note: "pull request created",
		});
		expect(harness.createCalls).toHaveLength(1);
		expect(harness.createCalls[0]).toEqual({
			organizationId: ORG_ID,
			repositoryFullName: TARGET.repositoryFullName,
			headBranch: TARGET.headBranch,
			baseBranch: TARGET.baseBranch,
			headSha: TARGET.headSha,
			title: buildPullRequestTitle(TASK_UUID),
			body: buildPullRequestBody({ taskId: TASK_UUID, target: TARGET }),
			expectedPayloadSha256: await approvedSha(),
		});
		expect(harness.recordCalls).toEqual([
			{
				organizationId: ORG_ID,
				taskId: TASK_ID,
				pullRequestNumber: RECORD.number,
				pullRequestUrl: RECORD.url,
			},
		]);
		expect(transitionPairs(harness.lifecycle)).toEqual([
			["awaiting_approval", "pull_request_created"],
		]);
		const created = harness.lifecycle.calls.find(
			(call) => call.kind === "event" && call.type === "pr.created",
		);
		expect(created).toEqual({
			kind: "event",
			type: "pr.created",
			data: RECORD,
		});
		expect(
			harness.lifecycle.calls.some((call) => call.kind === "approvalStatus"),
		).toBe(true);
	});

	test("a pending approval waits instead of consuming the job", async () => {
		// Enqueue-before-decide: the job can fire before the human answers.
		const harness = makeHarness({
			approval: { status: "pending", payloadSha256: await approvedSha() },
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "retry",
			code: "APPROVAL_REQUIRED",
			backoffMs: 60_000,
		});
		expect(harness.createCalls).toHaveLength(0);
		expect(harness.recordCalls).toHaveLength(0);
	});

	test("a rejected approval creates no PR and does not retry", async () => {
		const harness = makeHarness({
			approval: { status: "rejected", payloadSha256: await approvedSha() },
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "complete", note: "approval rejected" });
		expect(harness.createCalls).toHaveLength(0);
		expect(harness.recordCalls).toHaveLength(0);
		expect(harness.lifecycle.calls).toEqual([
			{ kind: "approvalStatus", approvalId: APPROVAL_ID },
		]);
	});

	test("an expired approval creates no PR and does not retry", async () => {
		const harness = makeHarness({
			approval: { status: "expired", payloadSha256: await approvedSha() },
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "complete", note: "approval expired" });
		expect(harness.createCalls).toHaveLength(0);
	});

	test("a payload SHA mismatch creates no PR", async () => {
		const harness = makeHarness({
			approval: { status: "approved", payloadSha256: "d".repeat(64) },
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "approval payload mismatch",
		});
		expect(harness.createCalls).toHaveLength(0);
		expect(harness.recordCalls).toHaveLength(0);
	});

	test("an absent approval record creates no PR", async () => {
		const harness = makeHarness({ approval: null });
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "approval not found",
		});
		expect(harness.createCalls).toHaveLength(0);
	});

	test("an unavailable target creates no PR", async () => {
		const harness = makeHarness({ target: null });
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "pull request target unavailable",
		});
		expect(harness.createCalls).toHaveLength(0);
	});
});

describe("create_pull_request handler — idempotency and eligibility", () => {
	test("a redelivery after success returns the recorded PR without a second call", async () => {
		const harness = makeHarness();
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		const first = await harness.handler.handle(harness.job, harness.ctx);
		const second = await harness.handler.handle(harness.job, harness.ctx);

		expect(first).toEqual({
			outcome: "complete",
			note: "pull request created",
		});
		expect(second).toEqual({
			outcome: "complete",
			note: "pull request already recorded",
		});
		expect(harness.createCalls).toHaveLength(1);
		expect(harness.recordCalls).toHaveLength(1);
		// Only the first run read the approval.
		expect(
			harness.lifecycle.calls.filter((call) => call.kind === "approvalStatus"),
		).toHaveLength(1);
	});

	test("a task that already reached pull_request_created is an idempotent success", async () => {
		const harness = makeHarness({
			taskState: {
				status: "pull_request_created",
				pullRequestNumber: RECORD.number,
				pullRequestUrl: RECORD.url,
			},
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "pull request already recorded",
		});
		expect(harness.createCalls).toHaveLength(0);
	});

	test("a task with a recorded number is never given a second PR", async () => {
		const harness = makeHarness({
			taskState: {
				status: "awaiting_approval",
				pullRequestNumber: 99,
				pullRequestUrl: "https://github.com/acme/widget/pull/99",
			},
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "pull request already recorded",
		});
		expect(harness.createCalls).toHaveLength(0);
	});

	test("a cancelled task never creates a pull request", async () => {
		const harness = makeHarness({
			taskState: {
				status: "cancelled",
				pullRequestNumber: null,
				pullRequestUrl: null,
			},
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "complete", note: "task not eligible" });
		expect(harness.createCalls).toHaveLength(0);
	});

	test("a task that is not awaiting approval creates no PR", async () => {
		const harness = makeHarness({
			taskState: {
				status: "executing",
				pullRequestNumber: null,
				pullRequestUrl: null,
			},
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "complete",
			note: "task not awaiting pull request approval",
		});
		expect(harness.createCalls).toHaveLength(0);
	});

	test("a missing task is a bounded dead letter", async () => {
		const harness = makeHarness({ taskState: null });
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "NOT_FOUND",
			note: "task not found",
		});
		expect(harness.createCalls).toHaveLength(0);
	});
});

describe("create_pull_request handler — connector failures", () => {
	test("an integration failure retries with a bounded code", async () => {
		const harness = makeHarness({
			connectorResult: {
				ok: false,
				code: "INTEGRATION_UNAVAILABLE",
				message: "github api returned status 502",
			},
		});
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "retry",
			code: "INTEGRATION_UNAVAILABLE",
		});
		expect(harness.recordCalls).toHaveLength(0);
	});

	test("a policy failure is a bounded dead letter with no secret text", async () => {
		const harness = makeHarness({
			connectorResult: {
				ok: false,
				code: "POLICY_DENIED",
				message:
					"branch changed at https://user:token@github.com/acme/widget.git",
			},
		});
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict.outcome).toBe("dead_letter");
		expect(verdict).toMatchObject({ code: "POLICY_DENIED" });
		expect(JSON.stringify(verdict)).not.toContain("token");
		expect(JSON.stringify(verdict)).not.toContain("https");
		expect(JSON.stringify(harness.logs)).not.toContain("token");
	});

	test("a rate limit retries", async () => {
		const harness = makeHarness({
			connectorResult: {
				ok: false,
				code: "RATE_LIMITED",
				message: "rate limited",
			},
		});
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({ outcome: "retry", code: "RATE_LIMITED" });
	});
});

describe("create_pull_request handler — payload and leak surface", () => {
	test("supports() requires a UUID taskId and a bounded approvalId", () => {
		const harness = makeHarness();
		expect(harness.handler.jobType).toBe("create_pull_request");
		expect(
			harness.handler.supports({ taskId: TASK_UUID, approvalId: APPROVAL_ID }),
		).toBe(true);
		const invalid: unknown[] = [
			{},
			{ taskId: TASK_UUID },
			{ taskId: TASK_UUID, approvalId: "bad id!" },
			{ taskId: "not-a-uuid", approvalId: APPROVAL_ID },
			null,
			[],
		];
		for (const payload of invalid) {
			expect(() =>
				harness.handler.supports(payload as Record<string, unknown>),
			).not.toThrow();
			expect(harness.handler.supports(payload as Record<string, unknown>)).toBe(
				false,
			);
		}
	});

	test("a malformed payload is rejected before any storage or network call", async () => {
		const harness = makeHarness({
			job: makeJob({ payload: { taskId: TASK_UUID } }),
		});
		const verdict = await harness.handler.handle(harness.job, harness.ctx);
		expect(verdict).toEqual({
			outcome: "dead_letter",
			code: "VALIDATION_FAILED",
			note: "job payload rejected by handler",
		});
		expect(harness.lifecycle.calls).toHaveLength(0);
		expect(harness.createCalls).toHaveLength(0);
	});

	test("the PR event carries only the bounded record, never metadata or tokens", async () => {
		const harness = makeHarness();
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};
		await harness.handler.handle(harness.job, harness.ctx);
		const created = harness.lifecycle.calls.find(
			(call): call is Extract<LifecycleCall, { kind: "event" }> =>
				call.kind === "event" && call.type === "pr.created",
		);
		expect(created?.data).toEqual(RECORD);
		expect(JSON.stringify(harness.lifecycle.calls)).not.toContain("token");
		expect(JSON.stringify(harness.logs)).not.toContain("token");
		expect(buildPullRequestTitle(TASK_UUID).length).toBeLessThanOrEqual(256);
		expect(
			buildPullRequestBody({ taskId: TASK_UUID, target: TARGET }).length,
		).toBeLessThanOrEqual(20_000);
	});
});

describe("create_pull_request handler — wave 11 metrics", () => {
	function prMetric(logs: LogRecord[]): LogFields | undefined {
		return logs.find((log) => log.message === "isolate.metric")?.fields;
	}

	test("a created pull request emits outcome created with no payload text", async () => {
		const harness = makeHarness();
		harness.lifecycle.approval = {
			status: "approved",
			payloadSha256: await approvedSha(),
		};

		await harness.handler.handle(harness.job, harness.ctx);

		expect(prMetric(harness.logs)).toEqual({
			metric: "worker.pr.outcome",
			taskId: TASK_ID,
			outcome: "created",
		});
		const serialized = JSON.stringify(harness.logs);
		expect(serialized).not.toContain("Automated change");
		expect(serialized).not.toContain("repositoryFullName");
	});

	test("an ineligible task emits outcome skipped", async () => {
		const harness = makeHarness({
			taskState: {
				status: "failed",
				pullRequestNumber: null,
				pullRequestUrl: null,
			},
		});

		await harness.handler.handle(harness.job, harness.ctx);

		expect(prMetric(harness.logs)).toMatchObject({
			metric: "worker.pr.outcome",
			outcome: "skipped",
			code: "TASK_NOT_ELIGIBLE",
		});
	});
});
