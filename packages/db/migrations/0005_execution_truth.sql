-- Execution truth (wave 7).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0004;
-- migration application belongs to the coordinator, never to repositories.
--
-- The wave closes five execution gaps: bounded inline artifact content,
-- repository onboarding uniqueness, monotonic attempt allocation, one pending
-- approval per task/action, and an organization-scoped task list.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block below is intentionally a single line (one statement).

-- ---------------------------------------------------------------------------
-- Bounded inline artifacts ---------------------------------------------------
-- ---------------------------------------------------------------------------

ALTER TABLE artifacts
	ADD COLUMN IF NOT EXISTS content text;

-- 256 KiB measured in BYTES (octet_length), not characters: a multi-byte diff
-- must not slip past a character-count cap. NULL keeps metadata-only rows.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'artifacts_content_bytes_check') THEN ALTER TABLE artifacts ADD CONSTRAINT artifacts_content_bytes_check CHECK (content IS NULL OR octet_length(content) <= 262144); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Repository onboarding ------------------------------------------------------
-- ---------------------------------------------------------------------------

-- 0001 declares the same unique constraint on fresh databases; IF NOT EXISTS
-- keeps this statement idempotent on databases created before that constraint
-- existed (and is a no-op when the constraint-backed index is already present).
CREATE UNIQUE INDEX IF NOT EXISTS repositories_org_full_name_unique
	ON repositories (organization_id, external_full_name);

-- ---------------------------------------------------------------------------
-- Attempt allocation ---------------------------------------------------------
-- ---------------------------------------------------------------------------

-- TaskAttemptRepository.begin() allocates MAX(attempt_index)+1 per task; the
-- unique index turns a concurrent allocation race into a single retry instead
-- of a duplicate index. (0001 names the equivalent constraint
-- task_attempts_task_index_unique; this is the wave-7 named contract index.)
CREATE UNIQUE INDEX IF NOT EXISTS task_attempts_task_attempt_unique
	ON task_attempts (task_id, attempt_index);

-- ---------------------------------------------------------------------------
-- Approval idempotency -------------------------------------------------------
-- ---------------------------------------------------------------------------

-- At most one PENDING approval per task/action. A duplicate request is
-- idempotent success in PostgresExecutionLifecycle.approvalRequested; a
-- decided/rejected/expired row never blocks a later request.
-- Coordinator: resolve any pre-existing duplicate pending rows before applying.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_pending_task_action_unique
	ON approvals (task_id, action) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Organization task list -----------------------------------------------------
-- ---------------------------------------------------------------------------

-- No equivalent index exists today (tasks_status_created_idx leads with status,
-- so it cannot serve "tasks of org X, newest first").
CREATE INDEX IF NOT EXISTS tasks_org_created_idx
	ON tasks (organization_id, created_at DESC);
