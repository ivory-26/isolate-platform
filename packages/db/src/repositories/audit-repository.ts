import type { OrganizationId } from "@isolate/shared";
import type { AuditAction, AuditEventRow, ToolInvocationRow } from "../schema";

/** Redaction and sanitisation are the caller's responsibility; this layer is fail-quiet and typed. */
export interface AuditRepository {
	append(input: {
		organizationId: OrganizationId;
		actorId: string | null;
		actorKind: AuditEventRow["actor_kind"];
		action: AuditAction;
		target: string;
		details: Record<string, unknown>;
	}): Promise<AuditEventRow>;
}

export interface ToolInvocationRepository {
	record(input: {
		organizationId: OrganizationId;
		taskId: string;
		workflowRunId: string | null;
		toolName: string;
		argumentsRedacted: Record<string, unknown>;
		decision: ToolInvocationRow["decision"];
		denialReason: string | null;
		durationMs: number | null;
	}): Promise<ToolInvocationRow>;
}
