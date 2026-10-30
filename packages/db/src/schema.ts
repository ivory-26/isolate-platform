import type {
	AcceptanceCheck,
	ApprovalId,
	IncidentSeverity,
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
	// Validation policy (migration 0006). NULL means no validation gate.
	// Bounded to 512 characters and free of shell metacharacters by the
	// repository layer; the DB CHECK enforces the length only.
	validation_command: string | null;
	validation_timeout_ms: number; // 1000..900000 ms, default 300000
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

/** Serializable compiler contract; no db -> compiler dependency.
 * Graph/policy validation belongs to the compiler; persistence checks the pin.
 */
export type CompiledWorkflowPlan = {
	workflowId: string;
	versionPinned: number;
	planId: string;
	entryNodeIds: string[];
	steps: Array<{
		nodeId: string;
		type:
			| "task.agent"
			| "tool.call"
			| "approval.gate"
			| "condition.switch"
			| "validate.loop";
		order: number;
		config:
			| { agentId: string; promptTemplateId: string }
			| { tool: string }
			| { action: string; risk: "low" | "medium" | "high" }
			| { branches: string[] }
			| { maxAttempts: number };
	}>;
	edges: Array<{
		from: string;
		to: string;
		when?: {
			left: string;
			operator: "eq" | "ne" | "truthy";
			right: string | boolean | number;
		};
	}>;
};

/**
 * Compiled plan for a pinned workflow version (migration 0002). Plans are
 * IMMUTABLE per (organization_id, workflow_definition_id, workflow_version):
 * the UNIQUE constraint backs `CompiledPlanRepository.save` conflict
 * semantics, so version edits always create a new version.
 */
export type CompiledPlanRow = {
	id: string;
	organization_id: OrganizationId;
	workflow_definition_id: WorkflowDefinitionId;
	// The authored version the plan was compiled against (1-based integer).
	workflow_version: number;
	// Compiled artifact; validated by @isolate/workflow-schema.
	plan: CompiledWorkflowPlan;
	created_at: Date;
};

/** Compiler issue shape; string codes allow new compiler rejection classes. */
export type WorkflowRejectionIssue = {
	path: string;
	code: string;
	message: string;
};

/**
 * Append-only validation rejection history (migration 0002). Many rows may
 * exist per pinned version over time; newest first via listLatest.
 */
export type WorkflowRejectionRow = {
	id: string;
	organization_id: OrganizationId;
	workflow_definition_id: WorkflowDefinitionId;
	workflow_version: number;
	issues: WorkflowRejectionIssue[];
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
	/** Authored task intent; empty only for rows created before wave 6. */
	goal: string;
	/** What "done" means for this task; persisted at submit time. */
	acceptance_criteria: string[];
	/**
	 * Machine-checkable completion criteria (migration 0007), bounded to 32
	 * entries by the `acceptanceCheckSchema` boundary and the DB CHECK. Empty
	 * means the task has no environment-proven checks.
	 */
	acceptance_checks: AcceptanceCheck[];
	/** Paths the agent may modify; everything else is out of bounds. */
	file_ownership: string[];
	/** Pull request opened after human approval (migration 0006); NULL until then. */
	pull_request_number: number | null;
	pull_request_url: string | null;
	/** Failed task this row reproduces; NULL for a first submission. */
	retry_of: TaskId | null;
	/** 0 for a first submission, source.retry_depth + 1 for a retry (max 3). */
	retry_depth: number;
	/**
	 * Provenance of the incident signal that opened this task (migration
	 * 0009); NULL for a normal submission. Source and fingerprint are written
	 * as a pair by `TaskRepository.create`.
	 */
	incident_source: string | null;
	incident_fingerprint: string | null;
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
	// Opaque reference into object storage; wave 7 uses `inline:<sha256>`.
	storage_ref: string;
	content_type: string;
	byte_size: number;
	sha256: string;
	// Bounded inline payload (migration 0005, <= 256 KiB UTF-8 bytes) or NULL
	// for metadata-only artifacts that live in object storage.
	content: string | null;
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

/**
 * One normalized inbound incident delivery (migration 0009). Bounded identity
 * fields only — no payload, summary or log excerpt is persisted, and no
 * credential may ever be stored here. `(organization_id, source, fingerprint,
 * 30-minute bucket)` is the dedupe identity, enforced by a unique expression
 * index; `delivery_id` is audit metadata, never the dedupe key.
 */
export type IncidentSignalRow = {
	id: string;
	organization_id: OrganizationId;
	source: string;
	kind: string;
	severity: IncidentSeverity;
	service: string;
	fingerprint: string;
	delivery_id: string | null;
	received_at: Date;
	created_at: Date;
};
