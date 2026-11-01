import { describe, expect, test } from "bun:test";
import type { UserRole } from "@isolate/db";
import { asOrganizationId, asUserId } from "@isolate/shared";
import {
	type ApprovalReadRepository,
	type ApprovalReadRow,
	createApprovalsReadService,
	mapApprovalItem,
} from "../../server/approvals-read.server";
import type { CallerScope } from "../../server/task-service.server";

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const USER = asUserId("22222222-2222-4222-8222-222222222222");
const NOW = new Date("2026-11-20T12:00:00.000Z");

function scope(role: UserRole = "member"): CallerScope {
	return { organizationId: ORG, userId: USER, role };
}

function row(overrides: Partial<ApprovalReadRow> = {}): ApprovalReadRow {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		taskId: "33333333-3333-4333-8333-333333333333",
		action: "git.push_branch",
		payloadSha256: "a".repeat(64),
		status: "pending",
		requestedBy: "worker",
		decidedBy: null,
		decidedAt: null,
		expiresAt: "2026-11-20T12:20:00.000Z",
		createdAt: "2026-11-20T11:50:00.000Z",
		taskStatus: "awaiting_approval",
		repositoryName: "ivory-26/agent-bank",
		branch: "task/web-demo",
		eventData: null,
		...overrides,
	};
}

const PR_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const PR_ROW = row({
	id: "55555555-5555-4555-8555-555555555555",
	action: "github.create_pull_request",
	eventData: {
		action: "github.create_pull_request",
		payloadSha256: "a".repeat(64),
		payload: {
			repositoryFullName: "ivory-26/agent-bank",
			headBranch: "task/web-demo",
			baseBranch: "main",
			headSha: PR_HEAD_SHA,
		},
	},
});

const EXPIRED_ROW = row({
	id: "66666666-6666-4666-8666-666666666666",
	expiresAt: "2026-11-20T11:00:00.000Z",
});

const APPROVED_ROW = row({
	id: "77777777-7777-4777-8777-777777777777",
	status: "approved",
	decidedBy: "user-1",
	decidedAt: "2026-11-20T11:30:00.000Z",
	taskStatus: "executing",
	expiresAt: "2026-11-20T12:10:00.000Z",
});

function fakeRepository(overrides: Partial<ApprovalReadRepository> = {}): {
	repository: ApprovalReadRepository;
	pendingCalls: CallerScope[];
	decidedCalls: CallerScope[];
} {
	const pendingCalls: CallerScope[] = [];
	const decidedCalls: CallerScope[] = [];
	const repository: ApprovalReadRepository = {
		async listPending(input) {
			pendingCalls.push(input);
			return [row(), PR_ROW, EXPIRED_ROW];
		},
		async listDecided(input) {
			decidedCalls.push(input);
			return [APPROVED_ROW];
		},
		...overrides,
	};
	return { repository, pendingCalls, decidedCalls };
}

describe("approvals read service", () => {
	test("splits actionable, expired and decided rows", async () => {
		const { repository, pendingCalls, decidedCalls } = fakeRepository();
		const snapshot = await createApprovalsReadService(repository).readApprovals(
			scope(),
			NOW,
		);

		expect(pendingCalls[0]?.organizationId).toBe(ORG);
		expect(decidedCalls[0]?.organizationId).toBe(ORG);
		expect(snapshot.generatedAt).toBe(NOW.toISOString());
		expect(snapshot.pending.map((item) => item.id)).toEqual([
			row().id,
			PR_ROW.id,
		]);
		expect(snapshot.decided.map((item) => item.id)).toEqual([
			APPROVED_ROW.id,
			EXPIRED_ROW.id,
		]);
		expect(snapshot.decided[1]?.status).toBe("expired");
		expect(snapshot.decided[0]?.status).toBe("approved");
	});

	test("the pull-request target comes from the validated event payload", async () => {
		const { repository } = fakeRepository({
			listPending: async () => [PR_ROW],
			listDecided: async () => [],
		});
		const snapshot = await createApprovalsReadService(repository).readApprovals(
			scope(),
			NOW,
		);
		const item = snapshot.pending[0];
		expect(item?.target.baseBranch).toBe("main");
		expect(item?.target.headBranch).toBe("task/web-demo");
		expect(item?.target.headSha).toBe(PR_HEAD_SHA);
		expect(item?.risk.level).toBe("high");
		expect(item?.actionLabel).toBe("Create pull request");
	});

	test("a payload hash from the request is not reused as the target", async () => {
		const item = mapApprovalItem(row(), NOW);
		expect(item.target.repositoryName).toBe("ivory-26/agent-bank");
		expect(item.target.headBranch).toBe("task/web-demo");
		expect(item.target.headSha).toBeNull();
		expect(item.status).toBe("pending");
	});

	test("stored rows keep their raw status for the decision record", async () => {
		const item = mapApprovalItem(APPROVED_ROW, NOW);
		expect(item.rawStatus).toBe("approved");
		expect(item.status).toBe("approved");
		expect(item.decidedBy).toBe("user-1");
	});
});
