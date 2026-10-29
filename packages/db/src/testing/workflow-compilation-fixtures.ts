import { asOrganizationId, asWorkflowDefinitionId } from "@isolate/shared";
import { compileWorkflow } from "../../../workflow-schema/src/compiler";
import type {
	CompiledWorkflow,
	WorkflowIssue,
} from "../../../workflow-schema/src/types";
import type { PgSql } from "../client";
import type { WorkflowVersionPin } from "../repositories/workflow-compilation";
import type { CompiledPlanRow, CompiledWorkflowPlan } from "../schema";

export const pin: WorkflowVersionPin = {
	organizationId: asOrganizationId("10000000-0000-4000-8000-000000000001"),
	workflowDefinitionId: asWorkflowDefinitionId(
		"20000000-0000-4000-8000-000000000001",
	),
	workflowVersion: 1,
};
export const otherOrg = asOrganizationId(
	"10000000-0000-4000-8000-000000000002",
);
export const otherDefinition = asWorkflowDefinitionId(
	"20000000-0000-4000-8000-000000000002",
);
export const issue: WorkflowIssue = {
	path: "nodes[0].config.tool",
	code: "UNAUTHORIZED_TOOL",
	message: "tool is not allowed",
};

/** Real compiler output, not an invented opaque JSON object. */
export function compiledPlan(
	version: WorkflowVersionPin = pin,
): CompiledWorkflowPlan {
	const result = compileWorkflow({
		id: version.workflowDefinitionId,
		name: "DB contract",
		version: version.workflowVersion,
		nodes: [
			{
				id: "agent",
				type: "task.agent",
				label: "Agent",
				config: { agentId: "coder", promptTemplateId: "sdlc" },
			},
		],
		edges: [],
	});
	if (!result.ok) throw new Error("compiler rejected DB test fixture");
	const stored: CompiledWorkflowPlan = result.value;
	// Check both structural directions at typecheck time without runtime coupling.
	const compilerCompatible: CompiledWorkflow = stored;
	return compilerCompatible;
}

export function planRow(
	plan: CompiledWorkflowPlan = compiledPlan(),
): CompiledPlanRow {
	return {
		id: "30000000-0000-4000-8000-000000000001",
		organization_id: pin.organizationId,
		workflow_definition_id: pin.workflowDefinitionId,
		workflow_version: pin.workflowVersion,
		plan,
		created_at: new Date("2026-10-27T00:00:00Z"),
	};
}

/** Scripted driver responses: tests exercise the real mapper and bound SQL. */
export function recordingSql(responses: Array<Array<Record<string, unknown>>>) {
	const calls: Array<{ statement: string; params: unknown[] }> = [];
	const sql = {
		async unsafe(statement: string, params: unknown[] = []) {
			calls.push({ statement, params });
			const response = responses.shift();
			if (response === undefined) throw new Error("unexpected SQL call");
			return response;
		},
	} as unknown as PgSql;
	return { sql, calls };
}
