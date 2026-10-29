import { describe, expect, test } from "bun:test";
import type { WorkflowVersionRow } from "@isolate/db";
import {
	InMemoryCompiledPlanRepository,
	InMemoryQueueRepository,
	InMemoryTaskRepository,
	InMemoryWorkflowRejectionRepository,
} from "@isolate/db/testing";
import {
	asOrganizationId,
	asUserId,
	asWorkflowDefinitionId,
	asWorkflowVersionId,
	type OrganizationId,
	type WorkflowDefinitionId,
} from "@isolate/shared";
import type { WorkflowDefinition } from "@isolate/workflow-schema";
import type { SubmitTaskInput } from "../features/tasks/contracts";
import { createRepositoryStore } from "./repository-store.server";
import { createSubmissionCompiler } from "./submission-compilation.server";
import { type CallerScope, createTaskService } from "./task-service.server";
import { input } from "./test-fixtures";
import type { AuthoredWorkflowVersionReader } from "./workflow-compilation.server";

const orgA = asOrganizationId("50000000-0000-4000-8000-000000000001");
const orgB = asOrganizationId("50000000-0000-4000-8000-000000000002");
const userA = asUserId("50000000-0000-4000-8000-000000000003");
const repoA = "50000000-0000-4000-8000-000000000004";
const defA = asWorkflowDefinitionId("50000000-0000-4000-8000-000000000005");
const defB = asWorkflowDefinitionId("50000000-0000-4000-8000-000000000006");
const version = 1;
const versionRowId = asWorkflowVersionId(
	"50000000-0000-4000-8000-000000000007",
);
const scopeA: CallerScope = { organizationId: orgA, userId: userA };

function graph(
	id: WorkflowDefinitionId,
	nodeId = "agent-step",
): WorkflowDefinition {
	return {
		id,
		name: "Submission compilation fixture",
		version,
		nodes: [
			{
				id: nodeId,
				type: "task.agent",
				label: "Agent",
				config: {
					agentId: "coding-agent",
					promptTemplateId: "stored-template",
				},
			},
		],
		edges: [],
	};
}
function key(
	organizationId: OrganizationId,
	definitionId: WorkflowDefinitionId,
	workflowVersion: number,
): string {
	return `${organizationId}/${definitionId}/${workflowVersion}`;
}
function row(
	definitionId: WorkflowDefinitionId,
	value: WorkflowDefinition,
): WorkflowVersionRow {
	return {
		id: versionRowId,
		definition_id: definitionId,
		version,
		graph: value,
		compiled: null,
		created_by: userA,
		created_at: new Date("2026-10-28T00:00:00.000Z"),
	};
}
function compilationHarness(
	options: {
		graph?: WorkflowDefinition;
		/** Simulates a reader that ignores the organization argument. */
		ignoreOrganization?: boolean;
		throwOnRead?: boolean;
	} = {},
) {
	const authored = graph(defA);
	const rows = new Map<string, WorkflowVersionRow>([
		[key(orgA, defA, version), row(defA, options.graph ?? authored)],
		[key(orgB, defB, version), row(defB, graph(defB))],
	]);
	const reads: Array<[OrganizationId, WorkflowDefinitionId, number]> = [];
	const authoredVersions: AuthoredWorkflowVersionReader = {
		async getAuthoredVersion(organizationId, definitionId, workflowVersion) {
			reads.push([organizationId, definitionId, workflowVersion]);
			if (options.throwOnRead) throw new Error("private reader fixture-secret");
			if (options.ignoreOrganization)
				return rows.get(key(orgB, definitionId, workflowVersion)) ?? null;
			return (
				rows.get(key(organizationId, definitionId, workflowVersion)) ?? null
			);
		},
	};
	const pins = [
		{
			organizationId: orgA,
			workflowDefinitionId: defA,
			workflowVersion: version,
		},
		{
			organizationId: orgB,
			workflowDefinitionId: defB,
			workflowVersion: version,
		},
	];
	const compiledPlans = new InMemoryCompiledPlanRepository({ versions: pins });
	const rejections = new InMemoryWorkflowRejectionRepository({
		versions: pins,
	});
	const compileSubmission = createSubmissionCompiler({
		getRepositories: async () => ({
			authoredVersions,
			compiledPlans,
			rejections,
		}),
	});
	const tasks = new InMemoryTaskRepository();
	const queue = new InMemoryQueueRepository();
	const store = createRepositoryStore({
		tasks,
		queue,
		repositoryBelongsToOrganization: async (organizationId, repositoryId) =>
			organizationId === orgA && repositoryId === repoA,
		compileSubmission,
		async listLatest() {
			return [];
		},
	});
	const service = createTaskService({
		resolveScope: async () => scopeA,
		getStore: async () => store,
	});
	function request(overrides: Partial<SubmitTaskInput> = {}) {
		return input({
			repositoryId: repoA,
			workflowDefinitionId: defA,
			workflowVersion: version,
			...overrides,
		});
	}
	return {
		request,
		service,
		tasks,
		queue,
		compiledPlans,
		rejections,
		reads,
		plan: () => compiledPlans.get(orgA, defA, version),
	};
}

describe("compile at submit (real compiler + in-memory persistence)", () => {
	test("compiled path persists the pinned plan and enqueues once", async () => {
		const h = compilationHarness();
		const result = await h.service.submit(h.request());
		if (!result.ok) throw new Error("Expected compiled receipt");
		const plan = await h.plan();
		if (!plan) throw new Error("Expected persisted plan");
		expect(result.value.compilation).toEqual({
			outcome: "compiled",
			compiledPlanId: plan.id,
		});
		expect(plan.workflow_definition_id).toBe(defA);
		expect(plan.workflow_version).toBe(version);
		expect(plan.plan.workflowId).toBe(defA);
		expect(plan.plan.versionPinned).toBe(version);
		expect(h.reads).toEqual([[orgA, defA, version]]);
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).not.toBeNull();
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("a later submission reuses the immutable plan and creates a second task", async () => {
		const h = compilationHarness();
		const first = await h.service.submit(h.request());
		const second = await h.service.submit(h.request());
		if (!first.ok || !second.ok) throw new Error("Expected compiled receipts");
		expect(first.value.task.id).not.toBe(second.value.task.id);
		expect(first.value.compilation.compiledPlanId).toBe(
			second.value.compilation.compiledPlanId,
		);
		expect(await h.compiledPlans.list(orgA, defA)).toHaveLength(1);
	});
	test("parallel retries converge on one plan and one task", async () => {
		const h = compilationHarness();
		const request = h.request();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => h.service.submit(request)),
		);
		expect(results.every((result) => result.ok)).toBe(true);
		const tasks = results.map((result) =>
			result.ok ? result.value.task.id : null,
		);
		expect(new Set(tasks).size).toBe(1);
		const plans = results.map((result) =>
			result.ok ? result.value.compilation.compiledPlanId : null,
		);
		expect(new Set(plans).size).toBe(1);
		expect(await h.compiledPlans.list(orgA, defA)).toHaveLength(1);
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).not.toBeNull();
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("rejected path records sanitized issues and writes no task or job", async () => {
		const h = compilationHarness({
			graph: graph(defA, "private.source.step"),
		});
		const result = await h.service.submit(h.request());
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "WORKFLOW_REJECTED",
				issues: [{ code: "INVALID_NODE_ID", path: "nodes[0].id" }],
			},
		});
		expect(JSON.stringify(result)).not.toContain("private.source");
		expect(await h.plan()).toBeNull();
		expect(await h.rejections.listLatest(orgA, defA, version)).toHaveLength(1);
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
		expect(await h.tasks.listByStatus("queued", 10)).toEqual([]);
	});
	test("unknown authored version is a bounded FORBIDDEN with no writes", async () => {
		const h = compilationHarness();
		const result = await h.service.submit(
			h.request({
				workflowDefinitionId: "50000000-0000-4000-8000-000000000099",
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(await h.plan()).toBeNull();
		expect(await h.rejections.listLatest(orgA, defA, version)).toHaveLength(0);
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("caller from org A cannot compile a definition owned by org B", async () => {
		const h = compilationHarness();
		const result = await h.service.submit(
			h.request({ workflowDefinitionId: defB }),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(h.reads).toEqual([[orgA, defB, version]]);
		expect(await h.compiledPlans.get(orgB, defB, version)).toBeNull();
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("a mis-scoped reader is rejected by org-scoped persistence", async () => {
		const h = compilationHarness({ ignoreOrganization: true });
		const result = await h.service.submit(
			h.request({ workflowDefinitionId: defB }),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
		expect(await h.compiledPlans.get(orgB, defB, version)).toBeNull();
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
	test("reader failure is a bounded UNAVAILABLE", async () => {
		const h = compilationHarness({ throwOnRead: true });
		const result = await h.service.submit(h.request());
		expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
		expect(JSON.stringify(result)).not.toContain("fixture-secret");
		expect(
			await h.queue.claimNext({ ownerId: "offline", leaseSeconds: 30 }),
		).toBeNull();
	});
});
