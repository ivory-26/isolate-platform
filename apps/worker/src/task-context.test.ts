import { describe, expect, test } from "bun:test";
import type { TaskContextRepository, TaskContextSourceRow } from "@isolate/db";
import { asOrganizationId, asTaskId, PlatformError } from "@isolate/shared";
import { createTaskContextLoader, toTaskContext } from "./task-context";

const ORG = asOrganizationId("11111111-1111-4111-8111-111111111111");
const TASK = asTaskId("22222222-2222-4222-8222-222222222222");

function row(
	overrides: Partial<TaskContextSourceRow> = {},
): TaskContextSourceRow {
	return {
		taskId: TASK,
		organizationId: ORG,
		status: "queued",
		goal: "Add a health endpoint",
		acceptanceCriteria: ["tests pass", "no unrelated files change"],
		fileOwnership: ["apps/web/**"],
		branch: "task/health",
		repositoryProvider: "github",
		repositoryFullName: "acme/platform",
		repositoryDefaultBranch: "main",
		budgetLimits: {
			max_agent_turns: 12,
			max_repair_attempts: 2,
			max_duration_ms: 120_000,
		},
		...overrides,
	};
}

function fakeRepository(result: TaskContextSourceRow | null): {
	repository: TaskContextRepository;
	calls: Array<{ organizationId: string; taskId: string }>;
} {
	const calls: Array<{ organizationId: string; taskId: string }> = [];
	return {
		calls,
		repository: {
			async get(input) {
				calls.push(input);
				return result;
			},
		},
	};
}

describe("toTaskContext", () => {
	test("maps the tenant-scoped row into the agent context", () => {
		expect(toTaskContext(row(), { organizationId: ORG, taskId: TASK })).toEqual(
			{
				taskId: TASK,
				organizationId: ORG,
				goal: "Add a health endpoint",
				repoUrl: "https://github.com/acme/platform.git",
				baseBranch: "main",
				isolatedBranch: "task/health",
				fileOwnership: ["apps/web/**"],
				acceptanceCriteria: ["tests pass", "no unrelated files change"],
				limits: {
					max_agent_turns: 12,
					max_repair_attempts: 2,
					max_duration_ms: 120_000,
				},
			},
		);
	});

	test("forwards a repository id when the source row exposes one", () => {
		const withId = row() as TaskContextSourceRow & { repositoryId?: string };
		withId.repositoryId = "44444444-4444-4444-8444-444444444444";
		expect(
			toTaskContext(withId, { organizationId: ORG, taskId: TASK }).repositoryId,
		).toBe("44444444-4444-4444-8444-444444444444");
		// Without the column the lock falls back to the repo URL, not a guess.
		expect(
			toTaskContext(row(), { organizationId: ORG, taskId: TASK }).repositoryId,
		).toBeUndefined();
	});

	test("rejects a mismatched organization", () => {
		expect(() =>
			toTaskContext(row(), {
				organizationId: asOrganizationId(
					"33333333-3333-4333-8333-333333333333",
				),
				taskId: TASK,
			}),
		).toThrow(PlatformError);
	});

	test("does not revive a terminal task", () => {
		expect(() =>
			toTaskContext(row({ status: "cancelled" }), {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toThrow(/not executable/);
	});

	test("rejects unsupported providers and malformed repository names", () => {
		expect(() =>
			toTaskContext(row({ repositoryProvider: "gitlab" }), {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toThrow(/unsupported repository provider/);
		expect(() =>
			toTaskContext(row({ repositoryFullName: "../outside" }), {
				organizationId: ORG,
				taskId: TASK,
			}),
		).toThrow(/invalid repository name/);
	});
});

describe("createTaskContextLoader", () => {
	test("passes the job scope through and maps the row", async () => {
		const { repository, calls } = fakeRepository(row());
		const context = await createTaskContextLoader(repository)({
			organizationId: ORG,
			taskId: TASK,
		});
		expect(calls).toEqual([{ organizationId: ORG, taskId: TASK }]);
		expect(context.goal).toBe("Add a health endpoint");
	});

	test("missing rows fail closed as NOT_FOUND", async () => {
		const { repository } = fakeRepository(null);
		await expect(
			createTaskContextLoader(repository)({
				organizationId: ORG,
				taskId: TASK,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
