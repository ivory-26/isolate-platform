import { describe, expect, test } from "bun:test";
import type { RunApproval } from "./contracts";
import {
	approvalActionLabel,
	approveConsequence,
	canRetryTask,
	effectiveApprovalStatus,
	eventLabel,
	eventTone,
	formatBytes,
	formatCostUsd,
	formatLogTimestamp,
	isDecidableApproval,
	isHighImpactApproval,
	isSupportedApprovalAction,
	rejectConsequence,
	safeExternalUrl,
	stableKeys,
	sumCompletionTokens,
	sumCostUsd,
	summarizeEventData,
	summarizeStatusCounts,
	sumPromptTokens,
} from "./view";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

function approval(overrides: Partial<RunApproval> = {}): RunApproval {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		action: "git.push_branch",
		status: "pending",
		payloadSha256: "a".repeat(64),
		requestedBy: "agent",
		decidedBy: null,
		decidedAt: null,
		expiresAt: "2026-11-20T13:00:00.000Z",
		createdAt: "2026-11-20T11:00:00.000Z",
		...overrides,
	};
}

describe("summarizeStatusCounts", () => {
	test("groups task statuses into operational metrics", () => {
		expect(
			summarizeStatusCounts({
				queued: 2,
				executing: 1,
				awaiting_approval: 3,
				failed: 2,
				review_ready: 1,
				pull_request_created: 1,
				completed: 4,
				cancelled: 1,
			}),
		).toEqual({
			total: 15,
			active: 6,
			awaitingApproval: 3,
			failed: 2,
			reviewReady: 6,
		});
	});

	test("ignores invalid counts and unknown statuses", () => {
		const counts = new Map<string, number>([
			["failed", 1],
			["mystery", 5],
		]);
		expect(summarizeStatusCounts(counts)).toEqual({
			total: 6,
			active: 0,
			awaitingApproval: 0,
			failed: 1,
			reviewReady: 0,
		});
		expect(summarizeStatusCounts({ failed: Number.NaN })).toEqual({
			total: 0,
			active: 0,
			awaitingApproval: 0,
			failed: 0,
			reviewReady: 0,
		});
	});
});

describe("retry eligibility", () => {
	test("only a failed task below the depth cap is retryable", () => {
		expect(canRetryTask({ status: "failed", retryDepth: 0 })).toBe(true);
		expect(canRetryTask({ status: "failed", retryDepth: 2 })).toBe(true);
		expect(canRetryTask({ status: "failed", retryDepth: 3 })).toBe(false);
		expect(canRetryTask({ status: "completed", retryDepth: 0 })).toBe(false);
		expect(canRetryTask({ status: "executing", retryDepth: 1 })).toBe(false);
	});
});

describe("approvals", () => {
	test("a pending row past its expiry is reported as expired", () => {
		expect(effectiveApprovalStatus(approval(), NOW)).toBe("pending");
		expect(isDecidableApproval(approval(), NOW)).toBe(true);
		expect(
			effectiveApprovalStatus(
				approval({ expiresAt: "2026-11-20T11:59:59.000Z" }),
				NOW,
			),
		).toBe("expired");
		expect(
			isDecidableApproval(
				approval({ expiresAt: "2026-11-20T11:59:59.000Z" }),
				NOW,
			),
		).toBe(false);
	});

	test("decided rows never become pending again", () => {
		expect(effectiveApprovalStatus(approval({ status: "approved" }), NOW)).toBe(
			"approved",
		);
		expect(effectiveApprovalStatus(approval({ status: "rejected" }), NOW)).toBe(
			"rejected",
		);
	});

	test("only push and PR actions have a server-side approve path", () => {
		expect(isSupportedApprovalAction("git.push_branch")).toBe(true);
		expect(isSupportedApprovalAction("github.create_pull_request")).toBe(true);
		expect(isSupportedApprovalAction("db.migrate")).toBe(false);
		expect(isHighImpactApproval("git.push_branch")).toBe(true);
		expect(approvalActionLabel("git.push_branch")).toBe("Push task branch");
		expect(approvalActionLabel("db.migrate")).toBe("db.migrate");
	});

	test("consequence copy names the exact side effect", () => {
		expect(approveConsequence("git.push_branch")).toContain("pushes");
		expect(approveConsequence("github.create_pull_request")).toContain(
			"pull request",
		);
		expect(approveConsequence("db.migrate")).toContain("no server-side");
		expect(rejectConsequence()).toContain("failed");
	});
});

describe("link safety", () => {
	test("only https links render as external actions", () => {
		expect(safeExternalUrl("https://github.com/acme/app/pull/1")).toBe(
			"https://github.com/acme/app/pull/1",
		);
		expect(safeExternalUrl("http://github.com/acme/app")).toBeNull();
		expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
		expect(safeExternalUrl("not a url")).toBeNull();
		expect(safeExternalUrl(null)).toBeNull();
		expect(safeExternalUrl("")).toBeNull();
	});
});

describe("event presentation", () => {
	test("known event types get readable labels and fallbacks are humanised", () => {
		expect(eventLabel("agent.turn_started")).toBe("Agent turn started");
		expect(eventLabel("custom.thing_happened")).toBe("Custom thing happened");
		expect(eventTone("approval.requested")).toBe("warning");
		expect(eventTone("pr.created")).toBe("success");
		expect(eventTone("validation.finished")).toBe("warning");
		expect(eventTone("unknown.event")).toBe("neutral");
	});

	test("event summaries stay bounded and collapse nested values", () => {
		expect(
			summarizeEventData({
				turn: 2,
				nodeId: "plan",
				status: "ok",
				nested: { secret: "not printed" },
				ignored: "not in the summary keys",
			}),
		).toBe("status=ok · nodeId=plan · turn=2");
		expect(summarizeEventData({ nested: { a: 1 } })).toBe("");
		const long = summarizeEventData({ reason: "x".repeat(400) });
		expect(long.length).toBeLessThanOrEqual(120);
		expect(long.endsWith("…")).toBe(true);
	});

	test("log timestamps are UTC with milliseconds", () => {
		expect(formatLogTimestamp("2026-11-20T12:34:56.789Z")).toBe("12:34:56.789");
		expect(formatLogTimestamp("not-a-date")).toBe("--:--:--.---");
	});

	test("stable keys disambiguate duplicate event identities", () => {
		expect(
			stableKeys(
				[
					{ at: "1", type: "a" },
					{ at: "1", type: "a" },
					{ at: "2", type: "b" },
				],
				(item) => `${item.at}-${item.type}`,
			),
		).toEqual(["1-a#1", "1-a#2", "2-b#1"]);
	});
});

describe("formatting and totals", () => {
	test("bytes and costs keep tabular, exact-ish display", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1024)).toBe("1.0 KiB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
		expect(formatBytes(null)).toBe("—");
		expect(formatCostUsd("0.001200")).toBe("$0.0012");
		expect(formatCostUsd("1.500000")).toBe("$1.50");
		expect(formatCostUsd(null)).toBe("—");
	});

	test("usage totals add only measured values", () => {
		const usage = [
			{ promptTokens: 10, completionTokens: 5, costUsd: "0.001200" },
			{ promptTokens: null, completionTokens: 7, costUsd: null },
			{ promptTokens: 3, completionTokens: null, costUsd: "0.000300" },
		];
		expect(sumPromptTokens(usage)).toBe(13);
		expect(sumCompletionTokens(usage)).toBe(12);
		expect(sumCostUsd(usage)).toBe("0.001500");
		expect(sumCostUsd([{ costUsd: null }])).toBeNull();
	});
});
