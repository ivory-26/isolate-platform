import { describe, expect, test } from "bun:test";
import {
	approvalActionLabel,
	buildApprovalTarget,
	effectiveApprovalStatus,
	HIGH_IMPACT_APPROVAL_ACTIONS,
	isActionableApproval,
	riskForAction,
} from "./contracts";

const PR_EVENT = {
	action: "github.create_pull_request",
	payloadSha256: "a".repeat(64),
	payload: {
		repositoryFullName: "ivory-26/agent-bank",
		headBranch: "task/web-demo",
		baseBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
	},
};

describe("approval risk mapping", () => {
	test("push and pull-request actions are high impact and confirmable", () => {
		for (const action of HIGH_IMPACT_APPROVAL_ACTIONS) {
			const risk = riskForAction(action);
			expect(risk.level).toBe("high");
			expect(risk.requiresConfirmation).toBe(true);
			expect(risk.consequence.length).toBeGreaterThan(20);
		}
	});

	test("unknown actions are never treated as low risk", () => {
		const risk = riskForAction("db.migrate");
		expect(risk.level).toBe("unknown");
		expect(risk.requiresConfirmation).toBe(true);
	});
});

describe("approval status evaluation", () => {
	const now = new Date("2026-11-20T12:00:00.000Z");

	test("a pending row past expiry is displayed as expired", () => {
		expect(
			effectiveApprovalStatus("pending", "2026-11-20T11:59:00.000Z", now),
		).toBe("expired");
		expect(
			effectiveApprovalStatus("pending", "2026-11-20T12:01:00.000Z", now),
		).toBe("pending");
	});

	test("decided statuses are preserved", () => {
		expect(
			effectiveApprovalStatus("approved", "2026-11-20T11:00:00.000Z", now),
		).toBe("approved");
		expect(
			effectiveApprovalStatus("rejected", "2026-11-20T11:00:00.000Z", now),
		).toBe("rejected");
	});

	test("only pending approvals are actionable", () => {
		expect(isActionableApproval("pending")).toBe(true);
		expect(isActionableApproval("expired")).toBe(false);
		expect(isActionableApproval("approved")).toBe(false);
		expect(isActionableApproval("rejected")).toBe(false);
	});
});

describe("approval target description", () => {
	test("a validated pull-request payload supplies the exact branches and sha", () => {
		const target = buildApprovalTarget({
			action: "github.create_pull_request",
			repositoryName: "ivory-26/agent-bank",
			branch: "task/web-demo",
			eventData: PR_EVENT,
		});
		expect(target.headBranch).toBe("task/web-demo");
		expect(target.baseBranch).toBe("main");
		expect(target.headSha).toBe(PR_EVENT.payload.headSha);
		expect(target.summary).toContain("task/web-demo → main");
		expect(target.summary).toContain("0123456");
	});

	test("a push without a payload falls back to the task branch", () => {
		const target = buildApprovalTarget({
			action: "git.push_branch",
			repositoryName: "ivory-26/agent-bank",
			branch: "task/push-me",
			eventData: {
				action: "git.push_branch",
				payloadSha256: "b".repeat(64),
			},
		});
		expect(target.headBranch).toBe("task/push-me");
		expect(target.baseBranch).toBeNull();
		expect(target.summary).toContain("task/push-me");
	});

	test("a widened or malformed payload is ignored", () => {
		const widened = {
			...PR_EVENT,
			extra: "not allowed",
		};
		const target = buildApprovalTarget({
			action: "github.create_pull_request",
			repositoryName: "ivory-26/agent-bank",
			branch: "task/fallback",
			eventData: widened,
		});
		expect(target.headBranch).toBe("task/fallback");
		expect(target.baseBranch).toBeNull();
		expect(target.headSha).toBeNull();

		const invalid = buildApprovalTarget({
			action: "github.create_pull_request",
			repositoryName: "ivory-26/agent-bank",
			branch: "task/fallback",
			eventData: { payload: { repositoryFullName: "not a repo" } },
		});
		expect(invalid.headSha).toBeNull();
	});
});

describe("action labels", () => {
	test("known actions are humanized", () => {
		expect(approvalActionLabel("git.push_branch")).toBe("Push branch");
		expect(approvalActionLabel("github.create_pull_request")).toBe(
			"Create pull request",
		);
		expect(approvalActionLabel("db.migrate_now")).toBe("Db Migrate Now");
	});
});
