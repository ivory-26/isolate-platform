import { describe, expect, test } from "bun:test";
import { PlatformError } from "@isolate/shared";
import {
	createRiskTablePolicy,
	denyByDefault,
	type ToolName,
	type ToolPolicy,
	type ToolPolicyInput,
	type ToolRiskBand,
} from "./policy";

function policyInput(tool: ToolName): ToolPolicyInput {
	return {
		tool,
		organizationId: "org-1",
		taskId: "task-1",
		arguments: {},
		scopes: [],
	};
}

async function decide(policy: ToolPolicy, tool: ToolName) {
	return policy(policyInput(tool));
}

describe("createRiskTablePolicy band matrix", () => {
	test("read_only proceeds and is audited", async () => {
		const policy = createRiskTablePolicy({ "repo.read_file": "read_only" });
		const result = await decide(policy, "repo.read_file");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				allowed: true,
				risk: "read_only",
				audited: true,
			});
		}
	});

	test("scoped_write proceeds and is audited (ownership is enforced downstream)", async () => {
		const policy = createRiskTablePolicy({ "repo.write_file": "scoped_write" });
		const result = await decide(policy, "repo.write_file");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				allowed: true,
				risk: "scoped_write",
				audited: true,
			});
		}
	});

	test("sensitive returns APPROVAL_REQUIRED, never an allow", async () => {
		const policy = createRiskTablePolicy({
			"git.push_branch": "sensitive",
		});
		const result = await decide(policy, "git.push_branch");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(PlatformError);
			expect(result.error.code).toBe("APPROVAL_REQUIRED");
		}
	});

	test("destructive is denied", async () => {
		const policy = createRiskTablePolicy({ "db.migrate": "destructive" });
		const result = await decide(policy, "db.migrate");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("POLICY_DENIED");
		}
	});

	test("unlisted tools are denied", async () => {
		const policy = createRiskTablePolicy({});
		const result = await decide(policy, "repo.search");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("POLICY_DENIED");
		}
	});

	test("every band maps deterministically across all six tools", async () => {
		const bands: Record<ToolName, ToolRiskBand> = {
			"repo.read_file": "read_only",
			"repo.write_file": "scoped_write",
			"repo.list_files": "read_only",
			"repo.search": "read_only",
			"git.read": "read_only",
			"git.diff_summary": "read_only",
			"git.commit_local": "scoped_write",
			"git.push_branch": "sensitive",
			"github.create_pull_request": "sensitive",
			"github.merge_pull_request": "destructive",
			"db.migrate": "destructive",
			"deploy.request": "destructive",
			"sandbox.exec": "read_only",
		};
		const policy = createRiskTablePolicy(bands);
		for (const [tool, band] of Object.entries(bands) as [
			ToolName,
			ToolRiskBand,
		][]) {
			const result = await decide(policy, tool);
			if (band === "read_only" || band === "scoped_write") {
				expect(result.ok).toBe(true);
			} else if (band === "sensitive") {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.code).toBe("APPROVAL_REQUIRED");
				}
			} else {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.code).toBe("POLICY_DENIED");
				}
			}
		}
	});
});

describe("denyByDefault stays available for read-only surfaces", () => {
	test("allows read_only and routes everything else to approval/denial", async () => {
		const policy = denyByDefault({
			"repo.read_file": "read_only",
			"repo.write_file": "scoped_write",
			"github.create_pull_request": "sensitive",
		});
		const read = await decide(policy, "repo.read_file");
		expect(read.ok).toBe(true);

		const write = await decide(policy, "repo.write_file");
		expect(write.ok).toBe(false);
		if (!write.ok) {
			expect(write.error.code).toBe("APPROVAL_REQUIRED");
		}

		const pullRequest = await decide(policy, "github.create_pull_request");
		expect(pullRequest.ok).toBe(false);
		if (!pullRequest.ok) {
			expect(pullRequest.error.code).toBe("APPROVAL_REQUIRED");
		}

		const unlisted = await decide(policy, "repo.search");
		expect(unlisted.ok).toBe(false);
		if (!unlisted.ok) {
			expect(unlisted.error.code).toBe("POLICY_DENIED");
		}
	});
});
