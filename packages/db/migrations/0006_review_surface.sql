-- Review surface (wave 8).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0005;
-- migration application belongs to the coordinator, never to repositories.
--
-- The wave adds the repository validation policy, the pull-request record, the
-- rerun linkage (`retry_of` / `retry_depth`, bounded to depth 3) and the
-- `create_pull_request` job type. A rerun is a NEW task row in the same
-- boundary; `failed` stays terminal, so no state constant changes here.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block below is intentionally a single line (one statement).

-- ---------------------------------------------------------------------------
-- Repository validation policy ----------------------------------------------
-- ---------------------------------------------------------------------------

-- NULL means "no validation gate configured": the worker then keeps the wave-7
-- meaning of review_ready and emits `validation.finished` with `skipped`.
ALTER TABLE repositories
	ADD COLUMN IF NOT EXISTS validation_command text;

-- 512 characters mirrors the authored `validationReport.command` bound.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_validation_command_length_check') THEN ALTER TABLE repositories ADD CONSTRAINT repositories_validation_command_length_check CHECK (validation_command IS NULL OR char_length(validation_command) <= 512); END IF; END $$;

-- 5 minutes by default; the range covers a 1 s probe to a 15 min suite.
ALTER TABLE repositories
	ADD COLUMN IF NOT EXISTS validation_timeout_ms integer NOT NULL DEFAULT 300000;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_validation_timeout_ms_range_check') THEN ALTER TABLE repositories ADD CONSTRAINT repositories_validation_timeout_ms_range_check CHECK (validation_timeout_ms BETWEEN 1000 AND 900000); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Pull-request record --------------------------------------------------------
-- ---------------------------------------------------------------------------

-- Persisted only after GitHub (or the fake) returns the opened pull request.
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS pull_request_number integer;

ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS pull_request_url text;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_pull_request_url_length_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_pull_request_url_length_check CHECK (pull_request_url IS NULL OR char_length(pull_request_url) <= 512); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Rerun linkage --------------------------------------------------------------
-- ---------------------------------------------------------------------------

-- A retry points at the failed task it reproduces. The self-reference is a
-- plain FK; a task row is never deleted while a retry references it.
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS retry_of uuid REFERENCES tasks (id);

-- 0 for a first submission; a retry stores source.retry_depth + 1. The CHECK
-- is the hard stop behind the repository's policy refusal (depth > 3).
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS retry_depth integer NOT NULL DEFAULT 0;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_retry_depth_range_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_retry_depth_range_check CHECK (retry_depth BETWEEN 0 AND 3); END IF; END $$;

CREATE INDEX IF NOT EXISTS tasks_retry_of_idx
	ON tasks (retry_of);

-- ---------------------------------------------------------------------------
-- Pull-request job -----------------------------------------------------------
-- ---------------------------------------------------------------------------

-- The PR stage is a second, human-approved step after review_ready. The
-- constraint is replaced, not widened in place, because PostgreSQL has no
-- ALTER CONSTRAINT for CHECK expressions.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_type_check') THEN ALTER TABLE jobs DROP CONSTRAINT jobs_type_check; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_type_check') THEN ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('run_task', 'validate_attempt', 'finalize_review', 'resume_task', 'create_pull_request')); END IF; END $$;
