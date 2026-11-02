import { describe, expect, test } from "bun:test";
import type { ApprovalItem } from "./contracts";
import { APPROVALS_PAGE_SIZE, pageApprovals } from "./paging";

function approval(index: number): ApprovalItem {
	return {
		id: `approval-${index}`,
		taskId: "33333333-3333-4333-8333-333333333333",
		action: "git.push_branch",
		actionLabel: "Push branch",
		rawStatus: "pending",
		status: "pending",
		payloadSha256: "a".repeat(64),
		requestedBy: "agent",
		createdAt: "2026-11-20T11:00:00.000Z",
		expiresAt: "2026-11-20T12:00:00.000Z",
		decidedBy: null,
		decidedAt: null,
		taskStatus: "awaiting_approval",
		repositoryName: "acme/app",
		branch: "task/approvals",
		target: {
			repositoryName: "acme/app",
			branch: "task/approvals",
			headBranch: "task/approvals",
			baseBranch: null,
			headSha: null,
			summary: "Push commits on task/approvals to acme/app.",
		},
		risk: {
			level: "high",
			label: "Writes to a remote branch",
			consequence: "Pushes the branch.",
			requiresConfirmation: true,
		},
	};
}

const ITEMS = Array.from({ length: 25 }, (_, index) => approval(index));

describe("pageApprovals", () => {
	test("slices ten per page and keeps the last page partial", () => {
		expect(APPROVALS_PAGE_SIZE).toBe(10);
		const first = pageApprovals(ITEMS, 1);
		expect(first.pageItems).toHaveLength(10);
		expect(first.pageCount).toBe(3);
		expect(first.start).toBe(0);

		const last = pageApprovals(ITEMS, 3);
		expect(last.start).toBe(20);
		expect(last.pageItems).toHaveLength(5);
		expect(last.pageItems[0]?.id).toBe("approval-20");
	});

	test("clamps a page past the end instead of returning nothing", () => {
		const slice = pageApprovals(ITEMS, 99);
		expect(slice.page).toBe(3);
		expect(slice.pageItems.at(-1)?.id).toBe("approval-24");
	});

	test("an empty section is one empty page", () => {
		const slice = pageApprovals([], 4);
		expect(slice.page).toBe(1);
		expect(slice.pageCount).toBe(1);
		expect(slice.pageItems).toEqual([]);
	});
});
