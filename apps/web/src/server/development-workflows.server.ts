import "@tanstack/react-start/server-only";
import type { WorkflowVersionRow } from "@isolate/db";
import { asWorkflowVersionId } from "@isolate/shared";
import type { WorkflowDefinition } from "@isolate/workflow-schema";
import { localDemo } from "./local-mode.server";
import type { AuthoredWorkflowVersionReader } from "./workflow-compilation.server";

/** A deliberately small but valid graph for the local demo/offline tests. */
export function developmentGraph(): WorkflowDefinition {
	return {
		id: localDemo.workflowDefinitionId,
		name: "Local demo workflow",
		version: localDemo.workflowVersion,
		nodes: [
			{
				id: "agent-step",
				type: "task.agent",
				label: "Coding agent",
				config: {
					agentId: "coding-agent",
					promptTemplateId: "local-demo",
				},
			},
		],
		edges: [],
	};
}

/**
 * Org-scoped fixture reader for the no-database demo. The pin is fixed to the
 * demo organization; any other tenant or version is absent (NOT_FOUND).
 */
export function createDevelopmentAuthoredVersions(): AuthoredWorkflowVersionReader {
	return {
		async getAuthoredVersion(organizationId, definitionId, version) {
			if (
				organizationId !== localDemo.organizationId ||
				definitionId !== localDemo.workflowDefinitionId ||
				version !== localDemo.workflowVersion
			)
				return null;
			const row: WorkflowVersionRow = {
				id: asWorkflowVersionId(localDemo.workflowVersionId),
				definition_id: definitionId,
				version,
				graph: developmentGraph(),
				compiled: null,
				created_by: localDemo.userId,
				created_at: new Date("2026-10-28T00:00:00.000Z"),
			};
			return row;
		},
	};
}
