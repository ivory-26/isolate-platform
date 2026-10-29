import "@tanstack/react-start/server-only";
import type {
	RecordWorkflowRejectionInput,
	SavePlanInput,
	WorkflowVersionPin,
	WorkflowVersionRow,
} from "@isolate/db";
import {
	InMemoryCompiledPlanRepository,
	InMemoryWorkflowRejectionRepository,
} from "@isolate/db/testing";
import {
	asOrganizationId,
	asUserId,
	asWorkflowDefinitionId,
	asWorkflowVersionId,
} from "@isolate/shared";
import type { WorkflowDefinition } from "@isolate/workflow-schema";
import type { CallerScope } from "./task-service.server";
import {
	type AuthoredWorkflowVersionReader,
	createWorkflowCompilationService,
	type WorkflowCompilationPolicy,
} from "./workflow-compilation.server";

export const compilationScope: CallerScope = {
	organizationId: asOrganizationId("a1000000-0000-4000-8000-000000000001"),
	userId: asUserId("a1000000-0000-4000-8000-000000000002"),
	role: "owner",
};
export const compilationPin: WorkflowVersionPin = {
	organizationId: compilationScope.organizationId,
	workflowDefinitionId: asWorkflowDefinitionId(
		"a1000000-0000-4000-8000-000000000003",
	),
	workflowVersion: 2,
};
export const compilationRequest = {
	workflowDefinitionId: compilationPin.workflowDefinitionId,
	workflowVersion: compilationPin.workflowVersion,
};
export function validGraph(): WorkflowDefinition {
	return {
		id: compilationPin.workflowDefinitionId,
		name: "Stored authored definition",
		version: 2,
		nodes: [
			{
				id: "agent-step",
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
export function toolGraph(tool = "repo.read"): WorkflowDefinition {
	return {
		...validGraph(),
		nodes: [
			{ id: "read-step", type: "tool.call", label: "Read", config: { tool } },
		],
	};
}
export function budgetGraph(): WorkflowDefinition {
	return {
		...validGraph(),
		nodes: [
			{
				id: "bounded-loop",
				type: "validate.loop",
				label: "Validate",
				config: { maxAttempts: 4 },
			},
		],
	};
}
export function compilationHarness(
	options: { graph?: unknown; missingPersistencePin?: boolean } = {},
) {
	const events: string[] = [];
	const state = {
		scope: compilationScope as CallerScope | null,
		membership: true,
		scopeThrows: false,
		membershipThrows: false,
		policy: {
			toolAllowlist: [],
			taskBudget: 3,
		} as WorkflowCompilationPolicy | null,
		policyThrows: false,
		initThrows: false,
		readerThrows: false,
		planThrows: false,
		rejectionThrows: false,
		beforeRecord: async () => {},
	};
	const pin = compilationPin;
	const versionOptions = {
		versions: options.missingPersistencePin ? [] : [pin],
	};
	class Plans extends InMemoryCompiledPlanRepository {
		override async save(input: SavePlanInput) {
			events.push("save:start");
			if (state.planThrows)
				throw new Error("private plan storage fixture-credential");
			const result = await super.save(input);
			events.push("save:end");
			return result;
		}
	}
	class Rejections extends InMemoryWorkflowRejectionRepository {
		override async record(input: RecordWorkflowRejectionInput) {
			events.push("record:start");
			await state.beforeRecord();
			if (state.rejectionThrows)
				throw new Error("private rejection storage fixture-credential");
			const result = await super.record(input);
			events.push("record:end");
			return result;
		}
	}
	const compiledPlans = new Plans(versionOptions);
	const rejections = new Rejections(versionOptions);
	const row: WorkflowVersionRow = {
		id: asWorkflowVersionId("a1000000-0000-4000-8000-000000000004"),
		definition_id: pin.workflowDefinitionId,
		version: pin.workflowVersion,
		graph: Object.hasOwn(options, "graph") ? options.graph : validGraph(),
		compiled: { legacy: "untouched" },
		created_by: compilationScope.userId,
		created_at: new Date("2026-10-28T00:00:00.000Z"),
	};
	const newerRow: WorkflowVersionRow = {
		...row,
		version: 9,
		graph: { ...validGraph(), version: 9 },
	};
	const rows = new Map([
		[`${pin.organizationId}/${pin.workflowDefinitionId}/2`, row],
		[`${pin.organizationId}/${pin.workflowDefinitionId}/9`, newerRow],
	]);
	const reads: unknown[][] = [];
	const authoredVersions: AuthoredWorkflowVersionReader = {
		async getAuthoredVersion(org, definitionId, version) {
			events.push("read");
			reads.push([org, definitionId, version]);
			if (state.readerThrows)
				throw new Error("private authored lookup fixture-credential");
			return rows.get(`${org}/${definitionId}/${version}`) ?? null;
		},
	};
	const policyPins: WorkflowVersionPin[] = [];
	const service = createWorkflowCompilationService({
		async resolveScope() {
			events.push("scope");
			if (state.scopeThrows) throw new Error("private auth fixture-credential");
			return state.scope;
		},
		async authorizeMembership() {
			events.push("membership");
			if (state.membershipThrows)
				throw new Error("private membership fixture-credential");
			return state.membership;
		},
		async resolvePolicy(scope, requestedPin) {
			events.push("policy");
			policyPins.push({ ...requestedPin });
			if (state.policyThrows)
				throw new Error("private policy fixture-credential");
			if (scope.organizationId !== requestedPin.organizationId)
				throw new Error("Scope mismatch");
			return state.policy;
		},
		async getRepositories() {
			events.push("repositories");
			if (state.initThrows)
				throw new Error("private initialization fixture-credential");
			return { authoredVersions, compiledPlans, rejections };
		},
	});
	return {
		service,
		state,
		events,
		reads,
		policyPins,
		row,
		rows,
		newerRow,
		compiledPlans,
		rejections,
		plan: () =>
			compiledPlans.get(
				pin.organizationId,
				pin.workflowDefinitionId,
				pin.workflowVersion,
			),
		recorded: () =>
			rejections.listLatest(
				pin.organizationId,
				pin.workflowDefinitionId,
				pin.workflowVersion,
			),
	};
}
