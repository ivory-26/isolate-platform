import type {
	ApprovalId,
	IntegrationId,
	OrganizationId,
	RepositoryId,
	TaskAttemptId,
	TaskId,
	UserId,
	WorkflowDefinitionId,
	WorkflowRunId,
	WorkflowVersionId,
} from "@isolate/shared";

/**
 * Row shapes for the platform data model (ARCHITECTURE.md §5). Column names are
 * snake_case; TypeScript uses camelCase via the repositories. IDs are UUIDs.
 * Tenant-owned rows always carry organization_id.
 *
 * This file declares the CONTRACT only. Sprint A-2 implements the migration,
 * validation schemas and repositories against these shapes; keep field names
 * stable or coordinate through the integrator.
 */

export type AgentRunStatus = "running" | "succeeded" | "failed";

// Reflects migrations/0001_agent_smoke_test_runs.sql (kept from the MVP spike).
export type AgentRunRow = {
	id: string;
	prompt: string;
	status: AgentRunStatus;
	result: string | null;
	error_code: string | null;
	created_at: Date;
	finished_at: Date | null;
	duration_ms: number | null;
};

export type OrganizationRow = {
	id: OrganizationId;
	name: string;
	slug: string; // unique, url-safe
	created_at: Date;
};

export type UserRow = {
	id: UserId;
	email: string; // unique
	display_name: string;
	created_at: Date;
};

export type UserRole = "owner" | "admin" | "member" | "viewer";

export type MembershipRow = {
	organization_id: OrganizationId;
	user_id: UserId;
	role: UserRole;
	created_at: Date;
};

export type RepositoryRow = {
	id: RepositoryId;
	organization_id: OrganizationId;
	provider: "github";
	external_full_name: string; // e.g. "org/repo"
	default_branch: string;
	created_at: Date;
};

export type IntegrationKind = "github_app" | "mcp_server" | "business_api";

export type IntegrationRow = {
	id: IntegrationId;
	organization_id: OrganizationId;
	kind: IntegrationKind;
	name: string;
	// Refers to a secret-store key; never a raw credential.
	credential_ref: string;
	enabled: boolean;
	created_at: Date;
};

export type IntegrationPermissionRow = {
	integration_id: IntegrationId;
	organization_id: OrganizationId;
	repository_id: RepositoryId | null; // null => org-wide
	scopes: string[]; // least-privilege scope list
	created_at: Date;
};

export type WorkflowDefinitionRow = {
	id: WorkflowDefinitionId;
	organization_id: OrganizationId;
	name: string;
	created_by: UserId;
	created_at: Date;
};

export type WorkflowVersionRow = {
	id: WorkflowVersionId;
	definition_id: WorkflowDefinitionId;
	version: number; // monotonic per definition
	graph: unknown; // JSON graph; validated by @isolate/workflow-schema
	compiled: unknown; // compiled plan; version-pinned at run time
	created_by: UserId;
	created_at: Date;
};

export type TaskStatusDb =
	| "queued"
	| "planning"
	| "awaiting_approval"
	| "executing"
	| "validating"
	| "repairing"
	| "review_ready"
	| "pull_request_created"
	| "completed"
	| "failed"
	| "cancelled"
	| "blocked";

export type TaskRow = {
	id: TaskId;
	organization_id: OrganizationId;
	repository_id: RepositoryId;
	worktree: string; // role: branch name this task may mutate
	branch: string;
	status: TaskStatusDb;
	idempotency_key: string; // unique per organization; dedupes resubmits
	budget_limits: {
		max_agent_turns: number;
		max_repair_attempts: number;
		max_duration_ms: number;
	}; // bounded execution (never unbounded loops)
	created_by: UserId;
	created_at: Date;
	updated_at: Date;
};

/** Outcome carrier used by the worker, typed per lifecycle stage. */
export type TaskAttemptOutcome =
	| { kind: "plan"; files: string[]; pending_approval: boolean }
	| { kind: "execution"; notes: string }
	| {
			kind: "validation";
			gates: Array<{ name: string; passed: boolean; details: string | null }>;
	  }
	| { kind: "repair"; attempt: number; notes: string }
	| { kind: "pr_created"; pr_url: string; pr_number: number };

export type TaskAttemptRow = {
	id: TaskAttemptId;
	task_id: TaskId;
	workflow_run_id: WorkflowRunId | null;
	// Bounded counters guard the repair loop (architecture §9).
	attempt_index: number; // monotonic per task
	started_at: Date;
	finished_at: Date | null;
	outcome: TaskAttemptOutcome | null;
};

export type WorkflowRunStatus =
	| "running"
	| "suspended"
	| "succeeded"
	| "failed";

export type WorkflowRunRow = {
	id: WorkflowRunId;
	task_id: TaskId;
	organization_id: OrganizationId;
	// Runs are pinned to the authored version; later edits never change it.
	workflow_version_id: WorkflowVersionId;
	status: WorkflowRunStatus;
	started_at: Date;
	finished_at: Date | null;
};

export type RunEventRow = {
	id: string;
	task_id: TaskId;
	workflow_run_id: WorkflowRunId | null;
	type: string;
	actor: "user" | "agent" | "worker" | "system" | "policy";
	data: Record<string, unknown>; // redacted before insert; no secrets
	occurred_at: Date;
};

export type ArtifactKind = "diff" | "log_bundle" | "report" | "screenshot";

export type ArtifactRow = {
	id: string;
	task_id: TaskId;
	organization_id: OrganizationId;
	kind: ArtifactKind;
	// Opaque reference into object storage; never inline large blobs in Neon.
	storage_ref: string;
	content_type: string;
	byte_size: number;
	sha256: string;
	created_at: Date;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRow = {
	id: ApprovalId;
	organization_id: OrganizationId;
	task_id: TaskId;
	workflow_run_id: WorkflowRunId | null;
	action: string; // bounded action vocabulary, e.g. "pr.merge", "db.migrate"
	// Binding: hash of exact action payload; payload change invalidates.
	payload_sha256: string;
	status: ApprovalStatus;
	requested_by: string; // actor id (user/agent)
	decided_by: string | null;
	decided_at: Date | null;
	expires_at: Date; // pending approvals expire
	created_at: Date;
};

export type ToolInvocationRow = {
	id: string;
	organization_id: OrganizationId;
	task_id: TaskId;
	workflow_run_id: WorkflowRunId | null;
	tool_name: string;
	// Arguments are redacted at the boundary; secrets never recorded.
	arguments_redacted: Record<string, unknown>;
	decision: "allowed" | "allowed_by_approval" | "denied";
	denial_reason: string | null;
	duration_ms: number | null;
	created_at: Date;
};

export type AuditAction =
	| "task.create"
	| "task.cancel"
	| "approval.request"
	| "approval.decide"
	| "tool.execute"
	| "pr.create"
	| "pr.merge"
	| "deploy.request"
	| "secret.rotate"
	| "config.change";

export type AuditEventRow = {
	id: string;
	organization_id: OrganizationId;
	actor_id: string | null; // null => system
	actor_kind: "user" | "agent" | "worker" | "system";
	action: AuditAction;
	target: string; // stable resource ref, e.g. "task:<uuid>"
	details: Record<string, unknown>; // redacted
	created_at: Date;
};

export type UsageRecordRow = {
	id: string;
	organization_id: OrganizationId;
	task_id: TaskId | null;
	// Model/provider cost attribution; tokens and currency only, no keys.
	model_id: string;
	provider: string;
	prompt_tokens: number | null;
	completion_tokens: number | null;
	cost_usd: unknown; // numeric(12,6) — read as string via postgres.js
	created_at: Date;
};
