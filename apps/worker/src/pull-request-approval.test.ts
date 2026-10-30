import { describe, expect, test } from "bun:test";
import {
	buildPullRequestTarget,
	PULL_REQUEST_APPROVAL_ACTION,
	parseGitHubFullName,
	parsePullRequestApprovalEventData,
	pullRequestApprovalEventDataSchema,
	pullRequestTargetSchema,
} from "./pull-request-approval";

const TARGET = {
	repositoryFullName: "acme/widget",
	headBranch: "task/abc",
	baseBranch: "main",
	headSha: "a".repeat(40),
};

describe("pull request approval event schema", () => {
	test("accepts the exact bounded event the worker writes", () => {
		const data = {
			action: PULL_REQUEST_APPROVAL_ACTION,
			payload: TARGET,
			payloadSha256: "f".repeat(64),
			approvalId: "approval_1",
			expiresAt: "2026-10-31T00:00:00.000Z",
		};
		expect(pullRequestApprovalEventDataSchema.safeParse(data).success).toBe(
			true,
		);
		expect(parsePullRequestApprovalEventData(data)).toEqual(TARGET);
	});

	test("rejects extra fields instead of trusting a widened payload", () => {
		const widened = {
			action: PULL_REQUEST_APPROVAL_ACTION,
			payload: { ...TARGET, token: "ghs_secret" },
			extra: true,
		};
		expect(pullRequestApprovalEventDataSchema.safeParse(widened).success).toBe(
			false,
		);
		expect(parsePullRequestApprovalEventData(widened)).toBeNull();
	});

	test("rejects a different action and malformed identifiers", () => {
		expect(
			parsePullRequestApprovalEventData({
				action: "git.push_branch",
				payload: TARGET,
			}),
		).toBeNull();
		for (const payload of [
			{ ...TARGET, repositoryFullName: "not-a-full-name" },
			{ ...TARGET, headBranch: "task with spaces" },
			{ ...TARGET, baseBranch: "" },
			{ ...TARGET, headSha: "not-a-sha" },
			{ ...TARGET, headSha: "a".repeat(65) },
		]) {
			expect(pullRequestTargetSchema.safeParse(payload).success).toBe(false);
			expect(
				parsePullRequestApprovalEventData({
					action: PULL_REQUEST_APPROVAL_ACTION,
					payload,
				}),
			).toBeNull();
		}
	});

	test("ignores non-object and hostile values without throwing", () => {
		expect(parsePullRequestApprovalEventData(null)).toBeNull();
		expect(parsePullRequestApprovalEventData("event")).toBeNull();
		expect(parsePullRequestApprovalEventData([])).toBeNull();
	});
});

describe("pull request target construction", () => {
	test("builds owner/repo from a clean https GitHub URL", () => {
		expect(parseGitHubFullName("https://github.com/acme/widget.git")).toBe(
			"acme/widget",
		);
		expect(
			buildPullRequestTarget({
				repoUrl: "https://github.com/acme/widget.git",
				baseBranch: "main",
				headBranch: "task/abc",
				headSha: "a".repeat(40),
			}),
		).toEqual(TARGET);
	});

	test("returns null for non-GitHub, credential-bearing or malformed URLs", () => {
		for (const repoUrl of [
			"https://user:token@github.com/acme/widget.git",
			"https://gitlab.com/acme/widget.git",
			"https://github.com/acme/widget.git?token=x",
			"http://github.com/acme/widget.git",
			"not a url",
		]) {
			expect(() => parseGitHubFullName(repoUrl)).toThrow(/repository URL/);
			expect(
				buildPullRequestTarget({
					repoUrl,
					baseBranch: "main",
					headBranch: "task/abc",
					headSha: "a".repeat(40),
				}),
			).toBeNull();
		}
	});

	test("returns null when the head SHA is not a git object id", () => {
		expect(
			buildPullRequestTarget({
				repoUrl: "https://github.com/acme/widget.git",
				baseBranch: "main",
				headBranch: "task/abc",
				headSha: "deadbeef",
			}),
		).toBeNull();
	});
});
