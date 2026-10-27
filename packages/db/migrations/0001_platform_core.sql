-- Platform core schema (ARCHITECTURE.md §5 minimal viable subset).
--
-- Idempotent SQL (CREATE TABLE IF NOT EXISTS everywhere):
--   psql "$DATABASE_URL" -f packages/db/migrations/0001_platform_core.sql
--
-- Requirements: PostgreSQL >= 13 (gen_random_uuid() is built in; every
-- statement below is Postgres 13+ syntax). Every tenant-owned table carries
-- organization_id with a foreign key to organizations. Enum-like columns use
-- CHECK constraints (portable, no CREATE TYPE ordering issues). JSON payloads
-- are jsonb so callers can bind a strict subset without trusting text.
--
-- The `jobs` table backs the durable queue contract (QueueRepository) and is
-- part of this subset even though ARCHITECTURE.md §5 does not name it.

-- ---------------------------------------------------------------------------
-- Identity and tenancy -------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	slug text NOT NULL UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email text NOT NULL UNIQUE,
	display_name text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
	organization_id uuid NOT NULL REFERENCES organizations (id),
	user_id uuid NOT NULL REFERENCES users (id),
	role text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, user_id),
	CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE TABLE IF NOT EXISTS repositories (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	provider text NOT NULL,
	external_full_name text NOT NULL,
	default_branch text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT repositories_provider_check CHECK (provider IN ('github')),
	CONSTRAINT repositories_org_full_name_unique UNIQUE (organization_id, external_full_name)
);

-- ---------------------------------------------------------------------------
-- Integrations ---------------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	kind text NOT NULL,
	name text NOT NULL,
	-- Secret-store key reference only; never a raw credential.
	credential_ref text NOT NULL,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT integrations_kind_check CHECK (kind IN ('github_app', 'mcp_server', 'business_api'))
);

CREATE TABLE IF NOT EXISTS integration_permissions (
	integration_id uuid NOT NULL REFERENCES integrations (id),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	-- NULL repository_id means org-wide permission.
	repository_id uuid NULL REFERENCES repositories (id),
	scopes text[] NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (integration_id, repository_id, organization_id)
);

-- ---------------------------------------------------------------------------
-- Workflows ------------------------------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_definitions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	name text NOT NULL,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_versions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	definition_id uuid NOT NULL REFERENCES workflow_definitions (id),
	version integer NOT NULL CHECK (version >= 1),
	-- Authored graph / compiled plan; validated by @isolate/workflow-schema.
	graph jsonb NOT NULL,
	compiled jsonb NULL,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT workflow_versions_definition_version_unique UNIQUE (definition_id, version)
);

-- ---------------------------------------------------------------------------
-- Tasks (state machine mirrored from TASK_STATE_TRANSITIONS in the CHECK) ----
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tasks (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	repository_id uuid NOT NULL REFERENCES repositories (id),
	-- Branch/worktree role this task may mutate (sandbox isolation boundary).
	worktree text NOT NULL,
	branch text NOT NULL,
	status text NOT NULL DEFAULT 'queued',
	-- Dedupes resubmits within the organization.
	idempotency_key text NOT NULL,
	-- Bounded execution budget: {max_agent_turns, max_repair_attempts, max_duration_ms}.
	budget_limits jsonb NOT NULL,
	created_by uuid NOT NULL REFERENCES users (id),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT tasks_status_check CHECK (
		status IN (
			'queued', 'planning', 'awaiting_approval', 'executing', 'validating',
			'repairing', 'review_ready', 'pull_request_created', 'completed',
			'failed', 'cancelled', 'blocked'
		)
	),
	CONSTRAINT tasks_org_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS tasks_status_created_idx
	ON tasks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	task_id uuid NOT NULL REFERENCES tasks (id),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	-- Runs pin the authored version; later graph edits never change it.
	workflow_version_id uuid NOT NULL REFERENCES workflow_versions (id),
	status text NOT NULL DEFAULT 'running',
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz NULL,
	CONSTRAINT workflow_runs_status_check CHECK (status IN ('running', 'suspended', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS workflow_runs_task_idx ON workflow_runs (task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	task_id uuid NOT NULL REFERENCES tasks (id),
	workflow_run_id uuid NULL REFERENCES workflow_runs (id),
	attempt_index integer NOT NULL CHECK (attempt_index >= 1),
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz NULL,
	outcome jsonb NULL,
	CONSTRAINT task_attempts_task_index_unique UNIQUE (task_id, attempt_index)
);

CREATE TABLE IF NOT EXISTS run_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	task_id uuid NOT NULL REFERENCES tasks (id),
	workflow_run_id uuid NULL REFERENCES workflow_runs (id),
	type text NOT NULL,
	actor text NOT NULL,
	-- Redacted before insert; no secrets ever reach this column.
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	occurred_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT run_events_actor_check CHECK (actor IN ('user', 'agent', 'worker', 'system', 'policy'))
);

CREATE INDEX IF NOT EXISTS run_events_task_occurred_idx
	ON run_events (task_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	task_id uuid NOT NULL REFERENCES tasks (id),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	kind text NOT NULL,
	-- Object storage reference; large payloads never live in Neon.
	storage_ref text NOT NULL,
	content_type text NOT NULL,
	byte_size bigint NOT NULL CHECK (byte_size >= 0),
	sha256 text NOT NULL CHECK (char_length(sha256) = 64),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT artifacts_kind_check CHECK (kind IN ('diff', 'log_bundle', 'report', 'screenshot'))
);

CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (task_id);

-- ---------------------------------------------------------------------------
-- Approvals (payload-bound, expiring) ----------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approvals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	task_id uuid NOT NULL REFERENCES tasks (id),
	workflow_run_id uuid NULL REFERENCES workflow_runs (id),
	action text NOT NULL,
	-- SHA-256 of the exact action payload; a payload change invalidates the
	-- decision (ApprovalRepository.decide only accepts this exact hash).
	payload_sha256 text NOT NULL CHECK (char_length(payload_sha256) = 64),
	status text NOT NULL DEFAULT 'pending',
	requested_by text NOT NULL,
	decided_by text NULL,
	decided_at timestamptz NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
);

CREATE INDEX IF NOT EXISTS approvals_task_status_idx ON approvals (task_id, status);
CREATE INDEX IF NOT EXISTS approvals_pending_expired_idx
	ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_org_status_created_idx
	ON approvals (organization_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tool invocations, audit, usage ---------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_invocations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	task_id uuid NOT NULL REFERENCES tasks (id),
	workflow_run_id uuid NULL REFERENCES workflow_runs (id),
	tool_name text NOT NULL,
	-- Redacted at the boundary; secrets never recorded here.
	arguments_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
	decision text NOT NULL,
	denial_reason text NULL,
	duration_ms integer NULL CHECK (duration_ms >= 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT tool_invocations_decision_check CHECK (decision IN ('allowed', 'allowed_by_approval', 'denied'))
);

CREATE INDEX IF NOT EXISTS tool_invocations_org_created_idx
	ON tool_invocations (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_invocations_task_idx ON tool_invocations (task_id);

CREATE TABLE IF NOT EXISTS audit_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	-- NULL actor_id means system attribution.
	actor_id text NULL,
	actor_kind text NOT NULL,
	action text NOT NULL,
	target text NOT NULL,
	details jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT audit_events_actor_kind_check CHECK (actor_kind IN ('user', 'agent', 'worker', 'system')),
	CONSTRAINT audit_events_action_check CHECK (
		action IN (
			'task.create', 'task.cancel', 'approval.request', 'approval.decide',
			'tool.execute', 'pr.create', 'pr.merge', 'deploy.request',
			'secret.rotate', 'config.change'
		)
	)
);

CREATE INDEX IF NOT EXISTS audit_events_org_created_idx
	ON audit_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target);

CREATE TABLE IF NOT EXISTS usage_records (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	task_id uuid NULL REFERENCES tasks (id),
	model_id text NOT NULL,
	provider text NOT NULL,
	prompt_tokens integer NULL CHECK (prompt_tokens >= 0),
	completion_tokens integer NULL CHECK (completion_tokens >= 0),
	cost_usd numeric(12, 6) NULL CHECK (cost_usd >= 0),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_records_org_created_idx
	ON usage_records (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_task_idx ON usage_records (task_id);

-- ---------------------------------------------------------------------------
-- Durable queue (QueueRepository) --------------------------------------------
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES organizations (id),
	task_id uuid NOT NULL REFERENCES tasks (id),
	type text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	status text NOT NULL DEFAULT 'pending',
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	max_attempts integer NOT NULL CHECK (max_attempts >= 1),
	lease_owner_id text NULL,
	lease_expires_at timestamptz NULL,
	-- Redelivery backoff floor.
	not_before timestamptz NOT NULL DEFAULT now(),
	-- Idempotency key per enqueue call.
	enqueue_uuid_key text NOT NULL,
	last_error_code text NULL,
	last_error_message text NULL CHECK (char_length(last_error_message) <= 4000),
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT jobs_type_check CHECK (type IN ('run_task', 'validate_attempt', 'finalize_review')),
	CONSTRAINT jobs_status_check CHECK (status IN ('pending', 'claimed', 'done', 'dead_letter')),
	CONSTRAINT jobs_org_enqueue_key_unique UNIQUE (organization_id, enqueue_uuid_key)
);

-- Claim hot path: oldest claimable job first, only over pending rows.
CREATE INDEX IF NOT EXISTS jobs_claimable_idx
	ON jobs (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_lease_expiry_idx
	ON jobs (lease_expires_at) WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS jobs_task_idx ON jobs (task_id);
