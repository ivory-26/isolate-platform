-- Task execution context (wave 6).
--
-- The worker's `loadTaskContext` needs the task's authored goal, acceptance
-- criteria and ownership boundary. They were previously only known at submit
-- time and never persisted, so a real agent could not be told what "done"
-- means. They live on the task row, alongside the pinned branch and budget,
-- so one tenant-scoped read produces the whole TaskContext.
--
-- Existing rows keep safe defaults (empty goal/arrays): the migration does not
-- invent work that was never submitted.
--
-- NOTE: `scripts/apply-migration.ts` splits on line-ending semicolons, so the
-- DO block below is intentionally a single line (one statement).

ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS goal text NOT NULL DEFAULT '';

ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE tasks
	ADD COLUMN IF NOT EXISTS file_ownership jsonb NOT NULL DEFAULT '[]'::jsonb;

-- JSON must be an array, never a JSON string scalar (the driver double-encoding
-- class fixed in W4-DB). Idempotent constraint creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_acceptance_criteria_array_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_acceptance_criteria_array_check CHECK (jsonb_typeof(acceptance_criteria) = 'array'); END IF; IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_file_ownership_array_check') THEN ALTER TABLE tasks ADD CONSTRAINT tasks_file_ownership_array_check CHECK (jsonb_typeof(file_ownership) = 'array'); END IF; END $$;
