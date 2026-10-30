-- Acceptance contract (wave 9).
--
-- Idempotent, additive SQL for PostgreSQL >= 13. Apply only after 0001-0006;
-- migration application belongs to the coordinator, never to repositories.
--
-- Machine-checkable acceptance criteria live beside the authored
-- `acceptance_criteria` prose. `acceptance_checks` is a bounded jsonb ARRAY
-- (at most 32 checks); the worker re-validates every entry before executing
-- it. The CHECK is the hard stop behind the repository's zod boundary, and
-- `jsonb_typeof(...) = 'array'` catches double-encoded writes (a jsonb string
-- scalar) the same way 0002's compiled-plan CHECK does.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so each
-- DO block below is intentionally a single line (one statement).

-- ---------------------------------------------------------------------------
-- Machine-checkable acceptance checks ----------------------------------------
-- ---------------------------------------------------------------------------

-- Empty for every row created before wave 9 and for tasks without checks.
ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS acceptance_checks jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 32 mirrors `MAX_ACCEPTANCE_CHECKS` in the task repository, which rejects a
-- longer list before the INSERT is attempted.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_acceptance_checks_array_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_acceptance_checks_array_check CHECK (jsonb_typeof(acceptance_checks) = 'array' AND jsonb_array_length(acceptance_checks) <= 32); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Branch writer lease (row lock, transaction-pool safe) ----------------------
-- ---------------------------------------------------------------------------
-- One lease row per (organization, repository, branch). The worker takes the
-- lease in ONE INSERT ... ON CONFLICT statement and releases it in ONE
-- owner-guarded DELETE, so no session state exists for PgBouncer transaction
-- pooling to split across backends (unlike pg_try_advisory_lock). A row whose
-- `expires_at` has elapsed is taken over atomically by the next acquire. The
-- primary key is the natural lock identity; the branch bound matches
-- `MAX_BRANCH_LOCK_BRANCH_LENGTH` in the repository.

CREATE TABLE IF NOT EXISTS branch_locks (
	organization_id uuid NOT NULL,
	repository_id uuid NOT NULL,
	branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
	owner_id text NOT NULL,
	expires_at timestamptz NOT NULL,
	acquired_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, repository_id, branch)
);

-- Supports expiry sweeps and future operator queries for live leases.
CREATE INDEX IF NOT EXISTS branch_locks_expires_at_idx ON branch_locks (expires_at);
